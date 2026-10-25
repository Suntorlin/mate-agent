/**
 * What a turn of a session cost, by the gateway's ledger.
 *
 * The agent in the sandbox reports its own figure for a turn: the Claude CLI's running total,
 * priced from a table of Claude models. For a model it does not know (the economy tier runs
 * others) it falls back to a price far above the real one, and sessions looked 17-25 times as
 * expensive as the gateway billed them. The gateway sees every call and the cost OpenRouter
 * charged for it, and platform-api bills from that, so the session's budget should run on it too.
 *
 * Asked for the calls a session made between two times, the gateway answers with their cost. A
 * gateway that does not know the route (the Node one), one that cannot be reached, and a window
 * with no recorded call all leave the agent's own figure standing.
 */

import type { Logger } from "../logger";
import { readGatewayConfig } from "../gateway/config";
import { GatewayAdminError, fetchGatewaySessionSpend } from "../gateway/admin";

/** Short, because a turn's completion waits for the answer; one that never came is asked for once more. */
const LOOKUP_DEADLINE_MS = 2_000;
const RETRY_DELAY_MS = 250;
/** A gateway without the route is not asked again for a while. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;
/** After two lookups without an answer the agent's figure is used for a while, so turns do not wait. */
const FAILURE_PAUSE_MS = 20_000;
/** The control plane's clock and the gateway's can differ by a little; calls end before it. */
const WINDOW_END_MARGIN_MS = 2_000;
/** Who the lookups are made as, in the gateway's logs. */
const CONTROL_PLANE_ADMIN = "control-plane";

/** Replaces the agent's figure for a turn with a better one, when there is one. */
export interface TurnCostSource {
  /**
   * The cost in USD of the calls the session made from `sinceMs` to `untilMs`, or null when
   * there is no better figure than the agent's own.
   */
  turnCost(window: { sinceMs: number; untilMs: number }): Promise<number | null>;
}

export function createGatewayTurnCostSource(
  env: Parameters<typeof readGatewayConfig>[0],
  options: {
    /** The public id of the session this object runs, which the gateway keys its ledger by. */
    getSessionId: () => string;
    log: Logger;
    now?: () => number;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }
): TurnCostSource | null {
  const { log } = options;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let gateway;
  try {
    gateway = readGatewayConfig(env);
  } catch (error) {
    log.error("turn_cost.misconfigured", {
      event: "turn_cost.misconfigured",
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
  if (!gateway) return null;

  let pausedUntil = 0;
  return {
    async turnCost({ sinceMs, untilMs }) {
      const at = now();
      if (at < pausedUntil) return null;
      const sessionId = options.getSessionId();
      const ask = () =>
        fetchGatewaySessionSpend(gateway, {
          adminUserId: CONTROL_PLANE_ADMIN,
          nowMs: at,
          sessionId,
          sinceMs,
          untilMs: untilMs + WINDOW_END_MARGIN_MS,
          deadlineMs: LOOKUP_DEADLINE_MS,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      try {
        let spend;
        try {
          spend = await ask();
        } catch (error) {
          // An answer that never came (a slow start, a connection lost on the way) is asked for
          // once more; one the gateway gave (a status, a body that does not parse) is not.
          if (!(error instanceof GatewayAdminError) || error.status !== undefined) throw error;
          if (!(error.cause instanceof Error)) throw error;
          log.info("turn_cost.retry", {
            event: "turn_cost.retry",
            session_id: sessionId,
            cause: describe(error),
          });
          await sleep(RETRY_DELAY_MS);
          spend = await ask();
        }
        // A turn always makes a call. None on record means this ledger has not seen the turn (not
        // yet, or never), so its zero says nothing.
        if (spend.requests === 0) {
          log.info("turn_cost.no_calls", {
            event: "turn_cost.no_calls",
            session_id: sessionId,
          });
          return null;
        }
        if (spend.unsettled > 0) {
          log.info("turn_cost.unsettled", {
            event: "turn_cost.unsettled",
            session_id: sessionId,
            unsettled: spend.unsettled,
          });
        }
        return spend.usd;
      } catch (error) {
        const status = error instanceof GatewayAdminError ? error.status : undefined;
        if (status === 404 || status === 405 || status === 501) {
          pausedUntil = at + UNSUPPORTED_RETRY_MS;
          log.info("turn_cost.unsupported", {
            event: "turn_cost.unsupported",
            session_id: sessionId,
            status,
          });
        } else {
          pausedUntil = at + FAILURE_PAUSE_MS;
          log.warn("turn_cost.unavailable", {
            event: "turn_cost.unavailable",
            session_id: sessionId,
            status: status ?? null,
            cause: describe(error),
            error: error instanceof Error ? error : String(error),
          });
        }
        return null;
      }
    },
  };
}

/** What went wrong, with the wrapped cause: the wrapper's own message says only "request failed". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause =
    error.cause instanceof Error ? ` <- ${error.cause.name}: ${error.cause.message}` : "";
  return `${error.name}: ${error.message}${cause}`;
}
