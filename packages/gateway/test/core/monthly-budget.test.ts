// The service-wide monthly budget, its alerts, and the settings an admin reads and sets. The
// admin routes over HTTP are in admin.test.ts.
import { expect, test } from "vitest";
import { createBudget, refusalKind, refusalTag } from "../../src/core/budget";
import { openLedger } from "../../src/core/ledger-store";
import type { SqlStore } from "../../src/core/sql";
import { withStorage } from "../helpers";

const OCT = Date.UTC(2026, 9, 15, 12);

function setup(
  storage: SqlStore,
  options: { monthly?: number | null; clock?: number; keyUsage?: () => number } = {}
) {
  const alerts: string[] = [];
  let clock = options.clock ?? OCT;
  const make = () =>
    createBudget({
      budgetUsd: 1000,
      userBudgetUsd: 100,
      monthlyBudgetUsd: options.monthly ?? null,
      userBudgetPeriod: "month",
      ledger: openLedger(storage),
      fetchKeyUsage: async () => options.keyUsage?.() ?? 0,
      alert: (message) => alerts.push(message),
      now: () => clock,
      log: () => {},
    });
  return { budget: make(), make, alerts, setClock: (ms: number) => (clock = ms) };
}

test("the monthly budget stops everyone once the month's spend reaches it", () =>
  withStorage(async (storage) => {
    const { budget } = setup(storage, { monthly: 10 });
    budget.record("s1", "u1", { cost: 6 });
    expect((await budget.check("u2")).allowed).toBe(true);
    budget.record("s2", "u2", { cost: 4 });
    for (const sub of ["u1", "u2", "u3"]) {
      const decision = await budget.check(sub);
      expect(!decision.allowed && decision.scope).toBe("global");
      expect(!decision.allowed ? decision.message : "").toMatch(/service-wide limit/);
    }
  }));

test("a spent budget names its limit and when it resets; a paused check does not", () =>
  withStorage(async (storage) => {
    const { budget } = setup(storage, { monthly: 10 });
    budget.record("s1", "u1", { cost: 10 });
    const global = await budget.check("u2");
    if (global.allowed) throw new Error("allowed");
    expect(global.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(refusalTag(global)).toBe("[llm_budget=global resets_at=2026-11-01T00:00:00.000Z]");

    budget.setSettings({ monthly_budget_usd: null, user_budget_usd: 5 }, "admin-a");
    const own = await budget.check("u1");
    if (own.allowed) throw new Error("allowed");
    expect(own.scope).toBe("user");
    expect(refusalTag(own)).toBe("[llm_budget=user resets_at=2026-11-01T00:00:00.000Z]");

    budget.setLimit("u1", { blocked: true }, "admin-a");
    const blocked = await budget.check("u1");
    if (blocked.allowed) throw new Error("allowed");
    expect(refusalTag(blocked)).toBe("[llm_budget=blocked]");

    const unavailable = {
      allowed: false,
      status: 503,
      scope: "global",
      message: "AI usage could not be checked right now.",
    } as const;
    expect(refusalTag(unavailable)).toBeNull();
    expect(refusalKind(unavailable)).toBeNull();
  }));

test("an admin raises the key's safety cap and the stopped agent runs again", () =>
  withStorage(async (storage) => {
    let keyUsage = 0;
    const { budget, setClock } = setup(storage, { keyUsage: () => keyUsage });
    expect((await budget.check("u1")).allowed).toBe(true);
    keyUsage = 1000.5;
    // Past the longest a stale key reading still answers.
    setClock(OCT + 6 * 60_000);
    const stopped = await budget.check("u1");
    expect(!stopped.allowed && stopped.scope).toBe("global");
    expect(budget.adminSettings(await budget.keySpent()).key_spent_usd).toBe(1000.5);
    budget.setSettings({ key_budget_usd: 1500 }, "admin-a");
    expect((await budget.check("u1")).allowed).toBe(true);
    const settings = budget.adminSettings();
    expect(settings.key_budget_usd).toBe(1500);
    expect(settings.deployment_key_budget_usd).toBe(1000);
    budget.setSettings({ key_budget_usd: null }, "admin-a");
    expect(budget.adminSettings().key_budget_usd).toBe(1000);
    expect((await budget.check("u1")).allowed).toBe(false);
  }));

test("a new month starts from zero", () =>
  withStorage(async (storage) => {
    const { budget, setClock } = setup(storage, { monthly: 10 });
    budget.record("s1", "u1", { cost: 10 });
    expect((await budget.check("u1")).allowed).toBe(false);
    setClock(Date.UTC(2026, 10, 1, 0, 1));
    expect((await budget.check("u1")).allowed).toBe(true);
  }));

test("alerts once at 80% and once at 100% each month, and persists that", () =>
  withStorage(async (storage) => {
    const { budget, alerts, make } = setup(storage, { monthly: 10 });
    budget.record("s1", "u1", { cost: 7.9 });
    expect(alerts).toHaveLength(0);
    budget.record("s1", "u1", { cost: 0.2 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/\$8\.10 of the \$10\.00 monthly budget and is at 81%/);
    budget.record("s1", "u1", { cost: 0.5 });
    expect(alerts).toHaveLength(1);
    // A restart remembers what was sent.
    const restarted = make();
    restarted.record("s1", "u1", { cost: 2 });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatch(/has reached it/);
    restarted.record("s1", "u1", { cost: 1 });
    expect(alerts).toHaveLength(2);
  }));

test("no monthly budget means no monthly cap and no alerts", () =>
  withStorage(async (storage) => {
    const { budget, alerts } = setup(storage);
    budget.record("s1", "u1", { cost: 50 });
    expect((await budget.check("u2")).allowed).toBe(true);
    expect(alerts).toEqual([]);
  }));

test("an admin's settings override the deployment's, and null restores it", () =>
  withStorage(async (storage) => {
    const { budget, alerts } = setup(storage, { monthly: 100 });
    budget.record("s1", "u1", { cost: 9 });
    budget.setSettings({ monthly_budget_usd: 10, user_budget_usd: 5 }, "admin-a");
    // Lowering the budget below what was spent alerts right away.
    expect(alerts).toHaveLength(1);
    const decision = await budget.check("u1");
    expect(!decision.allowed && decision.scope).toBe("user");
    expect(budget.adminSettings().user_budget_usd).toBe(5);
    expect(budget.adminSettings().updated_by).toBe("admin-a");
    budget.setSettings({ monthly_budget_usd: null, user_budget_usd: null }, "admin-a");
    expect(budget.adminSettings().monthly_budget_usd).toBe(100);
    expect(budget.adminSettings().user_budget_usd).toBe(100);
    expect((await budget.check("u1")).allowed).toBe(true);
  }));

test("a new monthly budget alerts afresh, but the same budget does not repeat", () =>
  withStorage(async (storage) => {
    const { budget, alerts } = setup(storage, { monthly: 10 });
    budget.record("s1", "u1", { cost: 8.5 });
    expect(alerts).toHaveLength(1);
    budget.setSettings({ user_budget_usd: 50 }, "admin-a");
    expect(alerts).toHaveLength(1);
    budget.setSettings({ monthly_budget_usd: 100 }, "admin-a");
    expect(alerts).toHaveLength(1);
    budget.record("s1", "u1", { cost: 75 });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatch(/\$83\.50 of the \$100\.00 monthly budget/);
  }));
