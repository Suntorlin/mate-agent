// Settles calls whose response was cut off before its end (Claude Code stopped, the user
// interrupted, the connection dropped). OpenRouter bills such a call for what was generated, but
// the stream never carried the cost, so the ledger would count it as $0. Each pending call is
// looked up by its generation id once OpenRouter knows it (a few seconds after the cut) and
// counted in the period it was made in. The ledger Durable Object runs a pass on its alarm, every
// BACKFILL_INTERVAL_MS while calls are pending.
import type { Budget, RequestUsage } from "./budget";

/** OpenRouter answers 404 for a generation id for a few seconds after the call ends. */
export const BACKFILL_MIN_AGE_MS = 5_000;
/** Past this, a call still unknown to OpenRouter is given up on and logged. */
export const BACKFILL_MAX_AGE_MS = 30 * 60_000;
export const BACKFILL_INTERVAL_MS = 5_000;

export function createBackfill(options: {
  budget: Budget;
  fetchGeneration: (id: string) => Promise<RequestUsage | null>;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  let running = false;

  /** One pass over the pending calls; overlapping passes are skipped. */
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const entry of options.budget.pendingRequests()) {
        const age = now() - Date.parse(entry.at);
        if (age < BACKFILL_MIN_AGE_MS) continue;
        let found: RequestUsage | null = null;
        try {
          found = await options.fetchGeneration(entry.id);
        } catch (error) {
          log(`backfill: lookup of ${entry.id} failed: ${error}`);
        }
        if (found) {
          options.budget.settle(entry.id, found);
          log(`backfill: settled ${entry.id} for ${entry.sub} at $${found.cost}`);
        } else if (age > BACKFILL_MAX_AGE_MS) {
          options.budget.abandon(entry.id);
          log(`backfill: gave up on ${entry.id} for ${entry.sub}: no cost after ${age} ms`);
        }
      }
    } finally {
      running = false;
    }
  }

  return { tick };
}
