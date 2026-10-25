// The ledger over its storage ports: what a session's calls cost over a window. What the Worker's
// ledger object keeps across instances and what its alarm does is in worker/ledger-do.test.ts.
import { expect, test } from "vitest";
import { createLedger } from "../../src/core/ledger";
import { withLedgerStorage } from "../helpers";

test("a session's spend over a window counts the calls that finished in it, ends included", () =>
  withLedgerStorage(async (storage) => {
    let clock = Date.parse("2026-10-07T10:00:00.000Z");
    const start = clock;
    const ledger = createLedger({
      ...storage,
      budgetUsd: 100,
      userBudgetUsd: 100,
      monthlyBudgetUsd: null,
      userBudgetPeriod: "month",
      fetchKeyUsage: async () => 0,
      fetchGeneration: async () => null,
      sendPing: async () => null,
      now: () => clock,
      log: () => {},
    });
    const call = async (
      sid: string,
      usage: Record<string, number>,
      offsetMs: number,
      id?: string
    ) => {
      clock = start + offsetMs;
      await ledger.record({
        sid,
        sub: "u1",
        model: "m",
        usage,
        ...(id ? { generationId: id } : {}),
      });
    };
    await call("s1", { cost: 0.01, input_tokens: 10, output_tokens: 5 }, 1_000);
    await call("s1", { cost: 0.02, input_tokens: 20, output_tokens: 6 }, 5_000);
    await call("s1", { cost: 0.04, input_tokens: 40, output_tokens: 7 }, 9_000);
    await call("s2", { cost: 0.5 }, 6_000);

    const middle = ledger.session("s1", start + 2_000, start + 6_000);
    expect(middle).toMatchObject({ sid: "s1", requests: 1, unsettled: 0, input_tokens: 20 });
    expect(middle.usd).toBeCloseTo(0.02);

    const ends = ledger.session("s1", start + 1_000, start + 9_000);
    expect(ends.requests, "both ends of the window count").toBe(3);
    expect(ends.usd).toBeCloseTo(0.07);
    expect(ends).toMatchObject({ input_tokens: 70, output_tokens: 18 });
    expect(ledger.session("s1", start + 1_001, start + 8_999).requests).toBe(1);

    // Another session's calls are not counted, and a session the ledger has not seen is empty.
    expect(ledger.session("s3", 0, start + 60_000)).toMatchObject({
      usd: 0,
      requests: 0,
      unsettled: 0,
      total: null,
    });
    expect(ledger.session("s2", 0, start + 60_000).usd).toBeCloseTo(0.5);

    // A cut-off call without a cost waits as unsettled: counted, but not in the cost.
    await call("s1", {}, 10_000, "gen-cut");
    const withCut = ledger.session("s1", start + 9_500, start + 11_000);
    expect(withCut).toMatchObject({ requests: 1, unsettled: 1, usd: 0 });

    // The session's own total does not depend on the window.
    const all = ledger.session("s1", 0, start + 60_000);
    expect(all.total).toMatchObject({ sub: "u1", requests: 3 });
    expect(all.total?.usd).toBeCloseTo(0.07);
  }));
