import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { MySkill } from "@open-inspect/shared/types/skills";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { SessionIndexStore } from "../../src/db/session-index";
import type { LargeObjectTransfers, UploadedPart } from "../../src/storage/large-object-transfers";
import { cleanD1Tables } from "./cleanup";
import { queryDO, routeRequest, serviceRequestHeaders } from "./helpers";

const BASE = "https://test.local";
// Two users signed in to the product; its backend (the app service) relays each as the actor.
const ALICE = "app:uid-alice";
const BOB = "app:uid-bob";

const CLIP_BYTES = 4096;

/** The store side of a multipart upload, with every file's one part already received. */
class FakeTransfers implements LargeObjectTransfers {
  sandboxDirect = false;
  private next = 0;

  async createMultipartUpload(): Promise<string> {
    return `upload-${++this.next}`;
  }
  async signUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `https://store.test/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  async uploadPart(): Promise<void> {}
  async listParts(): Promise<UploadedPart[]> {
    return [{ partNumber: 1, sizeBytes: CLIP_BYTES, etag: "e" }];
  }
  async completeMultipartUpload(key: string): Promise<void> {
    await env.MEDIA_BUCKET.put(key, new Uint8Array(CLIP_BYTES));
  }
  async abortMultipartUpload(): Promise<void> {}
  async signDownload(key: string): Promise<string> {
    return `https://store.test/${key}`;
  }
}

interface Caller {
  service: ServiceName;
  actor?: string;
}

/** A request signed the way the app service signs it: sig1 plus the asserted actor. */
async function call(
  caller: string | Caller,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const identity: Caller = typeof caller === "string" ? { service: "app", actor: caller } : caller;
  const headers = await serviceRequestHeaders(url, { method, body, ...identity });
  return routeRequest(
    new Request(url, { method, headers, body }),
    {
      ...env,
      TEAMS_ENFORCEMENT: "on",
      DEFAULT_SESSION_VISIBILITY: "private",
      MEDIA_TRANSFERS: new FakeTransfers(),
    } as typeof env,
    createExecutionContext()
  );
}

async function createSession(actor: string): Promise<string> {
  const response = await call(actor, "/sessions", {
    method: "POST",
    body: { title: "Cut", model: "anthropic/claude-haiku-4-5" },
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  await answerFirstPrompt(sessionId);
  return sessionId;
}

/**
 * Lists show a session from its first prompt on: one the app created and never
 * prompted is a warm draft behind the composer. Stand in for a first prompt the agent
 * answered, in the session itself and in the index the lists read.
 */
async function answerFirstPrompt(sessionId: string): Promise<void> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const [{ id: participantId }] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants LIMIT 1"
  );
  await queryDO(
    stub,
    `INSERT INTO messages (id, author_id, content, source, status, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    `first-${sessionId}`,
    participantId,
    "Cut it",
    "web",
    "completed",
    100,
    110,
    200
  );
  await queryDO(stub, "UPDATE session SET status = 'completed'");
  await env.DB.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?")
    .bind(sessionId)
    .run();
}

async function createUpload(actor: string, scope: "library" | "input"): Promise<string> {
  const response = await call(actor, "/files/uploads", {
    method: "POST",
    body: { name: "clip.mov", sizeBytes: CLIP_BYTES, scope },
  });
  expect(response.status).toBe(201);
  const fileId = (await response.json<{ file: { id: string } }>()).file.id;
  if (scope === "input") {
    const completed = await call(actor, `/files/${fileId}/upload/complete`, {
      method: "POST",
    });
    expect(completed.status).toBe(200);
  }
  return fileId;
}

const SKILL =
  "---\nname: cafe-ad\ndescription: Make a 15-second cafe ad. Use for cafes.\n---\n\n# cafe-ad\n";

describe("the app service acting for an app user", () => {
  beforeEach(cleanD1Tables);

  it("reaches that user's own skills, and nobody else's", async () => {
    const saved = await call(ALICE, "/my-skills", {
      method: "POST",
      body: { files: [{ path: "SKILL.md", content: SKILL }], replace: false },
    });
    expect(saved.status).toBe(201);
    const { skill } = await saved.json<{ skill: MySkill }>();
    const own = async (actor: string) =>
      (await (await call(actor, "/my-skills")).json<{ skills: MySkill[] }>()).skills.filter(
        (item) => item.kind === "own"
      );

    expect((await own(ALICE)).map((item) => item.key)).toEqual([skill.key]);
    expect(await own(BOB)).toEqual([]);
    expect((await call(BOB, `/my-skills/${skill.key}`)).status).toBe(404);
    expect(
      (await call(BOB, `/my-skills/${skill.key}`, { method: "PATCH", body: { enabled: false } }))
        .status
    ).toBe(404);
    expect((await call(BOB, `/my-skills/${skill.key}`, { method: "DELETE" })).status).toBe(404);

    expect((await call(ALICE, `/my-skills/${skill.key}`)).status).toBe(200);
    expect((await own(ALICE))[0]).toMatchObject({ key: skill.key, enabled: true });
    expect((await call(ALICE, `/my-skills/${skill.key}`, { method: "DELETE" })).status).toBe(200);
  });

  it("reaches that user's own memory, and nobody else's", async () => {
    const created = await call(ALICE, "/memory/entries", {
      method: "POST",
      body: { key: "pref.voice", content: "Prefer a male voice" },
    });
    expect(created.status).toBeLessThan(300);
    const { entry } = await created.json<{ entry: { id: string } }>();
    const entries = async (actor: string) =>
      (await (await call(actor, "/memory")).json<{ entries: { id: string }[] }>()).entries;

    expect((await entries(ALICE)).map((item) => item.id)).toEqual([entry.id]);
    expect(await entries(BOB)).toEqual([]);
    expect(
      (
        await call(BOB, `/memory/entries/${entry.id}`, {
          method: "PATCH",
          body: { content: "Prefer a female voice" },
        })
      ).status
    ).toBe(404);
    expect((await call(BOB, `/memory/entries/${entry.id}`, { method: "DELETE" })).status).toBe(404);

    expect((await entries(ALICE)).map((item) => item.id)).toEqual([entry.id]);
    expect((await call(ALICE, `/memory/entries/${entry.id}`, { method: "DELETE" })).status).toBe(
      200
    );
  });

  it("reaches that user's own files, and nobody else's", async () => {
    const fileId = await createUpload(ALICE, "library");
    const parts = { method: "POST", body: { partNumbers: [1] } };

    expect((await call(BOB, `/files/${fileId}/upload/parts`, parts)).status).toBe(404);
    expect((await call(BOB, `/files/${fileId}/upload/complete`, { method: "POST" })).status).toBe(
      404
    );
    expect((await call(BOB, `/files/${fileId}`, { method: "DELETE" })).status).toBe(404);

    expect((await call(ALICE, `/files/${fileId}/upload/parts`, parts)).status).toBe(200);
    expect((await call(ALICE, `/files/${fileId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("reads, budgets and feeds that user's own sessions, and nobody else's", async () => {
    const session = await createSession(ALICE);
    const bobSession = await createSession(BOB);
    const aliceClip = await createUpload(ALICE, "input");
    const bobClip = await createUpload(BOB, "input");
    const budget = { method: "PATCH", body: { maxCostUsd: 2 } };
    const listed = async (actor: string) =>
      (await (await call(actor, "/sessions")).json<{ sessions: { id: string }[] }>()).sessions.map(
        (item) => item.id
      );

    expect((await call(BOB, `/sessions/${session}`)).status).toBe(404);
    expect((await call(BOB, `/sessions/${session}/budget`, budget)).status).toBe(404);
    expect((await call(BOB, `/sessions/${session}/artifacts`)).status).toBe(404);
    expect(
      (await call(BOB, `/sessions/${session}/ws-token`, { method: "POST", body: {} })).status
    ).toBe(404);
    expect(
      (
        await call(BOB, `/sessions/${session}/inputs`, {
          method: "POST",
          body: { fileIds: [bobClip] },
        })
      ).status
    ).toBe(404);
    // Bob's own session does not take Alice's file either.
    expect(
      (
        await call(BOB, `/sessions/${bobSession}/inputs`, {
          method: "POST",
          body: { fileIds: [aliceClip] },
        })
      ).status
    ).toBe(400);
    expect(await listed(BOB)).toEqual([bobSession]);

    const read = await call(ALICE, `/sessions/${session}`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ session: { id: session } });
    expect((await call(ALICE, `/sessions/${session}/budget`, budget)).status).toBe(200);
    expect((await call(ALICE, `/sessions/${session}/artifacts`)).status).toBe(200);
    expect(
      (await call(ALICE, `/sessions/${session}/ws-token`, { method: "POST", body: {} })).status
    ).toBe(200);
    expect(
      (
        await call(ALICE, `/sessions/${session}/inputs`, {
          method: "POST",
          body: { fileIds: [aliceClip] },
        })
      ).status
    ).toBe(200);
    expect(await listed(ALICE)).toEqual([session]);
  });

  it("archives that user's own session and undoes it, and nobody else may", async () => {
    const session = await createSession(ALICE);
    const bobSession = await createSession(BOB);
    // The history grid's two pages, as the app asks for them.
    const page = async (actor: string, scope: "unarchived" | "archived") => {
      const query =
        scope === "archived"
          ? "status=archived&limit=50&offset=0&createdBy=me"
          : "limit=50&offset=0&excludeStatus=archived&createdBy=me";
      const response = await call(actor, `/sessions?${query}`);
      expect(response.status).toBe(200);
      return (await response.json<{ sessions: { id: string }[] }>()).sessions.map(
        (item) => item.id
      );
    };
    const post = (actor: string, suffix: string) =>
      call(actor, `/sessions/${session}${suffix}`, { method: "POST", body: {} });

    expect((await post(BOB, "/archive")).status).toBe(404);
    expect(await page(ALICE, "unarchived")).toEqual([session]);

    const archived = await post(ALICE, "/archive");
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ status: "archived" });
    expect(await page(ALICE, "unarchived")).toEqual([]);
    expect(await page(ALICE, "archived")).toEqual([session]);

    // Bob cannot undo Alice's archive, and trying changes nothing.
    expect((await post(BOB, "/unarchive")).status).toBe(404);
    expect(await page(ALICE, "archived")).toEqual([session]);

    const restored = await post(ALICE, "/unarchive");
    expect(restored.status).toBe(200);
    // Restored to what its messages imply, not started again.
    await expect(restored.json()).resolves.toEqual({ status: "completed" });
    expect(await page(ALICE, "unarchived")).toEqual([session]);
    expect(await page(ALICE, "archived")).toEqual([]);
    expect(await page(BOB, "unarchived")).toEqual([bobSession]);

    // A second undo finds nothing to restore.
    expect((await post(ALICE, "/unarchive")).status).toBe(409);
  });

  it("lists that user's sessions with each one's cover and how much it has produced", async () => {
    const session = await createSession(ALICE);
    const empty = await createSession(ALICE);
    await createSession(BOB);
    await new SessionIndexStore(env.DB).updateMetrics(session, {
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 2,
      prCount: 0,
      cover: { artifactId: "artifact-first", type: "video" },
      mediaCount: 3,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const response = await call(ALICE, "/sessions");
    expect(response.status).toBe(200);
    const { sessions } = await response.json<{ sessions: { id: string }[] }>();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((item) => item.id === session)).toMatchObject({
      cover: { artifactId: "artifact-first", type: "video" },
      mediaCount: 3,
    });
    expect(sessions.find((item) => item.id === empty)).toMatchObject({
      cover: null,
      mediaCount: 0,
    });
  });

  it("gives a person's library to no service without that person, and to no other service", async () => {
    for (const path of ["/my-skills", "/memory", "/files"]) {
      const actorless = await call({ service: "app" }, path);
      expect(actorless.status).toBe(403);
      await expect(actorless.json()).resolves.toMatchObject({ code: "service_actor_required" });

      const bot = await call({ service: "slack-bot", actor: "slack:U0123" }, path);
      expect(bot.status).toBe(403);
      await expect(bot.json()).resolves.toMatchObject({ code: "service_capability_required" });
    }
  });
});
