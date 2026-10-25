import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  userMemoryEntrySchema,
  userMemoryListResponseSchema,
} from "@open-inspect/shared/types/user-memory";
import { SessionIndexStore } from "../db/session-index";
import { seedUsers } from "../memory/test-helpers";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import {
  authorizationDatabase,
  createTestRequestHandler,
  fakeSessionRuntimeDispatch,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { userMemoryRoutes } from "./memory";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/d1/migrations"
);

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([userMemoryRoutes]);

const ALICE = "alice";
const BOB = "bob";
const ALICE_SESSION = "session-alice";
const BOB_SESSION = "session-bob";
const SANDBOX_TOKENS: Record<string, string> = {
  [ALICE_SESSION]: "alice-sandbox-token",
  [BOB_SESSION]: "bob-sandbox-token",
};

describe("user memory routes", () => {
  let dir: string;
  let db: NodeSqlDatabase;
  let broadcasts: Array<{ sessionId: string; message: Record<string, unknown> }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "user-memory-routes-"));
    db = openNodeSqlDatabase(join(dir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    await seedUsers(db, [ALICE, BOB]);
    const sessions = new SessionIndexStore(db);
    for (const [id, userId] of [
      [ALICE_SESSION, ALICE],
      [BOB_SESSION, BOB],
    ] as const) {
      await sessions.create({
        id,
        title: null,
        repoOwner: null,
        repoName: null,
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        ownerTeamId: null,
        visibility: "private",
        userId,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    broadcasts = [];
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function env(userId: string): Env {
    return {
      ...TEST_SERVICE_SECRETS,
      DB: authorizationDatabase({
        userId,
        statement: (sql) => db.prepare(sql),
        batch: (statements) => db.batch(statements),
      }),
      SESSION: fakeSessionRuntimeDispatch(async (request, sessionId) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.verifySandboxToken) {
          const { token } = (await request.json()) as { token: string };
          return token === SANDBOX_TOKENS[sessionId]
            ? Response.json({ valid: true, sandboxId: `sandbox-${sessionId}` })
            : Response.json({ error: "invalid" }, { status: 401 });
        }
        if (path === SessionInternalPaths.userMemoryEvent) {
          broadcasts.push({
            sessionId,
            message: (await request.json()) as Record<string, unknown>,
          });
          return Response.json({ ok: true });
        }
        return new Response("unexpected", { status: 500 });
      }),
    } as unknown as Env;
  }

  /** A request from a signed-in person, or from a session's sandbox. */
  async function call(
    as: { user: string } | { sandbox: string; token?: string },
    path: string,
    options: { method?: string; body?: unknown } = {}
  ) {
    const tasks = createTestBackgroundTasks();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if ("user" in as) {
      mocks.authenticate.mockImplementation(async (request: Request) => ({
        principal: { kind: "user", userId: as.user },
        request,
      }));
    } else {
      headers.Authorization = `Bearer ${as.token ?? SANDBOX_TOKENS[as.sandbox]}`;
    }
    const response = await handleRequest(
      new Request(`https://cp.test${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      env("user" in as ? as.user : ALICE),
      tasks
    );
    await tasks.settle();
    return response;
  }

  it("keeps each user's memory to themselves", async () => {
    const created = await call({ user: ALICE }, "/memory/entries", {
      method: "POST",
      body: { key: "pref.voice", content: "Male voice" },
    });
    expect(created.status).toBe(201);
    const { entry } = (await created.json()) as { entry: { id: string; source: string } };
    expect(entry.source).toBe("user_edit");

    const bobList = await call({ user: BOB }, "/memory");
    expect(bobList.headers.get("cache-control")).toBe("private, no-store");
    expect(await bobList.json()).toMatchObject({ entries: [], paused: false });
    for (const [method, path, body] of [
      ["PATCH", `/memory/entries/${entry.id}`, { locked: true }],
      ["DELETE", `/memory/entries/${entry.id}`, undefined],
      ["POST", `/memory/entries/${entry.id}/approve`, undefined],
      ["POST", `/memory/entries/${entry.id}/decline`, undefined],
    ] as const) {
      expect((await call({ user: BOB }, path, { method, body })).status, `${method} ${path}`).toBe(
        404
      );
    }
    expect(
      await (
        await call({ user: BOB }, "/memory/forget", {
          method: "POST",
          body: { ids: [entry.id] },
        })
      ).json()
    ).toEqual({ count: 0 });
    expect(await (await call({ user: BOB }, "/memory/clear", { method: "POST" })).json()).toEqual({
      count: 0,
    });

    const aliceList = (await (await call({ user: ALICE }, "/memory")).json()) as {
      entries: unknown[];
    };
    expect(aliceList.entries).toHaveLength(1);
  });

  it("serves the memory page: edit, lock, approve, undo, preview, export, pause", async () => {
    const add = await call({ user: ALICE }, "/memory/entries", {
      method: "POST",
      body: { key: "lesson.closeups", content: "Close-ups of the cup sell" },
    });
    const { entry } = (await add.json()) as { entry: { id: string } };
    const edited = await call({ user: ALICE }, `/memory/entries/${entry.id}`, {
      method: "PATCH",
      body: { content: "Close-ups of the cup sell best", locked: true },
    });
    expect(await edited.json()).toMatchObject({
      entry: { content: "Close-ups of the cup sell best", locked: true, version: 2 },
    });
    expect(
      (
        await call({ user: ALICE }, "/memory/entries", {
          method: "POST",
          body: { key: "pref.x", content: "line one\nline two" },
        })
      ).status
    ).toBe(400);
    expect(
      (await call({ user: ALICE }, "/memory/entries/not%20an%20id", { method: "DELETE" })).status
    ).toBe(404);

    const preview = await call({ user: ALICE }, "/memory/forget-preview", {
      method: "POST",
      body: { query: "cup" },
    });
    expect(await preview.json()).toMatchObject({ candidates: [{ key: "lesson.closeups" }] });

    const exported = (await (await call({ user: ALICE }, "/memory/export")).json()) as {
      entries: unknown[];
    };
    expect(exported.entries).toHaveLength(2);

    expect(
      await (
        await call({ user: ALICE }, "/memory/settings", {
          method: "PUT",
          body: { paused: true },
        })
      ).json()
    ).toEqual({ paused: true });
    expect(await (await call({ user: ALICE }, "/memory")).json()).toMatchObject({
      paused: true,
    });
  });

  it("answers the web app's shapes: empty JSON bodies, encoded batch ids, schema-valid entries", async () => {
    const write = async () => {
      const response = await call(
        { sandbox: ALICE_SESSION },
        `/sessions/${ALICE_SESSION}/memory/ops`,
        {
          method: "POST",
          body: {
            ops: [
              { op: "set", key: "pref.cuts", content: "Fast cuts", inference: true },
              { op: "set", key: "lesson.light", content: "Bright, natural light", inference: true },
              { op: "set", key: "recent.summary", content: "Only the summary job writes this" },
            ],
          },
        }
      );
      return (await response.json()) as {
        batchId: string;
        results: Array<{ outcome: string; entry?: { id: string } }>;
      };
    };
    const page = async () =>
      userMemoryListResponseSchema.parse(await (await call({ user: ALICE }, "/memory")).json());

    const first = await write();
    expect(first.results.map((result) => result.outcome)).toEqual([
      "applied",
      "applied",
      "invalid",
    ]);
    const entries = (await page()).entries;
    for (const entry of entries) expect(userMemoryEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries.map((entry) => `${entry.key}:${entry.status}`).sort()).toEqual([
      "lesson.light:pending",
      "pref.cuts:pending",
    ]);

    // An extraction's batch id has a colon; the web app sends it URL-encoded.
    const undo = await call(
      { user: ALICE },
      `/memory/batches/${encodeURIComponent(first.batchId)}/undo`,
      { method: "POST", body: {} }
    );
    expect(await undo.json()).toEqual({ count: 2 });
    expect((await page()).entries).toEqual([]);
    expect(
      (
        await call({ user: ALICE }, `/memory/batches/${encodeURIComponent("extract:m-1")}/undo`, {
          method: "POST",
          body: {},
        })
      ).status
    ).toBe(404);

    const second = await write();
    const approve = await call(
      { user: ALICE },
      `/memory/entries/${second.results[1]!.entry!.id}/approve`,
      { method: "POST", body: {} }
    );
    expect(approve.status).toBe(200);
    expect((await page()).entries).toContainEqual(
      expect.objectContaining({ key: "lesson.light", status: "active" })
    );
    const decline = await call(
      { user: ALICE },
      `/memory/entries/${second.results[0]!.entry!.id}/decline`,
      { method: "POST", body: {} }
    );
    expect(decline.status).toBe(200);
    expect(
      await (await call({ user: ALICE }, "/memory/clear", { method: "POST", body: {} })).json()
    ).toEqual({ count: 1 });
  });

  it("acts for the session's owner in the sandbox and tells the session what changed", async () => {
    const ops = await call({ sandbox: ALICE_SESSION }, `/sessions/${ALICE_SESSION}/memory/ops`, {
      method: "POST",
      body: {
        ops: [
          { op: "set", key: "pref.voice", content: "Male voice", said: true },
          { op: "set", key: "pref.cuts", content: "Fast cuts", inference: true },
          { op: "forget", key: "pref.none" },
        ],
      },
    });
    expect(ops.status).toBe(200);
    const body = (await ops.json()) as { batchId: string; results: Array<{ outcome: string }> };
    expect(body.results.map((result) => result.outcome)).toEqual(["applied", "applied", "missing"]);
    expect(broadcasts).toEqual([
      {
        sessionId: ALICE_SESSION,
        message: {
          type: "memory_updated",
          batchId: body.batchId,
          source: "agent",
          changes: [
            {
              op: "set",
              key: "pref.voice",
              layer: "preference",
              content: "Male voice",
              status: "active",
            },
            {
              op: "set",
              key: "pref.cuts",
              layer: "preference",
              content: "Fast cuts",
              status: "pending",
            },
          ],
        },
      },
    ]);

    // The memory written is Alice's: her page shows it, Bob's does not.
    const alice = (await (await call({ user: ALICE }, "/memory")).json()) as {
      entries: Array<{ key: string; sessionId: string }>;
    };
    expect(alice.entries.map((entry) => entry.key).sort()).toEqual(["pref.cuts", "pref.voice"]);
    expect(alice.entries[0]!.sessionId).toBe(ALICE_SESSION);
    expect(await (await call({ user: BOB }, "/memory")).json()).toMatchObject({ entries: [] });

    const context = await call(
      { sandbox: ALICE_SESSION },
      `/sessions/${ALICE_SESSION}/memory/context`
    );
    const loaded = (await context.json()) as { text: string; counts: Record<string, unknown> };
    expect(loaded.text).toContain("- pref.voice: Male voice");
    expect(loaded.text).toContain("- pref.cuts: Fast cuts");
    expect(broadcasts.at(-1)).toEqual({
      sessionId: ALICE_SESSION,
      message: { type: "memory_loaded", counts: loaded.counts, paused: false },
    });

    const search = await call(
      { sandbox: ALICE_SESSION },
      `/sessions/${ALICE_SESSION}/memory/search?q=voice&limit=50`
    );
    expect(await search.json()).toMatchObject({ results: [{ key: "pref.voice" }] });
    const excluded = await call(
      { sandbox: ALICE_SESSION },
      `/sessions/${ALICE_SESSION}/memory/search?q=voice&exclude=${alice.entries
        .map((entry) => (entry as unknown as { id: string }).id)
        .join(",")}`
    );
    expect(await excluded.json()).toEqual({ results: [] });

    const list = await call({ sandbox: BOB_SESSION }, `/sessions/${BOB_SESSION}/memory`);
    expect(await list.json()).toMatchObject({ entries: [], paused: false });
  });

  it("refuses a sandbox token for another session, and people on sandbox routes", async () => {
    expect(
      (
        await call(
          { sandbox: ALICE_SESSION, token: SANDBOX_TOKENS[BOB_SESSION] },
          `/sessions/${ALICE_SESSION}/memory`
        )
      ).status
    ).toBe(401);
    expect((await call({ user: ALICE }, `/sessions/${ALICE_SESSION}/memory`)).status).toBe(401);
    expect(
      (
        await call({ sandbox: ALICE_SESSION }, `/sessions/${ALICE_SESSION}/memory/ops`, {
          method: "POST",
          body: { ops: [] },
        })
      ).status
    ).toBe(400);
  });

  it("answers 404 for a sandbox session without an owner", async () => {
    SANDBOX_TOKENS["session-orphan"] = "orphan-token";
    const response = await call({ sandbox: "session-orphan" }, "/sessions/session-orphan/memory");
    expect(response.status).toBe(404);
  });
});
