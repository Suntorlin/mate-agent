// The budget over the ledger Durable Object's SQLite: a restart reopens the ledger from it.
import { expect, test } from "vitest";
import {
  type BudgetPeriod,
  USAGE_CACHE_MS,
  USAGE_MAX_STALE_MS,
  createBudget,
  periodWindow,
} from "../../src/core/budget";
import { openLedger } from "../../src/core/ledger-store";
import type { SqlStore } from "../../src/core/sql";
import { withStorage } from "../helpers";

const OCT_31_LATE = Date.UTC(2026, 9, 31, 23, 59);

function setup(
  storage: SqlStore,
  budgetUsd: number,
  usages: Array<number | Error>,
  user: { budgetUsd?: number; period?: BudgetPeriod; clock?: number } = {}
) {
  let clock = user.clock ?? 1_000_000;
  let calls = 0;
  const fetchKeyUsage = async () => {
    const next = usages[Math.min(calls, usages.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const make = () =>
    createBudget({
      budgetUsd,
      userBudgetUsd: user.budgetUsd ?? 100,
      userBudgetPeriod: user.period ?? "month",
      ledger: openLedger(storage),
      fetchKeyUsage,
      now: () => clock,
      log: () => {},
    });
  return {
    budget: make(),
    make,
    /** What a restart would load. */
    persisted: () => openLedger(storage).state,
    advance: (ms: number) => (clock += ms),
    calls: () => calls,
  };
}

/** Lets a refresh started behind a check settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("records the first key usage as the baseline and persists it", () =>
  withStorage(async (storage) => {
    const { budget, persisted, make } = setup(storage, 25, [100, 130]);
    expect(await budget.check("u1")).toEqual({ allowed: true, spent: 0 });
    expect(persisted().baseline_usd).toBe(100);
    // A restart keeps the baseline instead of re-recording it.
    const restarted = make();
    const decision = await restarted.check("u1");
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.status).toBe(429);
  }));

test("refuses everyone with 429 once the key's spend reaches the global budget", () =>
  withStorage(async (storage) => {
    const { budget, advance } = setup(storage, 25, [100, 124.99, 125]);
    await budget.check("u1");
    advance(USAGE_CACHE_MS);
    expect((await budget.check("u1")).allowed).toBe(true);
    await settle();
    advance(USAGE_CACHE_MS);
    // The first check after the cache window answers from the last reading and refreshes it.
    expect((await budget.check("u1")).allowed).toBe(true);
    await settle();
    for (const sub of ["u1", "u2"]) {
      const decision = await budget.check(sub);
      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.scope).toBe("global");
      const message = !decision.allowed ? decision.message : "";
      expect(message).toMatch(/service-wide limit/);
      expect(message).not.toMatch(/LLM_BUDGET_USD|operator|OpenRouter/);
    }
  }));

test("a zero budget refuses immediately", () =>
  withStorage(async (storage) => {
    const decision = await setup(storage, 0, [42]).budget.check("u1");
    expect(!decision.allowed && decision.status).toBe(429);
    expect(!decision.allowed && decision.scope).toBe("global");
  }));

test("caches key usage for the cache window", () =>
  withStorage(async (storage) => {
    const { budget, advance, calls } = setup(storage, 25, [100, 101]);
    await budget.check("u1");
    advance(USAGE_CACHE_MS - 1);
    await budget.check("u1");
    expect(calls()).toBe(1);
    advance(1);
    await budget.check("u1");
    expect(calls()).toBe(2);
  }));

test("answers from the last reading while a fresh one is read", () =>
  withStorage(async (storage) => {
    let reads = 0;
    let clock = 0;
    const budget = createBudget({
      budgetUsd: 25,
      userBudgetUsd: 100,
      userBudgetPeriod: "month",
      ledger: openLedger(storage),
      // The second reading never arrives: a check must not wait for it.
      fetchKeyUsage: () => (++reads === 1 ? Promise.resolve(100) : new Promise<number>(() => {})),
      now: () => clock,
      log: () => {},
    });
    await budget.check("u1");
    clock += USAGE_CACHE_MS;
    expect(await budget.check("u1")).toEqual({ allowed: true, spent: 0 });
    expect(reads).toBe(2);
  }));

test("uses the last good value while it is fresh enough, then fails closed with 503", () =>
  withStorage(async (storage) => {
    const { budget, advance } = setup(storage, 25, [100, new Error("network")]);
    await budget.check("u1");
    advance(USAGE_CACHE_MS);
    expect((await budget.check("u1")).allowed).toBe(true);
    advance(USAGE_MAX_STALE_MS);
    const decision = await budget.check("u1");
    expect(!decision.allowed && decision.status).toBe(503);
  }));

test("fails closed when usage has never been read", () =>
  withStorage(async (storage) => {
    const decision = await setup(storage, 25, [new Error("down")]).budget.check("u1");
    expect(!decision.allowed && decision.status).toBe(503);
    expect(!decision.allowed ? decision.message : "").not.toMatch(/OpenRouter|operator/);
  }));

test("keeps a per-session and per-user ledger from response usage", () =>
  withStorage(async (storage) => {
    const { budget, persisted } = setup(storage, 25, [100]);
    budget.record("s1", "u1", { cost: 0.01, input_tokens: 10, output_tokens: 5 });
    budget.record("s2", "u1", { cost: 0.02, input_tokens: 1, cache_read_input_tokens: 7 });
    const snap = await budget.snapshot();
    expect(snap.ledger.by_user.u1.requests).toBe(2);
    expect(Math.abs(snap.ledger.by_user.u1.usd - 0.03)).toBeLessThan(1e-9);
    expect(snap.ledger.by_session.s1.output_tokens).toBe(5);
    expect(snap.ledger.total.cache_read_input_tokens).toBe(7);
    expect(snap.spent_usd).toBe(0);
    expect(snap.remaining_usd).toBe(25);
    expect(persisted().ledger.total.requests).toBe(2);
  }));

test("one user over their budget gets 429 while another user proceeds", () =>
  withStorage(async (storage) => {
    const { budget, calls } = setup(storage, 25, [100], {
      budgetUsd: 5,
      clock: Date.UTC(2026, 9, 15),
    });
    budget.record("s1", "heavy", { cost: 3 });
    expect((await budget.check("heavy")).allowed).toBe(true);
    budget.record("s1", "heavy", { cost: 2 });

    const refused = await budget.check("heavy");
    expect(refused.allowed).toBe(false);
    expect(!refused.allowed && refused.status).toBe(429);
    expect(!refused.allowed && refused.scope).toBe("user");
    expect(!refused.allowed && refused.message).toBe(
      "You've used this month's AI budget ($5.00 of $5.00). It resets on November 1, 2026 (UTC)."
    );
    const before = calls();
    await budget.check("heavy");
    expect(calls(), "a user over budget is refused without reading the key").toBe(before);

    expect(await budget.check("light")).toEqual({ allowed: true, spent: 0 });
    expect(budget.usageFor("light").remaining_usd).toBe(5);
  }));

test("a user's budget starts over in the next period and old periods stay in the ledger", () =>
  withStorage(async (storage) => {
    const { budget, advance, persisted } = setup(storage, 25, [100], {
      budgetUsd: 5,
      clock: OCT_31_LATE,
    });
    budget.record("s1", "u1", { cost: 5 });
    expect((await budget.check("u1")).allowed).toBe(false);
    expect(budget.usageFor("u1")).toEqual({
      period: "month",
      period_start: "2026-10-01T00:00:00.000Z",
      resets_at: "2026-11-01T00:00:00.000Z",
      budget_usd: 5,
      spent_usd: 5,
      remaining_usd: 0,
      requests: 1,
    });

    advance(60_000); // 2026-11-01T00:00Z
    expect((await budget.check("u1")).allowed).toBe(true);
    expect(budget.usageFor("u1").spent_usd).toBe(0);
    expect(budget.usageFor("u1").resets_at).toBe("2026-12-01T00:00:00.000Z");
    budget.record("s2", "u1", { cost: 1 });
    const { ledger } = persisted();
    expect(ledger.by_period["2026-10"].u1.usd).toBe(5);
    expect(ledger.by_period["2026-11"].u1.usd).toBe(1);
    expect(ledger.by_user.u1.usd).toBe(6);
  }));

test("a daily period resets at midnight UTC", () =>
  withStorage(async (storage) => {
    const { budget, advance } = setup(storage, 25, [100], {
      budgetUsd: 1,
      period: "day",
      clock: Date.UTC(2026, 9, 1, 23, 0),
    });
    budget.record("s1", "u1", { cost: 1 });
    const refused = await budget.check("u1");
    expect(!refused.allowed ? refused.message : "").toMatch(
      /^You've used today's AI budget .* midnight UTC\.$/
    );
    advance(60 * 60_000);
    expect((await budget.check("u1")).allowed).toBe(true);
  }));

test("per-user spend survives a restart", () =>
  withStorage(async (storage) => {
    const { budget, make } = setup(storage, 25, [100], {
      budgetUsd: 5,
      clock: Date.UTC(2026, 9, 15),
    });
    budget.record("s1", "u1", { cost: 5 });
    const restarted = make();
    expect(restarted.usageFor("u1").spent_usd).toBe(5);
    expect((await restarted.check("u1")).allowed).toBe(false);
  }));

test("a restart loads the same ledger, limits, settings and alerts the budget had", () =>
  withStorage(async (storage) => {
    const { budget, make } = setup(storage, 25, [100], {
      budgetUsd: 5,
      clock: Date.UTC(2026, 9, 15),
    });
    budget.record("s1", "u1", { cost: 0.5, input_tokens: 3, cache_creation_input_tokens: 9 });
    budget.record("s2", "u2", { cost: 0.25, output_tokens: 4 }, { id: "gen-a", model: "m" });
    budget.record("s2", "u2", { input_tokens: 2 }, { id: "gen-pending", model: "m" });
    budget.setLimit("u1", { budget_usd: null, blocked: true }, "admin-1");
    budget.setSettings({ monthly_budget_usd: 0.7, key_budget_usd: null }, "admin-2");
    await budget.check("u2");
    const before = await budget.snapshot();
    const restarted = make();
    const after = await restarted.snapshot();
    expect(after.ledger).toEqual(before.ledger);
    expect(after.baseline_usd).toBe(100);
    expect(restarted.pendingRequests()).toEqual(budget.pendingRequests());
    expect(restarted.adminUser("u1")).toEqual(budget.adminUser("u1"));
    expect(restarted.adminUser("u1").limit).toEqual({
      budget_usd: null,
      blocked: true,
      updated_at: new Date(Date.UTC(2026, 9, 15)).toISOString(),
      updated_by: "admin-1",
    });
    expect(restarted.adminSettings()).toEqual(budget.adminSettings());
    expect(restarted.adminSettings().alerts_sent).toEqual([0.8, 1]);
    expect(restarted.adminSessions("u2")).toEqual(budget.adminSessions("u2"));
  }));

test("period windows follow UTC calendar months and days, including year end", () => {
  const dec = periodWindow("month", Date.UTC(2026, 11, 31, 12));
  expect(dec.key).toBe("2026-12");
  expect(dec.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  const day = periodWindow("day", Date.UTC(2026, 1, 28, 5));
  expect(day.key).toBe("2026-02-28");
  expect(day.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
});
