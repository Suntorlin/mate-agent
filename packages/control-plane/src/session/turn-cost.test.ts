import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createGatewayTurnCostSource } from "./turn-cost";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ENV = {
  GATEWAY_URL: "https://gateway.example/",
  GATEWAY_SECRET: SECRET,
};

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

function spend(overrides: Record<string, unknown> = {}) {
  return {
    sid: "session-1",
    since: 1_000,
    until: 4_000,
    usd: 0.0099,
    requests: 6,
    unsettled: 0,
    input_tokens: 1_400,
    output_tokens: 200,
    cache_read_input_tokens: 52_000,
    cache_creation_input_tokens: 26_000,
    total: { sub: "user-1", usd: 0.0099, requests: 6, last_at: "2026-10-07T10:00:00.000Z" },
    ...overrides,
  };
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function setup(options: { env?: Record<string, unknown>; clock?: { now: number } } = {}) {
  const log = logger();
  const clock = options.clock ?? { now: 1_800_000_000_000 };
  const fetchMock = vi.fn<typeof fetch>();
  const source = createGatewayTurnCostSource((options.env ?? ENV) as typeof ENV, {
    getSessionId: () => "session-1",
    log: log as unknown as Logger,
    now: () => clock.now,
    fetch: fetchMock,
    sleep: async () => {},
  });
  return { source, fetchMock, log, clock };
}

describe("createGatewayTurnCostSource", () => {
  it("asks the gateway what the session's calls in the turn's window cost, as the control plane", async () => {
    const { source, fetchMock, clock } = setup();
    fetchMock.mockResolvedValue(Response.json(spend()));

    const usd = await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 });

    expect(usd).toBe(0.0099);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // The window's end is moved on a little: the gateway's clock is not this one.
    expect(url).toBe("https://gateway.example/llm/admin/sessions/session-1?since=1000&until=4000");
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")!.replace(/^Bearer /, "");
    const iat = Math.floor(clock.now / 1000);
    expect(decodePayload(token)).toMatchObject({
      sub: "control-plane",
      sid: "control-plane-admin",
      scope: "admin",
      iat,
    });
  });

  it("has no source without a gateway", () => {
    expect(
      setup({
        env: {},
      }).source
    ).toBeNull();
    expect(setup({ env: {} }).source).toBeNull();
  });

  it("is quiet about a gateway configured badly and leaves the runtime's figure", () => {
    const { source, log } = setup({ env: { ...ENV, GATEWAY_SECRET: "short" } });
    expect(source).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "turn_cost.misconfigured",
      expect.objectContaining({ event: "turn_cost.misconfigured" })
    );
  });

  it("goes through the gateway's service binding when the deployment has one", async () => {
    const binding = vi.fn<typeof fetch>().mockResolvedValue(Response.json(spend({ usd: 0.5 })));
    const log = logger();
    const source = createGatewayTurnCostSource(
      { ...ENV, GATEWAY: { fetch: binding } },
      { getSessionId: () => "session-1", log: log as unknown as Logger }
    );

    expect(await source!.turnCost({ sinceMs: 1, untilMs: 2 })).toBe(0.5);
    expect(binding).toHaveBeenCalledTimes(1);
  });

  it("has no figure for a window the ledger recorded no call in", async () => {
    const { source, fetchMock, log } = setup();
    fetchMock.mockResolvedValue(Response.json(spend({ usd: 0, requests: 0, total: null })));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      "turn_cost.no_calls",
      expect.objectContaining({ session_id: "session-1" })
    );
  });

  it("gives the cost of the settled calls and notes the ones still unsettled", async () => {
    const { source, fetchMock, log } = setup();
    fetchMock.mockResolvedValue(Response.json(spend({ usd: 0.004, requests: 3, unsettled: 1 })));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBe(0.004);
    expect(log.info).toHaveBeenCalledWith(
      "turn_cost.unsettled",
      expect.objectContaining({ unsettled: 1 })
    );
  });

  it("does not ask a gateway without the route again for ten minutes", async () => {
    const { source, fetchMock, clock, log } = setup();
    fetchMock.mockImplementation(async () => new Response("not found", { status: 404 }));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    clock.now += 9 * 60_000;
    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();

    clock.now += 2 * 60_000;
    fetchMock.mockResolvedValue(Response.json(spend()));
    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBe(0.0099);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves turns alone for a while after a failed lookup, so they do not wait on it", async () => {
    const { source, fetchMock, clock, log } = setup();
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "turn_cost.unavailable",
      expect.objectContaining({ status: 503 })
    );
    clock.now += 10_000;
    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.now += 11_000;
    fetchMock.mockResolvedValue(Response.json(spend()));
    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBe(0.0099);
  });

  it("asks again once when the answer never came, and uses the second answer", async () => {
    const { source, fetchMock, log } = setup();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Network connection lost"))
      .mockResolvedValueOnce(Response.json(spend()));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBe(0.0099);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      "turn_cost.retry",
      expect.objectContaining({ cause: expect.stringContaining("Network connection lost") })
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("gives up after the second lost answer, names the cause and pauses", async () => {
    const { source, fetchMock, log, clock } = setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      "turn_cost.unavailable",
      expect.objectContaining({ status: null, cause: expect.stringContaining("fetch failed") })
    );
    clock.now += 10_000;
    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(fetchMock, "paused for a while").toHaveBeenCalledTimes(2);
  });

  it("does not ask again when the gateway answered with an error status", async () => {
    const { source, fetchMock } = setup();
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an answer it cannot read as a failed lookup", async () => {
    const { source, fetchMock } = setup();
    fetchMock.mockResolvedValue(Response.json({ usd: "a lot" }));

    expect(await source!.turnCost({ sinceMs: 1_000, untilMs: 2_000 })).toBeNull();
  });
});
