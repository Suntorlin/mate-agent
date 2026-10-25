// The Worker's bindings, and the configuration and ledger they give a request.
import { type GatewayConfig, type GatewayVars, parseConfig } from "../core/config";
import type { LedgerDO } from "./ledger-do";

export interface Env extends GatewayVars {
  /** The ledger Durable Object; one instance, named LEDGER_NAME. */
  LEDGER: DurableObjectNamespace<LedgerDO>;
  /** Keep-alive ping bodies too large for a SQLite row. */
  KEEPALIVE_BUCKET?: R2Bucket;
}

const parsed = new WeakMap<Env, GatewayConfig>();

/** The configuration for `env`, parsed once per bindings object. Throws a ConfigError. */
export function configOf(env: Env): GatewayConfig {
  let config = parsed.get(env);
  if (!config) {
    config = parseConfig(env);
    parsed.set(env, config);
  }
  return config;
}

/** The one ledger Durable Object every request goes through. */
export const LEDGER_NAME = "global";

export function ledgerOf(env: Env): DurableObjectStub<LedgerDO> {
  return env.LEDGER.get(env.LEDGER.idFromName(LEDGER_NAME));
}
