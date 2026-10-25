import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserStore } from "../db/user-store";
import type { SqlDatabase } from "../db/sql-database";
import {
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SESSION_ROW,
  fakeSessionRuntimeDispatch,
} from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { handleAnswerQuestion } from "./session-questions";
import { withSessionRuntime } from "./session-route";
import type { RequestContext } from "./shared";

vi.mock("../db/user-store", () => ({ UserStore: vi.fn() }));
vi.mock("../source-control/github-credential-authority", () => ({
  resolveGitHubCredentialAuthority: vi.fn(async () => ({ kind: "none" })),
}));
vi.mock("../session/identity", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveGitHubEnrichmentForRequest: vi.fn(async () => null),
}));

const OWNER = "user-app-1";
const PARAMS = { id: "session-1", questionId: "q_1" };

function sessionDatabase(ownerUserId: string | null): SqlDatabase {
  const statement = {
    bind: () => statement,
    first: async () => ({ ...TEST_SESSION_ROW, user_id: ownerUserId, visibility: "private" }),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  };
  return { prepare: () => statement, batch: async () => [] } as unknown as SqlDatabase;
}

/** the product relaying the product user `uid-42`, whose canonical user is `canonicalUserId`. */
function platformWebContext(db: SqlDatabase, canonicalUserId = OWNER): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: {
      kind: "service",
      service: "app",
      actor: {
        provider: "app",
        providerUserId: "uid-42",
        canonicalUserId,
        participantUserId: "app:uid-42",
      },
    },
    authorization: {
      userId: canonicalUserId,
      suspendedAt: null,
      role: { id: "role-1", key: "member", name: "Member" },
      permissions: ["sessions.read", "sessions.collaborate"],
    },
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  } as RequestContext;
}

async function answer(
  body: unknown,
  options: {
    owner?: string | null;
    actor?: string;
    runtime?: (request: Request) => Promise<Response>;
  } = {}
) {
  const forwarded: Request[] = [];
  const runtime = vi.fn(async (request: Request) => {
    forwarded.push(request);
    return options.runtime
      ? options.runtime(request)
      : Response.json({ questionId: "q_1", messageId: "msg-2", status: "queued" });
  });
  const env = { SESSION: fakeSessionRuntimeDispatch(runtime) } as unknown as Env;
  const ctx = platformWebContext(
    sessionDatabase(options.owner === undefined ? OWNER : options.owner),
    options.actor
  );
  const response = await handleAnswerQuestion(
    new Request("https://test.local/sessions/session-1/questions/q_1/answer", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    PARAMS,
    withSessionRuntime(env, ctx) as never
  );
  return { response, forwarded };
}

describe("POST /sessions/:id/questions/:questionId/answer", () => {
  beforeEach(() => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => ({ userId: OWNER }),
        getUserById: async () => ({ id: OWNER }),
      } as never;
    });
  });

  it("queues the owner's answer, through the product, as the owner's prompt", async () => {
    const { response, forwarded } = await answer({ action: "submit", value: "keep" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      questionId: "q_1",
      messageId: "msg-2",
      status: "queued",
    });
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0].url).pathname).toBe(SessionInternalPaths.questionAnswer);
    await expect(forwarded[0].json()).resolves.toEqual({
      questionId: "q_1",
      answer: { action: "submit", value: "keep" },
      author: { authorId: "app:uid-42", canonicalUserId: OWNER },
    });
  });

  it("refuses anyone but the session's owner", async () => {
    const { response, forwarded } = await answer(
      { action: "dismiss" },
      { actor: "user-someone-else" }
    );

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a session without an owner", async () => {
    const { response, forwarded } = await answer({ action: "dismiss" }, { owner: null });

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    ["an unknown action", { action: "skip" }],
    ["a secondary press without its value", { action: "secondary" }],
    ["a non-JSON body", "not json"],
  ])("rejects %s with 400", async (_name, body) => {
    const { response, forwarded } = await answer(body);

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses an author named in the body", async () => {
    const { response, forwarded } = await answer({ action: "dismiss", authorId: "someone" });

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    [404, { error: "Question not found" }],
    [409, { error: "This question was already answered", code: "QUESTION_ALREADY_ANSWERED" }],
  ])("passes the session's %s through", async (status, body) => {
    const { response } = await answer(
      { action: "dismiss" },
      { runtime: async () => Response.json(body, { status }) }
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
  });
});
