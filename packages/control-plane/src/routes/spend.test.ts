import { describe, expect, it, vi } from "vitest";
import { spendView, withRunningTurnCost } from "./spend";

const state = (overrides: Partial<Parameters<typeof spendView>[0]> = {}) => ({
  permissionMode: "auto_within_budget",
  totalCost: 0.73842195,
  maxSessionCostUsd: 2,
  budgetExhausted: false,
  ...overrides,
});

describe("spendView", () => {
  it("gives a capped session its budget and what it has used of it", () => {
    expect(spendView(state())).toEqual({
      permissionMode: "auto_within_budget",
      unlimited: false,
      budgetUsd: 2,
      usedUsd: 0.73842195,
      remainingUsd: 2 - 0.73842195,
    });
    // Over the budget there is nothing left, never a negative figure.
    expect(spendView(state({ totalCost: 4.89 })).remainingUsd).toBe(0);
  });

  it("leaves a full_auto session, or one with no cap, uncapped", () => {
    for (const overrides of [{ permissionMode: "full_auto" }, { maxSessionCostUsd: null }]) {
      expect(spendView(state(overrides))).toMatchObject({
        unlimited: true,
        budgetUsd: null,
        usedUsd: 0.73842195,
        remainingUsd: null,
      });
    }
  });
});

describe("withRunningTurnCost", () => {
  const env = {
    GATEWAY_URL: "https://gateway.example",
    GATEWAY_SECRET: "s".repeat(64),
  };
  const NOW = 1_800_000_000_000;
  const STARTED = NOW - 90_000;

  function gateway(usd: number, init: { status?: number } = {}) {
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      init.status && init.status !== 200
        ? new Response("nope", { status: init.status })
        : Response.json({
            sid: "sess-1",
            since: STARTED,
            until: NOW + 2_000,
            usd,
            requests: usd > 0 ? 12 : 0,
            unsettled: 0,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            total: null,
          })
    );
  }

  it("counts a first turn's model use while the turn is still running", async () => {
    const running = state({
      totalCost: 0,
      runningTurn: { startedAt: STARTED, reportedCostUsd: 0 },
    });
    // The bug: the stored total holds nothing of a turn that has not ended.
    expect(spendView(running).usedUsd).toBe(0);

    const fetch = gateway(0.1767);
    const live = await withRunningTurnCost(running, {
      env,
      sessionId: "sess-1",
      nowMs: NOW,
      fetch,
    });

    expect(spendView(live).usedUsd).toBeCloseTo(0.1767);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      `https://gateway.example/llm/admin/sessions/sess-1?since=${STARTED}&until=${NOW + 2_000}`
    );
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
  });

  it("adds only what the stored total does not already hold of the running turn", async () => {
    const running = state({
      totalCost: 0.5,
      runningTurn: { startedAt: STARTED, reportedCostUsd: 0.2 },
    });
    const more = await withRunningTurnCost(running, {
      env,
      sessionId: "sess-1",
      nowMs: NOW,
      fetch: gateway(0.25),
    });
    expect(more.totalCost).toBeCloseTo(0.55);

    const less = await withRunningTurnCost(running, {
      env,
      sessionId: "sess-1",
      nowMs: NOW,
      fetch: gateway(0.1),
    });
    expect(less.totalCost).toBe(0.5);
  });

  it("asks nothing between turns, when the stored total already holds every turn", async () => {
    const fetch = gateway(1);
    const idle = state({ runningTurn: null });
    expect(await withRunningTurnCost(idle, { env, sessionId: "sess-1", nowMs: NOW, fetch })).toBe(
      idle
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the stored total when the gateway cannot answer or is not configured", async () => {
    const running = state({
      totalCost: 0.3,
      runningTurn: { startedAt: STARTED, reportedCostUsd: 0 },
    });
    const failing = await withRunningTurnCost(running, {
      env,
      sessionId: "sess-1",
      nowMs: NOW,
      fetch: gateway(0, { status: 502 }),
    });
    expect(failing.totalCost).toBe(0.3);

    const throwing = await withRunningTurnCost(running, {
      env,
      sessionId: "sess-1",
      nowMs: NOW,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(throwing.totalCost).toBe(0.3);

    const fetch = gateway(1);
    const noGateway = await withRunningTurnCost(running, {
      env: {},
      sessionId: "sess-1",
      nowMs: NOW,
      fetch,
    });
    expect(noGateway.totalCost).toBe(0.3);
    expect(fetch).not.toHaveBeenCalled();
  });
});
