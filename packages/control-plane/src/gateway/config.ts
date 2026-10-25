/**
 * The LLM gateway the deployment's sandboxes and its own model calls go through, when it has
 * one: GATEWAY_URL and GATEWAY_SECRET together, or neither. Sandboxes reach it at GATEWAY_URL
 * with a per-session token signed with GATEWAY_SECRET; the engine's own calls go through the
 * GATEWAY service binding when it runs as a Worker of the same account.
 */

import type { EnvConfig, Platform } from "../types";

const MINIMUM_GATEWAY_SECRET_LENGTH = 32;

export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigurationError";
  }
}

export interface GatewayConfig {
  /** Base URL without a trailing slash. */
  readonly url: string;
  readonly secret: string;
  /**
   * How the engine's own requests reach the gateway: through its service binding when it has one,
   * else the global `fetch` to `url`. Sandboxes always use `url`.
   */
  readonly fetch?: typeof fetch;
}

type GatewayEnv = Pick<EnvConfig, "GATEWAY_URL" | "GATEWAY_SECRET"> &
  Partial<Pick<Platform, "GATEWAY">>;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The deployment's gateway, or null when it has none. A partial or insecure configuration is an
 * error, never a silent disable.
 */
export function readGatewayConfig(env: GatewayEnv): GatewayConfig | null {
  const url = env.GATEWAY_URL?.trim();
  const secret = env.GATEWAY_SECRET?.trim();
  if (!url && !secret) return null;
  if (!url || !secret) {
    throw new GatewayConfigurationError(
      "GATEWAY_URL and GATEWAY_SECRET must be configured together"
    );
  }
  if (secret.length < MINIMUM_GATEWAY_SECRET_LENGTH) {
    throw new GatewayConfigurationError(
      `GATEWAY_SECRET must be at least ${MINIMUM_GATEWAY_SECRET_LENGTH} characters`
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayConfigurationError("GATEWAY_URL is not a valid URL");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    throw new GatewayConfigurationError("GATEWAY_URL must be HTTPS (plain HTTP only on loopback)");
  }
  const service = env.GATEWAY;
  return {
    url: url.replace(/\/+$/, ""),
    secret,
    ...(service ? { fetch: (input, init) => service.fetch(input, init) } : {}),
  };
}
