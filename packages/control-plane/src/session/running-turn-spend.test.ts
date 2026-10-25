import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createGatewayRunningTurnSpend } from "./running-turn-spend";

const env = {
  GATEWAY_URL: "https://gateway.example",
  GATEWAY_SECRET: "s".repeat(64),
};
const NOW = 1_800_000_000_000;
const STARTED = NOW - 600_000;

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function gatewayAnswer(usd: number) {
  return Response.json({
    sid: "sess-1",
    since: STARTED,
    until: NOW + 2_000,
    usd,
    requests: 40,
    unsettled: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total: null,
  });
}

describe("createGatewayRunningTurnSpend", () => {
  it("asks the gateway what the session's calls since the turn started cost", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      gatewayAnswer(2.4)
    );
    const source = createGatewayRunningTurnSpend(env, {
      getSessionId: () => "sess-1",
      log: logger(),
      now: () => NOW,
      fetch,
    });

    expect(await source?.turnCost({ sinceMs: STARTED, untilMs: NOW })).toBe(2.4);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/llm/admin/sessions/sess-1");
    expect(url.searchParams.get("since")).toBe(String(STARTED));
    expect(url.searchParams.get("until")).toBe(String(NOW + 2_000));
  });

  it("answers null and logs when the gateway cannot answer", async () => {
    const log = logger();
    const failing = createGatewayRunningTurnSpend(env, {
      getSessionId: () => "sess-1",
      log,
      now: () => NOW,
      fetch: vi.fn(async () => new Response("nope", { status: 502 })),
    });
    expect(await failing?.turnCost({ sinceMs: STARTED, untilMs: NOW })).toBeNull();

    const unreachable = createGatewayRunningTurnSpend(env, {
      getSessionId: () => "sess-1",
      log,
      now: () => NOW,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await unreachable?.turnCost({ sinceMs: STARTED, untilMs: NOW })).toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0][0]).toBe("running_turn_spend.unavailable");
    expect(log.warn.mock.calls[0][1]).toMatchObject({ session_id: "sess-1", status: 502 });
  });

  it("is absent without a gateway", () => {
    expect(
      createGatewayRunningTurnSpend({}, { getSessionId: () => "sess-1", log: logger() })
    ).toBeNull();
  });
});
