/**
 * Holds a capped session to its cap while a turn runs.
 *
 * The session's cap (auto_within_budget) is enforced on its stored total, which grows when the runtime
 * reports a turn's cost. The Claude agent reports it once, at the end of the turn, so one long
 * turn could run far past the cap before anything checked it (a 130,000-credit session stopped
 * at 162,758). While a turn of a capped session runs, every sandbox event (tokens, tool calls,
 * the bridge's 30 s heartbeat) may prompt a look at what the turn has cost so far, at most once
 * per interval and one at a time; the answer is counted into the session total like a cost report
 * (`SessionBudgetService.observeRunningTurnSpend`), so crossing the cap stops the turn and shows
 * the same budget-exhausted card as a report at the end of a turn would. The overshoot is what the
 * agent spends in one interval plus the call in flight.
 *
 * Uncapped sessions (full_auto, or no limit), spent ones, and sessions without a ledger to ask are
 * never looked at. A lookup that fails changes nothing; the next interval asks again.
 */

import type { SessionRow } from "./types";
import type { BackgroundTasks } from "../platform-ports";
import type { Logger } from "../logger";
import type { SessionBudgetService } from "./budget-service";
import type { RunningTurnCost } from "./message-repository";

/** Long enough to keep the ledger lookups rare, short enough that a turn overshoots by little. */
export const RUNNING_TURN_BUDGET_CHECK_INTERVAL_MS = 20_000;

/** What a session's calls in a time window cost, or null when that is not known. */
export interface TurnSpendSource {
  turnCost(window: { sinceMs: number; untilMs: number }): Promise<number | null>;
}

export interface RunningTurnBudgetWatchDeps {
  readonly getSession: () => Pick<
    SessionRow,
    "max_cost_usd" | "permission_mode" | "budget_exhausted"
  > | null;
  readonly getRunningTurn: () => RunningTurnCost | null;
  readonly spend: TurnSpendSource;
  readonly budget: Pick<SessionBudgetService, "observeRunningTurnSpend">;
  readonly backgroundTasks: BackgroundTasks;
  readonly log: Logger;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

export class RunningTurnBudgetWatch {
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private checking = false;

  constructor(private readonly deps: RunningTurnBudgetWatchDeps) {}

  /** Called for every sandbox event; does nothing unless a check of a capped turn is due. */
  observe(now: number): void {
    if (this.checking) return;
    if (now - this.lastCheckAt < (this.deps.intervalMs ?? RUNNING_TURN_BUDGET_CHECK_INTERVAL_MS)) {
      return;
    }
    if (!isCapped(this.deps.getSession())) return;
    const turn = this.deps.getRunningTurn();
    if (!turn) return;
    this.lastCheckAt = now;
    this.checking = true;
    this.deps.backgroundTasks.submit(
      async () => {
        try {
          await this.check(turn, now);
        } finally {
          this.checking = false;
        }
      },
      { name: "budget.running_turn_check", context: { message_id: turn.messageId } }
    );
  }

  private async check(turn: RunningTurnCost, now: number): Promise<void> {
    let spentUsd: number | null;
    try {
      spentUsd = await this.deps.spend.turnCost({ sinceMs: turn.startedAt, untilMs: now });
    } catch (error) {
      this.deps.log.warn("budget.running_turn_check_failed", {
        event: "budget.running_turn_check_failed",
        message_id: turn.messageId,
        error: error instanceof Error ? error : String(error),
      });
      return;
    }
    if (spentUsd === null || !Number.isFinite(spentUsd)) return;
    // The limit may have changed or the turn ended while the ledger answered.
    if (!isCapped(this.deps.getSession())) return;
    await this.deps.budget.observeRunningTurnSpend(
      turn.messageId,
      spentUsd,
      (this.deps.now ?? Date.now)()
    );
  }
}

function isCapped(
  session: Pick<SessionRow, "max_cost_usd" | "permission_mode" | "budget_exhausted"> | null
): boolean {
  return (
    session !== null &&
    session.max_cost_usd !== null &&
    session.permission_mode !== "full_auto" &&
    session.budget_exhausted !== 1
  );
}
