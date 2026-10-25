/**
 * Credentials a session's sandbox renews while it runs. Spawn and snapshot restore hand the
 * sandbox fresh ones in its environment, but a sandbox resumed in place keeps the environment it
 * booted with, and these tokens are short-lived. Both routes take the sandbox's own token
 * (Authorization: Bearer SANDBOX_AUTH_TOKEN) and answer no-store.
 *
 * - `POST /sessions/:id/credentials` — the gateway layer anew (GATEWAY_URL, GATEWAY_TOKEN,
 *   ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY): 200 `{ env }`; 404 when the deployment has no
 *   gateway or the session no owner; 503 when the gateway is misconfigured. For a session a
 *   product's user owns, the token names that user (`app`), so the gateway reports its calls.
 * - `POST /sessions/:id/app-token` — a fresh token for the product's MCP server (`app`), minted
 *   for the product's user who owns the session: 200 `{ access_token, expires_at }` (epoch ms);
 *   404 when no product is configured or the owner is not one of its users; 503 when the
 *   product refuses.
 */

import { Hono } from "hono";
import { mintAppToken, readAppConfig, sessionAppUser } from "../app/product";
import { SessionIndexStore } from "../db/session-index";
import { readGatewayConfig } from "../gateway/config";
import { buildGatewaySandboxEnv } from "../gateway/sandbox-env";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:session-credentials");

async function handleGatewayCredentials(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = params.id;
  let gateway;
  try {
    gateway = readGatewayConfig(env);
  } catch (cause) {
    logger.error("session_credentials.misconfigured", {
      event: "session_credentials.misconfigured",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("The LLM gateway is not configured correctly", 503);
  }
  if (!gateway) return error("The deployment has no LLM gateway", 404);
  const owner = (await new SessionIndexStore(ctx.db).get(sessionId))?.userId;
  if (!owner) return error("The session has no owner", 404);
  const gatewayEnv = await buildGatewaySandboxEnv(gateway, {
    userId: owner,
    sessionId,
    nowMs: Date.now(),
    appUserId: await sessionAppUser(ctx.db, sessionId),
  });
  logger.info("session_credentials.issued", {
    event: "session_credentials.issued",
    session_id: sessionId,
    sandbox_id: ctx.principal.sandboxId ?? null,
  });
  return json({ env: gatewayEnv });
}

async function handleAppToken(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const config = readAppConfig(env);
  if (!config) return error("The deployment has no product", 404);
  const appUser = await sessionAppUser(ctx.db, params.id);
  if (!appUser) return error("The session owner is not a product user", 404);
  try {
    const { token, expiresAt } = await mintAppToken(config, appUser);
    return json({ access_token: token, expires_at: expiresAt });
  } catch (cause) {
    logger.warn("session_credentials.app_token_unavailable", {
      event: "session_credentials.app_token_unavailable",
      session_id: params.id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("The product did not issue a token", 503);
  }
}

export const sessionCredentialRoutes = new Hono<ControlPlaneHonoEnv>();

const SANDBOX = {
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  cacheControl: "no-store",
  authorization: NO_AUTHORIZATION,
} as const;

sessionCredentialRoutes.post("/sessions/:id/credentials", admit(SANDBOX), (c) =>
  dispatch(c, handleGatewayCredentials)
);
sessionCredentialRoutes.post("/sessions/:id/app-token", admit(SANDBOX), (c) =>
  dispatch(c, handleAppToken)
);
