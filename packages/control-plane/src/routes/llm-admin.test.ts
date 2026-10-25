import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type { SqlStatement } from "../db/sql-database";
import {
  authorizationDatabase,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { GATEWAY_ADMIN_TOKEN_TTL_SECONDS } from "../gateway/admin";
import { llmAdminRoutes } from "./llm-admin";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXED_NOW = 1_800_000_000_000;
const ADMIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREATOR = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([llmAdminRoutes]);

const USER_ROWS = [
  {
    id: CREATOR,
    display_name: "Mina",
    email: "mina@example.com",
    email_verified: 1,
    avatar_url: null,
    created_at: 1,
    updated_at: 1,
  },
  {
    id: ADMIN,
    display_name: "My Team",
    email: "0f3a@users.invalid",
    email_verified: 1,
    avatar_url: null,
    created_at: 1,
    updated_at: 1,
  },
];

function database(permissions?: string[]) {
  return authorizationDatabase({
    userId: ADMIN,
    ...(permissions ? { permissions: permissions as never } : {}),
    statement: (sql: string) => {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() => null as T | null,
        all: async <T>() => ({
          results: (sql.includes("FROM sessions")
            ? [{ id: "s1", title: "Ramen reel" }]
            : []) as T[],
          meta: { changes: 0 },
        }),
        run: async () => ({ results: [], meta: { changes: 0 } }),
      } as unknown as SqlStatement;
      return statement;
    },
    batch: async <T>(statements: SqlStatement[]) =>
      statements.map(() => ({ results: USER_ROWS as T[], meta: { changes: 0 } })),
  });
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    ...TEST_SERVICE_SECRETS,
    DB: database(),
    GATEWAY_URL: "https://gateway.example/",
    GATEWAY_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

const ROW = {
  sub: CREATOR,
  period: "2026-10",
  spent_usd: 4.5,
  requests: 12,
  budget_usd: 50,
  remaining_usd: 45.5,
  custom_budget: false,
  blocked: false,
  last_at: "2026-10-04T10:00:00.000Z",
  all_time: { usd: 9, requests: 30, input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  limit: null,
};

const OVERVIEW = {
  period: "2026-10",
  periods: ["2026-10"],
  period_type: "month",
  resets_at: "2026-11-01T00:00:00.000Z",
  default_user_budget_usd: 50,
  global: { budget_usd: 200, spent_usd: 70, remaining_usd: 130, since: "2026-10-01T03:32:21Z" },
  pending_requests: 0,
  users: [ROW, { ...ROW, sub: "ops-smoke", spent_usd: 0.01 }],
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("LLM admin routes", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal("fetch", fetchMock);
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: ADMIN },
      request,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function call(path: string, init: RequestInit = {}, env = envWith()) {
    return handleRequest(
      new Request(`https://test.local${path}`, init),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it("lists users with names and real emails, asking with an admin-scoped token", async () => {
    fetchMock.mockResolvedValue(Response.json(OVERVIEW));

    const response = await call("/admin/llm-usage?period=2026-10");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as Record<string, any>;
    expect(body.service).toEqual({
      budgetUsd: 200,
      spentUsd: 70,
      remainingUsd: 130,
      since: "2026-10-01T03:32:21Z",
    });
    expect(body.users).toEqual([
      expect.objectContaining({
        id: CREATOR,
        name: "Mina",
        email: "mina@example.com",
        inWorkspace: true,
        spentUsd: 4.5,
      }),
      expect.objectContaining({ id: "ops-smoke", name: null, email: null, inWorkspace: false }),
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gateway.example/llm/admin/overview?period=2026-10");
    const token = new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, "");
    const iat = Math.floor(FIXED_NOW / 1000);
    expect(decodePayload(token)).toEqual({
      sub: ADMIN,
      sid: "control-plane-admin",
      scope: "admin",
      iat,
      exp: iat + GATEWAY_ADMIN_TOKEN_TTL_SECONDS,
    });
  });

  it("shows one user's sessions with their titles, and hides placeholder emails", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...ROW,
        limit: { budget_usd: 80, updated_at: "2026-10-04T09:00:00Z", updated_by: ADMIN },
        custom_budget: true,
        sessions: [
          {
            sid: "s1",
            usd: 4.5,
            requests: 12,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            last_at: "2026-10-04T10:00:00.000Z",
          },
        ],
      })
    );

    const body = (await (await call(`/admin/llm-usage/users/${CREATOR}`)).json()) as Record<
      string,
      any
    >;

    expect(body.sessions).toEqual([
      {
        id: "s1",
        title: "Ramen reel",
        spentUsd: 4.5,
        requests: 12,
        lastActiveAt: "2026-10-04T10:00:00.000Z",
      },
    ]);
    expect(body.lastChange).toEqual({ at: "2026-10-04T09:00:00Z", by: "My Team" });
    expect(body.allTime).toEqual({ spentUsd: 9, requests: 30 });
  });

  it("sends a budget override and a block to the gateway", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...ROW, budget_usd: 80, custom_budget: true, blocked: true })
    );

    const response = await call(`/admin/llm-usage/users/${CREATOR}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetUsd: 80, blocked: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ budgetUsd: 80, blocked: true })
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://gateway.example/llm/admin/users/${CREATOR}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ budget_usd: 80, blocked: true });
  });

  it("rejects bad input without reaching the gateway", async () => {
    for (const body of [{}, { budgetUsd: -1 }, { blocked: "yes" }, { budgetUsd: 5, extra: 1 }]) {
      const response = await call(`/admin/llm-usage/users/${CREATOR}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("/admin/llm-usage?period=october")).status).toBe(400);
    expect((await call("/admin/llm-usage/users/a%20b")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is only for admins: members get 403 and never reach the gateway", async () => {
    const env = envWith({ DB: database([]) } as Partial<Env>);
    expect((await call("/admin/llm-usage", {}, env)).status).toBe(403);
    const patch = await call(
      `/admin/llm-usage/users/${CREATOR}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: '{"blocked":true}',
      },
      envWith({ DB: database(["workspace.members.read"]) } as Partial<Env>)
    );
    expect(patch.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is 404 without a gateway and 502 when the gateway fails", async () => {
    expect(
      (
        await call(
          "/admin/llm-usage",
          {},
          envWith({ GATEWAY_URL: undefined, GATEWAY_SECRET: undefined })
        )
      ).status
    ).toBe(404);
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    expect((await call("/admin/llm-usage")).status).toBe(502);
  });
});
