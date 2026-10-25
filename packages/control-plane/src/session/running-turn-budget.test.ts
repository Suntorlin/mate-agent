import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionBudgetService } from "./budget-service";
import type { EventRepository } from "./event-repository";
import type { ExecutionStopPreparation } from "./execution-stop-coordinator";
import type { SessionMessenger } from "./messenger";
import { RunningTurnBudgetWatch, type TurnSpendSource } from "./running-turn-budget";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionPermissionMode } from "@open-inspect/shared/types/sessions";

const INTERVAL = 20_000;
const STARTED = 1_000_000;

/**
 * A session with one running turn, its budget service real, the stop and the ledger fake. The
 * stop ends the turn, as `ExecutionStopCoordinator.prepare` does.
 */
function createSession(
  options: {
    maxCostUsd?: number | null;
    permissionMode?: SessionPermissionMode;
    storedCostUsd?: number;
    spend?: TurnSpendSource["turnCost"];
  } = {}
) {
  const state = {
    total_cost: options.storedCostUsd ?? 0,
    max_cost_usd: options.maxCostUsd === undefined ? 2 : options.maxCostUsd,
    permission_mode: options.permissionMode ?? ("auto_within_budget" as SessionPermissionMode),
    budget_exhausted: 0,
    running: "message-1" as string | null,
    reported: new Map<string, number>(),
  };
  const repository = {
    getSession: () => ({ ...state }),
    transaction: <T>(closure: () => T) => closure(),
    addSessionCost: (delta: number) => (state.total_cost += delta),
    markBudgetExhausted: () => {
      state.budget_exhausted = 1;
    },
    setSessionBudget: vi.fn(),
  };
  const messageRepository = {
    raiseReportedCost: (messageId: string, reported: number) => {
      const previous = state.reported.get(messageId) ?? 0;
      if (reported <= previous) return 0;
      state.reported.set(messageId, reported);
      return reported - previous;
    },
    getRunningTurnCost: () =>
      state.running === null
        ? null
        : {
            messageId: state.running,
            startedAt: STARTED,
            reportedCostUsd: state.reported.get(state.running) ?? 0,
          },
  };
  const prepare = vi.fn((): ExecutionStopPreparation | null => {
    state.running = null;
    return { stopConfirmationDeadline: 0 } as unknown as ExecutionStopPreparation;
  });
  const deliver = vi.fn(async () => {});
  const broadcast = vi.fn();
  const budget = new SessionBudgetService(
    repository as unknown as SessionCoreRepository,
    messageRepository,
    { createEvent: vi.fn() } as unknown as EventRepository,
    { broadcast } as unknown as SessionMessenger,
    { prepare, deliver },
    async () => {},
    () => "event-1"
  );
  const pending: Promise<unknown>[] = [];
  const backgroundTasks = {
    submit: vi.fn((task: () => Promise<unknown>) => {
      pending.push(task());
    }),
  };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const turnCost = vi.fn(options.spend ?? (async () => 0));
  let clock = STARTED;
  const watch = new RunningTurnBudgetWatch({
    getSession: repository.getSession,
    getRunningTurn: messageRepository.getRunningTurnCost,
    spend: { turnCost },
    budget,
    backgroundTasks,
    log: log as unknown as Logger,
    now: () => clock,
    intervalMs: INTERVAL,
  });
  /** One sandbox event at `at`, and whatever check it started, finished. */
  const event = async (at: number) => {
    clock = at;
    watch.observe(at);
    await Promise.all(pending.splice(0));
  };
  return { state, watch, event, turnCost, prepare, deliver, broadcast, backgroundTasks, log };
}

describe("RunningTurnBudgetWatch", () => {
  it("stops a capped turn once its live model use crosses the cap, long before the turn ends", async () => {
    // A $2 cap (130,000 credits); the ledger sees the turn spend $0.16 a minute, so the turn
    // crosses the cap 12 min 30 s in, while it runs for 23 minutes.
    const h = createSession({
      spend: async ({ untilMs }) => ((untilMs - STARTED) / 60_000) * 0.16,
    });

    for (let at = STARTED; at <= STARTED + 23 * 60_000; at += 1_000) {
      await h.event(at);
    }

    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.prepare).toHaveBeenCalledWith(
      expect.stringMatching(/^Session cost limit reached: \$2\.0\d of \$2\.00/),
      expect.any(Number)
    );
    // The look at 12 min 40 s finds it: at most one interval's use over the cap.
    expect(h.state.total_cost).toBeGreaterThanOrEqual(2);
    expect(h.state.total_cost).toBeLessThanOrEqual(2 + (INTERVAL / 60_000) * 0.16);
    expect(h.state.budget_exhausted).toBe(1);
    // Throttled while it ran, and never asked again once the budget was spent.
    const asked = h.turnCost.mock.calls.length;
    expect(asked).toBe(39); // every 20 s from the start up to 12 min 40 s
    await h.event(STARTED + 24 * 60_000);
    expect(h.turnCost).toHaveBeenCalledTimes(asked);
  });

  it("counts what was stored before the turn toward the cap", async () => {
    const h = createSession({ storedCostUsd: 1.5, spend: async () => 0.6 });
    await h.event(STARTED + 5_000);
    expect(h.state.total_cost).toBeCloseTo(2.1);
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it.each([
    ["全部自动", { permissionMode: "full_auto" as const }],
    ["no cap", { maxCostUsd: null }],
  ])("never asks the ledger under %s", async (_name, options) => {
    const h = createSession({ ...options, spend: async () => 100 });
    for (let at = STARTED; at <= STARTED + 10 * 60_000; at += 5_000) await h.event(at);
    expect(h.turnCost).not.toHaveBeenCalled();
    expect(h.backgroundTasks.submit).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.state.total_cost).toBe(0);
  });

  it("does not stop, and logs, when the ledger cannot answer; the next interval asks again", async () => {
    let failing = true;
    const h = createSession({
      spend: async () => {
        if (failing) throw new Error("gateway down");
        return 3;
      },
    });

    await h.event(STARTED + 1_000);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.state.total_cost).toBe(0);
    expect(h.log.warn).toHaveBeenCalledWith(
      "budget.running_turn_check_failed",
      expect.objectContaining({ message_id: "message-1" })
    );

    failing = false;
    await h.event(STARTED + 1_000 + INTERVAL - 1);
    expect(h.turnCost).toHaveBeenCalledOnce();
    await h.event(STARTED + 1_000 + INTERVAL);
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it("does not stop when the ledger has no figure", async () => {
    const h = createSession({ spend: async () => null });
    await h.event(STARTED + 1_000);
    await h.event(STARTED + 1_000 + INTERVAL);
    expect(h.turnCost).toHaveBeenCalledTimes(2);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("asks one at a time, and only while a turn runs", async () => {
    let answer: (usd: number) => void = () => {};
    const h = createSession({
      spend: () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    });
    h.watch.observe(STARTED + 1_000);
    h.watch.observe(STARTED + 1_000 + 2 * INTERVAL);
    expect(h.turnCost).toHaveBeenCalledOnce();
    answer(0.5);
    await Promise.resolve();
    await Promise.resolve();

    h.state.running = null;
    h.watch.observe(STARTED + 1_000 + 4 * INTERVAL);
    expect(h.turnCost).toHaveBeenCalledOnce();
  });

  it("counts nothing when the cap was lifted while the ledger answered", async () => {
    let answer: (usd: number) => void = () => {};
    const h = createSession({
      spend: () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    });
    h.watch.observe(STARTED + 1_000);
    h.state.permission_mode = "full_auto";
    answer(5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.total_cost).toBe(0);
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
