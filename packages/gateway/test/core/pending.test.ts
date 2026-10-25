// Calls whose cost arrives after the response: pending records, settling, and the backfill.
import { expect, test } from "vitest";
import { BACKFILL_MAX_AGE_MS, BACKFILL_MIN_AGE_MS, createBackfill } from "../../src/core/backfill";
import { type RequestUsage, createBudget } from "../../src/core/budget";
import { openLedger } from "../../src/core/ledger-store";
import type { SqlStore } from "../../src/core/sql";
import { withStorage } from "../helpers";

function setup(storage: SqlStore, start = Date.UTC(2026, 9, 31, 23, 59, 50)) {
  let clock = start;
  const make = () =>
    createBudget({
      budgetUsd: 100,
      userBudgetUsd: 10,
      userBudgetPeriod: "month",
      ledger: openLedger(storage),
      fetchKeyUsage: async () => 0,
      now: () => clock,
      log: () => {},
    });
  return {
    budget: make(),
    make,
    persisted: () => openLedger(storage).state,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

test("a call without a cost but with a generation id waits, then counts in its own month", () =>
  withStorage(async (storage) => {
    const { budget, advance } = setup(storage);
    budget.record(
      "s1",
      "u1",
      { input_tokens: 2, cache_read_input_tokens: 500 },
      { id: "gen-1", model: "m" }
    );
    expect(budget.usageFor("u1").spent_usd).toBe(0);
    expect(budget.pendingRequests()).toHaveLength(1);
    advance(60_000); // now in November
    const done = budget.settle("gen-1", { cost: 0.3, input_tokens: 9, output_tokens: 70 });
    expect(done?.status).toBe("settled");
    expect(done?.source).toBe("generation");
    const snap = await budget.snapshot();
    expect(snap.ledger.by_period["2026-10"].u1.usd, "counted in October, when it was made").toBe(
      0.3
    );
    expect(snap.ledger.by_period["2026-11"]).toBeUndefined();
    expect(snap.ledger.by_user.u1.input_tokens, "the stream's own counts win").toBe(2);
    expect(snap.ledger.by_user.u1.output_tokens, "the lookup fills what the cut lost").toBe(70);
    expect(snap.ledger.by_user.u1.cache_read_input_tokens).toBe(500);
    expect(budget.pendingRequests()).toHaveLength(0);
    expect(budget.settle("gen-1", { cost: 1 }), "settling twice counts once").toBeNull();
    expect((await budget.snapshot()).ledger.total.usd).toBe(0.3);
  }));

test("calls with a cost, or with neither cost nor id, count right away as before", () =>
  withStorage((storage) => {
    const { budget } = setup(storage);
    budget.record("s1", "u1", { cost: 0.2 }, { id: "gen-2" });
    budget.record("s1", "u1", { input_tokens: 1 });
    expect(budget.usageFor("u1").requests).toBe(2);
    expect(budget.pendingRequests()).toHaveLength(0);
  }));

test("pending calls survive a restart of the SQLite ledger", () =>
  withStorage((storage) => {
    const { budget, make, persisted } = setup(storage);
    budget.record("s1", "u1", {}, { id: "gen-3" });
    expect(persisted().pending?.["gen-3"].sub).toBe("u1");
    const restarted = make();
    expect(restarted.pendingRequests()[0].id).toBe("gen-3");
    restarted.settle("gen-3", { cost: 1.5 });
    expect(make().usageFor("u1").spent_usd).toBe(1.5);
    expect(make().pendingRequests()).toEqual([]);
  }));

test("backfill waits for OpenRouter to know the id, settles, and gives up after the limit", () =>
  withStorage(async (storage) => {
    const { budget, advance, now, persisted } = setup(storage, Date.UTC(2026, 9, 10));
    budget.record("s1", "u1", {}, { id: "gen-late" });
    budget.record("s1", "u2", {}, { id: "gen-never" });
    budget.record("s1", "u3", {}, { id: "gen-flaky" });
    const answers: Record<string, RequestUsage | null | Error> = {
      "gen-late": null,
      "gen-never": null,
      "gen-flaky": new Error("502"),
    };
    const asked: string[] = [];
    const backfill = createBackfill({
      budget,
      now,
      log: () => {},
      fetchGeneration: async (id) => {
        asked.push(id);
        const answer = answers[id];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });

    await backfill.tick();
    expect(asked, "too young to look up").toEqual([]);

    advance(BACKFILL_MIN_AGE_MS);
    await backfill.tick();
    expect(asked).toHaveLength(3);
    expect(budget.pendingRequests(), "404s and errors stay pending").toHaveLength(3);

    answers["gen-late"] = { cost: 0.25, output_tokens: 12 };
    await backfill.tick();
    expect(budget.usageFor("u1").spent_usd).toBe(0.25);

    advance(BACKFILL_MAX_AGE_MS);
    await backfill.tick();
    expect(budget.pendingRequests()).toHaveLength(0);
    expect(budget.usageFor("u2").spent_usd, "an id OpenRouter never knew is not billed").toBe(0);
    expect(budget.usageFor("u3").requests).toBe(0);
    expect(persisted().pending).toEqual({});
  }));
