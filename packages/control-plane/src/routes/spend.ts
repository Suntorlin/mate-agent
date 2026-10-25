/**
 * `GET /sessions/:id/spend` — what the session has spent and may still spend, in USD.
 *
 * A session runs either capped at a budget (`maxSessionCostUsd`) or uncapped (`full_auto`). The
 * session enforces the cap (`SessionBudgetService`); this route gives the sandbox the same
 * figures, so the agent can tell the user what the work has cost.
 *
 * The session's stored cost grows when the runtime reports a turn's cost, which for the Claude
 * agent is when the turn ends, so during a turn it misses the turn's model use. While a turn runs
 * this adds what the gateway's ledger has recorded for the session since the turn started, beyond
 * the share of the turn already stored. One gateway call with a short deadline; when the gateway
 * cannot answer, the stored cost is reported as it is.
 *
 * 200 `{ permissionMode, unlimited, budgetUsd, usedUsd, remainingUsd }`; `budgetUsd` and
 * `remainingUsd` are null when `unlimited`. Called with the sandbox token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { readGatewayConfig, type GatewayConfig } from "../gateway/config";
import { fetchGatewaySessionSpend } from "../gateway/admin";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import { dispatchSession } from "./session-route";
import { error, json, NO_AUTHORIZATION, SCM_AGNOSTIC_SANDBOX_ROUTE } from "./shared";

/** Short, because the sandbox waits for the answer. */
const RUNNING_TURN_LOOKUP_DEADLINE_MS = 1_500;
/** The control plane's clock and the gateway's can differ by a little. */
const WINDOW_END_MARGIN_MS = 2_000;
/** Who the lookups are made as, in the gateway's logs. */
const CONTROL_PLANE_ADMIN = "control-plane";

const logger = createLogger("router:spend");

const budgetStateSchema = z.object({
  permissionMode: z.string(),
  /** USD of the session's model calls, as stored. */
  totalCost: z.number(),
  maxSessionCostUsd: z.number().nullable(),
  budgetExhausted: z.boolean(),
  /** The running turn's start and the cost of it already in `totalCost`; null between turns. */
  runningTurn: z
    .object({ startedAt: z.number(), reportedCostUsd: z.number() })
    .nullable()
    .optional(),
});

/** The state as the session answers it. */
type BudgetState = z.infer<typeof budgetStateSchema>;
type Gateway = GatewayConfig;

/**
 * What the running turn's model calls cost beyond what the session total already holds of it,
 * by the gateway's ledger: the session's calls since the turn started, less the turn's cost the
 * runtime has already reported (so a turn is never counted twice, and nothing is added once it
 * has ended). Throws when the gateway cannot answer.
 */
export async function runningTurnExtraCostUsd(
  gateway: Gateway,
  input: {
    readonly sessionId: string;
    readonly turn: { readonly startedAt: number; readonly reportedCostUsd: number };
    readonly nowMs: number;
    readonly fetch?: typeof fetch;
  }
): Promise<number> {
  const spend = await fetchGatewaySessionSpend(gateway, {
    adminUserId: CONTROL_PLANE_ADMIN,
    nowMs: input.nowMs,
    sessionId: input.sessionId,
    sinceMs: input.turn.startedAt,
    untilMs: Math.max(input.turn.startedAt, input.nowMs) + WINDOW_END_MARGIN_MS,
    deadlineMs: RUNNING_TURN_LOOKUP_DEADLINE_MS,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  return Math.max(0, spend.usd - input.turn.reportedCostUsd);
}

/**
 * The session's state with the running turn's model use counted so far. Without a running turn
 * or a gateway, or when the gateway cannot answer, the stored total stands.
 */
export async function withRunningTurnCost(
  state: BudgetState,
  input: {
    readonly env: Parameters<typeof readGatewayConfig>[0];
    readonly sessionId: string;
    readonly nowMs: number;
    readonly fetch?: typeof fetch;
  }
): Promise<BudgetState> {
  const turn = state.runningTurn;
  if (!turn) return state;
  let gateway: Gateway | null;
  try {
    gateway = readGatewayConfig(input.env);
  } catch {
    gateway = null;
  }
  if (!gateway) return state;
  try {
    const extra = await runningTurnExtraCostUsd(gateway, { ...input, turn });
    return extra > 0 ? { ...state, totalCost: state.totalCost + extra } : state;
  } catch (error) {
    logger.warn("spend.running_turn_unavailable", {
      event: "spend.running_turn_unavailable",
      session_id: input.sessionId,
      error: error instanceof Error ? error : String(error),
    });
    return state;
  }
}

export interface SpendView {
  readonly permissionMode: string;
  readonly unlimited: boolean;
  readonly budgetUsd: number | null;
  readonly usedUsd: number;
  readonly remainingUsd: number | null;
}

export function spendView(state: BudgetState): SpendView {
  const unlimited = state.permissionMode === "full_auto" || state.maxSessionCostUsd === null;
  const budgetUsd = unlimited ? null : (state.maxSessionCostUsd ?? 0);
  return {
    permissionMode: state.permissionMode,
    unlimited,
    budgetUsd,
    usedUsd: state.totalCost,
    // Over the budget there is nothing left, never a negative figure.
    remainingUsd: budgetUsd === null ? null : Math.max(0, budgetUsd - state.totalCost),
  };
}

export const spendRoutes = new Hono<ControlPlaneHonoEnv>();

spendRoutes.get(
  "/sessions/:id/spend",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) =>
    dispatchSession(c, async (_request, env, params, ctx) => {
      const response = await ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.spend, {
        method: "GET",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return error("Session not found", response.status === 404 ? 404 : 502);
      }
      const state = budgetStateSchema.safeParse(await response.json());
      if (!state.success) return error("Session budget unavailable", 502);
      const live = await withRunningTurnCost(state.data, {
        env,
        sessionId: params.id,
        nowMs: Date.now(),
      });
      return json(spendView(live));
    })
);
