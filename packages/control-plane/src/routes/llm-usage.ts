/**
 * `GET /me/llm-usage` — the signed-in user's LLM spend this budget period.
 *
 * The LLM gateway owns each user's budget and ledger; this route asks it for
 * the caller's own row only (the gateway token it mints names the caller).
 *
 * 200 `{ period, periodStart, resetsAt, budgetUsd, spentUsd, remainingUsd }`;
 * 404 when no LLM gateway is configured; 502 when the gateway cannot answer.
 * Responses are private and no-store.
 */

import { Hono } from "hono";
import { readGatewayConfig } from "../gateway/config";
import { fetchLlmUsage } from "../gateway/usage";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  ACTIVE_SELF,
  error,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const logger = createLogger("router:llm-usage");

async function handleGetLlmUsage(
  _request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  let gateway;
  try {
    gateway = readGatewayConfig(env);
  } catch (cause) {
    logger.error("llm_usage.misconfigured", {
      event: "llm_usage.misconfigured",
      request_id: ctx.request_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Usage is unavailable", 502);
  }
  if (!gateway) return error("Usage is not available on this deployment", 404);

  try {
    return json(await fetchLlmUsage(gateway, { userId: ctx.principal.userId, nowMs: Date.now() }));
  } catch (cause) {
    logger.warn("llm_usage.unavailable", {
      event: "llm_usage.unavailable",
      request_id: ctx.request_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Usage is unavailable", 502);
  }
}

export const llmUsageRoutes = new Hono<ControlPlaneHonoEnv>();

llmUsageRoutes.get(
  "/me/llm-usage",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: ACTIVE_SELF,
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleGetLlmUsage)
);
