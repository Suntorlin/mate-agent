/**
 * Credits: a new user starts with some, each turn costs what the engine says it cost, and a
 * user at zero or below cannot start another turn.
 *
 * The price of a turn is read from the engine, never from the browser: the engine records the
 * highest cumulative cost its runtime reported for each message (`costUsd` in the session's
 * message list). A turn is settled once the engine says it ended (completed, failed or
 * stopped), which happens when the relay sees `execution_complete`, and again whenever the
 * user's balance is read or a prompt is sent, so a turn missed while this backend was down is
 * still charged.
 */

import type { EngineClient, EngineMessage } from "./engine.ts";
import type { Store, Turn } from "./store.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

/** Whole credits for a cost in USD, rounded up so any paid turn costs at least one. */
export function creditsForCost(costUsd: number, creditsPerUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.ceil(costUsd * creditsPerUsd - 1e-9);
}

export function canStartTurn(credits: number): boolean {
  return credits > 0;
}

/** Settle the running turns the engine reports as ended. Returns the message ids settled. */
function settleFromMessages(
  store: Store,
  running: readonly Turn[],
  messages: readonly EngineMessage[],
  creditsPerUsd: number
): string[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const settled: string[] = [];
  for (const turn of running) {
    const message = byId.get(turn.messageId);
    if (!message || !TERMINAL_STATUSES.has(message.status)) continue;
    const costUsd = message.costUsd ?? 0;
    const done = store.settleTurn(turn.messageId, {
      engineStatus: message.status,
      runtime: message.runtime ?? null,
      costUsd,
      credits: creditsForCost(costUsd, creditsPerUsd),
    });
    if (done) settled.push(turn.messageId);
  }
  return settled;
}

/**
 * Settle every running turn of one user, asking the engine about each conversation that has
 * one. A conversation the engine cannot answer for is left for the next attempt.
 */
export async function settleUser(
  store: Store,
  engine: EngineClient,
  userId: string,
  creditsPerUsd: number,
  log: (message: string, error?: unknown) => void = () => {}
): Promise<string[]> {
  const settled: string[] = [];
  for (const conversation of store.conversationsWithRunningTurns(userId)) {
    const running = store.turns(conversation.id).filter((turn) => turn.status === "running");
    try {
      const messages = await engine.messages(userId, conversation.engineSessionId);
      settled.push(...settleFromMessages(store, running, messages, creditsPerUsd));
    } catch (error) {
      log(`settling conversation ${conversation.id} failed`, error);
    }
  }
  return settled;
}
