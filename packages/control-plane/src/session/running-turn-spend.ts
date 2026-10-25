/**
 * What a session's running turn has cost so far, by the gateway's ledger.
 *
 * The Claude agent reports a turn's cost once, when the turn ends, so the session's stored total
 * (and the auto_within_budget cap on it) cannot see a long turn's model use while it runs. The gateway
 * records every call as it finishes; asked for the session's calls since the turn started, it
 * answers with what they cost. A gateway that cannot answer leaves the stored total standing: the
 * lookup answers null and says why in the log.
 */

import type { Logger } from "../logger";
import { readGatewayConfig } from "../gateway/config";
import { GatewayAdminError, fetchGatewaySessionSpend } from "../gateway/admin";
import type { TurnSpendSource } from "./running-turn-budget";

/** The lookup runs behind the event that prompted it, so it can wait longer than the spend route's. */
const LOOKUP_DEADLINE_MS = 5_000;
/** The control plane's clock and the gateway's can differ by a little. */
const WINDOW_END_MARGIN_MS = 2_000;
/** Who the lookups are made as, in the gateway's logs. */
const CONTROL_PLANE_ADMIN = "control-plane";

export function createGatewayRunningTurnSpend(
  env: Parameters<typeof readGatewayConfig>[0],
  options: {
    /** The public id of the session this object runs, which the gateway keys its ledger by. */
    readonly getSessionId: () => string;
    readonly log: Logger;
    readonly now?: () => number;
    readonly fetch?: typeof fetch;
  }
): TurnSpendSource | null {
  const { log } = options;
  const now = options.now ?? (() => Date.now());
  let gateway;
  try {
    gateway = readGatewayConfig(env);
  } catch (error) {
    log.error("running_turn_spend.misconfigured", {
      event: "running_turn_spend.misconfigured",
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
  if (!gateway) return null;

  return {
    async turnCost({ sinceMs, untilMs }) {
      const sessionId = options.getSessionId();
      try {
        const spend = await fetchGatewaySessionSpend(gateway, {
          adminUserId: CONTROL_PLANE_ADMIN,
          nowMs: now(),
          sessionId,
          sinceMs,
          untilMs: Math.max(sinceMs, untilMs) + WINDOW_END_MARGIN_MS,
          deadlineMs: LOOKUP_DEADLINE_MS,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        return spend.usd;
      } catch (error) {
        log.warn("running_turn_spend.unavailable", {
          event: "running_turn_spend.unavailable",
          session_id: sessionId,
          status: error instanceof GatewayAdminError ? (error.status ?? null) : null,
          error: error instanceof Error ? error : String(error),
        });
        return null;
      }
    },
  };
}
