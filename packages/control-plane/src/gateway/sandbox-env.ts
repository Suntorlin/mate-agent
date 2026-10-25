/**
 * The gateway layer of a sandbox's environment.
 *
 * With a gateway, a sandbox reaches its model only through it: the Claude harness runs in
 * API-key mode against ANTHROPIC_BASE_URL=<gateway>/llm with a per-session gateway token as the
 * key, so the deployment's model key never enters a sandbox. The token contract is shared with
 * the gateway (packages/gateway): HS256 over GATEWAY_SECRET, claims `{ sub, sid, iat, exp }`
 * with a GATEWAY_TOKEN_TTL_SECONDS lifetime.
 */

import { mintJwt } from "../auth/jwt";
import type { GatewayConfig } from "./config";

/**
 * Short, so a token taken out of a sandbox is soon worth nothing: the agent can read it, and it
 * spends the user's budget. Sessions run far longer; the Claude harness has Claude Code ask
 * `gateway-key` for the token, which renews it through `POST /sessions/:id/credentials` well
 * before it expires.
 */
export const GATEWAY_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * The models Claude Code's family aliases resolve to when a prompt names no model; its own
 * default is the sonnet alias. The gateway serves exactly the versioned model Claude Code
 * requests, so a model picked for the session runs as is.
 */
const GATEWAY_CLAUDE_MODEL_ENV = {
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
  ANTHROPIC_MODEL: "sonnet",
} as const;

/**
 * Provider credentials a gateway sandbox must not carry: a real provider key or a managed-OAuth
 * marker in the environment would either bypass the gateway or switch the harness out of
 * API-key mode.
 */
const STRIPPED_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_MANAGED",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const STRIPPED_PROVIDER_ENV_PREFIXES = ["CLAUDE_CODE_OAUTH_"] as const;

export interface GatewayClaims {
  readonly sub: string;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
  /** The product's own id for the owner of the session, when a product's user owns it. */
  readonly app?: string;
}

export interface GatewayTokenInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly nowMs: number;
  /** The product's id for the user (`app:<id>`); the gateway reports their calls to the product. */
  readonly appUserId?: string | null;
}

export async function mintGatewayToken(
  secret: string,
  input: GatewayTokenInput
): Promise<{ token: string; claims: GatewayClaims }> {
  const iat = Math.floor(input.nowMs / 1000);
  const claims: GatewayClaims = {
    sub: input.userId,
    sid: input.sessionId,
    iat,
    exp: iat + GATEWAY_TOKEN_TTL_SECONDS,
    ...(input.appUserId ? { app: input.appUserId } : {}),
  };
  return { token: await mintJwt({ ...claims }, secret), claims };
}

/** The gateway variables for one bridge start or renewal; the token in it is freshly issued. */
export async function buildGatewaySandboxEnv(
  config: GatewayConfig,
  input: GatewayTokenInput
): Promise<Record<string, string>> {
  const { token } = await mintGatewayToken(config.secret, input);
  return {
    GATEWAY_URL: config.url,
    GATEWAY_TOKEN: token,
    ANTHROPIC_BASE_URL: `${config.url}/llm`,
    ANTHROPIC_API_KEY: token,
    ...GATEWAY_CLAUDE_MODEL_ENV,
  };
}

/**
 * Overlay the gateway layer on an assembled sandbox environment. The provider credentials go
 * first, so no user or global secret can shadow or bypass the gateway; its values then win over
 * any same-named secret.
 */
export function applyGatewaySandboxEnv(
  base: Record<string, string>,
  gatewayEnv: Record<string, string>
): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) =>
        !(
          (STRIPPED_PROVIDER_ENV_KEYS as readonly string[]).includes(key) ||
          STRIPPED_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
        )
    )
  );
  return { ...kept, ...gatewayEnv };
}
