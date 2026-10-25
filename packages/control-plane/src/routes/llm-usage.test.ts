import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { GATEWAY_USAGE_TOKEN_TTL_SECONDS } from "../gateway/usage";
import { llmUsageRoutes } from "./llm-usage";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXED_NOW = 1_800_000_000_000;

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([llmUsageRoutes]);

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    ...TEST_SERVICE_SECRETS,
    DB: ownerAuthorizationDatabase("user-a"),
    GATEWAY_URL: "https://gateway.example/",
    GATEWAY_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

const GATEWAY_USAGE = {
  period: "month",
  period_start: "2026-10-01T00:00:00.000Z",
  resets_at: "2026-11-01T00:00:00.000Z",
  budget_usd: 20,
  spent_usd: 1.25,
  remaining_usd: 18.75,
  requests: 4,
};

describe("GET /me/llm-usage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal("fetch", fetchMock);
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-a" },
      request,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function get(env = envWith()): Promise<Response> {
    return handleRequest(
      new Request("https://test.local/me/llm-usage"),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it("asks the gateway for the caller's own usage with a short-lived usage-scoped token", async () => {
    fetchMock.mockResolvedValue(Response.json(GATEWAY_USAGE));

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      period: "month",
      periodStart: "2026-10-01T00:00:00.000Z",
      resetsAt: "2026-11-01T00:00:00.000Z",
      budgetUsd: 20,
      spentUsd: 1.25,
      remainingUsd: 18.75,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gateway.example/llm/usage");
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")!.replace(/^Bearer /, "");
    const iat = Math.floor(FIXED_NOW / 1000);
    expect(decodePayload(token)).toEqual({
      sub: "user-a",
      sid: "control-plane-usage",
      scope: "usage",
      iat,
      exp: iat + GATEWAY_USAGE_TOKEN_TTL_SECONDS,
    });
    expect(headers.get("user-agent")).toMatch(/^agent-engine-control-plane\//);
  });

  it("asks through the gateway's service binding, not the public address, when there is one", async () => {
    const binding = vi.fn<typeof fetch>().mockResolvedValue(Response.json(GATEWAY_USAGE));

    const response = await get(envWith({ GATEWAY: { fetch: binding } }));

    expect(response.status).toBe(200);
    expect(binding).toHaveBeenCalledTimes(1);
    expect(binding.mock.calls[0][0]).toBe("https://gateway.example/llm/usage");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names whoever is signed in, never a user from the request", async () => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-b" },
      request,
    }));
    fetchMock.mockResolvedValue(Response.json(GATEWAY_USAGE));

    await handleRequest(
      new Request("https://test.local/me/llm-usage?userId=user-a"),
      envWith({ DB: ownerAuthorizationDatabase("user-b") } as Partial<Env>),
      TEST_BACKGROUND_TASK_CONTEXT
    );

    const token = new Headers(fetchMock.mock.calls[0][1]?.headers)
      .get("authorization")!
      .replace(/^Bearer /, "");
    expect(decodePayload(token).sub).toBe("user-b");
  });

  it("refuses anonymous callers without reaching the gateway", async () => {
    mocks.authenticate.mockResolvedValue({ principal: null });

    const response = await get();

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is 404 without a gateway", async () => {
    const response = await get(envWith({ GATEWAY_URL: undefined, GATEWAY_SECRET: undefined }));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is 502 when the gateway fails or answers something else", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect((await get()).status).toBe(502);

    fetchMock.mockResolvedValueOnce(Response.json({ spent: "a lot" }));
    expect((await get()).status).toBe(502);

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await get()).status).toBe(502);
  });
});
