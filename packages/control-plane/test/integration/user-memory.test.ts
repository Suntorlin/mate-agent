import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSessionDO,
  openClientWs,
  routeRequest,
  seedSandboxAuthHash,
  serviceRequestHeaders,
} from "./helpers";

const BASE = "https://test.local";
// Two users who signed in separately.
const ALICE = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
const BOB = "b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4";
const ALICE_SANDBOX_TOKEN = "user-memory-alice-sandbox-token";
const BOB_SANDBOX_TOKEN = "user-memory-bob-sandbox-token";

async function call(
  as: string | { sandboxToken: string },
  path: string,
  options: { method?: string; body?: unknown } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers =
    typeof as === "string"
      ? await serviceRequestHeaders(url, { method, body, as: { userId: as, role: "member" } })
      : {
          Authorization: `Bearer ${as.sandboxToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        };
  return routeRequest(
    new Request(url, { method, headers, body }),
    { ...env, TEAMS_ENFORCEMENT: "on", DEFAULT_SESSION_VISIBILITY: "private" } as typeof env,
    createExecutionContext()
  );
}

async function createSession(userId: string, sandboxToken: string): Promise<string> {
  const response = await call(userId, "/sessions", {
    method: "POST",
    body: { title: "Cut", model: "anthropic/claude-haiku-4-5" },
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await seedSandboxAuthHash(stub, { authToken: sandboxToken, sandboxId: `sandbox-${userId}` });
  return sessionId;
}

describe("user memory", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [ALICE, BOB]) {
      expect((await call(userId, "/me/authorization")).status).toBe(200);
    }
  });

  it("writes through a session's sandbox into its owner's memory, and nobody else's", async () => {
    const alice = await createSession(ALICE, ALICE_SANDBOX_TOKEN);
    const bob = await createSession(BOB, BOB_SANDBOX_TOKEN);
    const aliceSandbox = { sandboxToken: ALICE_SANDBOX_TOKEN };

    const ops = await call(aliceSandbox, `/sessions/${alice}/memory/ops`, {
      method: "POST",
      body: {
        ops: [
          { op: "set", key: "pref.voice", content: "优先男声", said: true },
          {
            op: "set",
            key: "lesson.closeups",
            content: "Product close-ups beat wide shots",
            inference: true,
          },
        ],
      },
    });
    expect(ops.status).toBe(200);
    expect(await ops.json()).toMatchObject({
      results: [
        { outcome: "applied", entry: { status: "active", source: "user_said" } },
        { outcome: "applied", entry: { status: "pending", layer: "lesson" } },
      ],
    });

    // Bob's token does not open Alice's session, and Bob's memory is empty.
    expect(
      (await call({ sandboxToken: BOB_SANDBOX_TOKEN }, `/sessions/${alice}/memory`)).status
    ).toBe(401);
    expect(
      await (await call({ sandboxToken: BOB_SANDBOX_TOKEN }, `/sessions/${bob}/memory`)).json()
    ).toMatchObject({ entries: [] });
    expect(await (await call(BOB, "/memory")).json()).toMatchObject({ entries: [] });

    // Only Alice approves the agent's suggestion.
    const page = await (
      await call(ALICE, "/memory")
    ).json<{
      entries: Array<{ id: string; key: string }>;
    }>();
    const suggestion = page.entries.find((entry) => entry.key === "lesson.closeups")!;
    expect(
      (await call(BOB, `/memory/entries/${suggestion.id}/approve`, { method: "POST" })).status
    ).toBe(404);
    expect(
      (await call(ALICE, `/memory/entries/${suggestion.id}/approve`, { method: "POST" })).status
    ).toBe(200);

    const context = await (
      await call(aliceSandbox, `/sessions/${alice}/memory/context`)
    ).json<{ text: string; counts: { preferences: number; lessons: number; pending: number } }>();
    expect(context.text).toContain("- pref.voice: 优先男声");
    expect(context.text).toContain("- lesson.closeups: Product close-ups beat wide shots");
    expect(context.counts).toMatchObject({ preferences: 1, lessons: 1, pending: 0 });
  });

  it("broadcasts a memory message it is handed to the session's viewers", async () => {
    const name = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await initNamedSessionDO(name, { repoOwner: "acme", repoName: "web-app" });
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: name,
      ownerTeamId: null,
      visibility: "workspace",
      title: "Memory",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    const { ws } = await openClientWs(name, { subscribe: true });
    const collector = collectMessages(ws, {
      until: (message) => message.type === "memory_loaded",
      timeoutMs: 2000,
    });
    const stub = env.SESSION.get(env.SESSION.idFromName(name));
    const send = (body: unknown) =>
      stub.fetch("http://internal/internal/user-memory-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const loaded = {
      type: "memory_loaded",
      paused: false,
      counts: { profile: 0, recent: false, preferences: 2, lessons: 0, projects: 1, pending: 0 },
    };
    expect((await send({ type: "child_session_update" })).status).toBe(400);
    expect((await send(loaded)).status).toBe(200);

    const messages = await collector;
    expect(messages.find((message) => message.type === "memory_loaded")).toEqual(loaded);
    ws.close();
  });
});
