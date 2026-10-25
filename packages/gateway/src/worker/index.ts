// The gateway as a Cloudflare Worker: the HTTP surface (core/app.ts) over the ledger Durable
// Object, and the admin RPC entrypoint.
import { createApp } from "../core/app";
import { stashPing } from "../core/keepalive";
import type { FinishedCall, LedgerClient } from "../core/ledger";
import { type Env, configOf, ledgerOf } from "./env";
import { r2Blobs } from "./storage";

export { GatewayAdmin } from "./admin-rpc";
export { LedgerDO } from "./ledger-do";

/** How often a finished call is sent to the ledger when the object was reset under it. */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 200;

/**
 * The ledger object as the app reaches it, over RPC. A call with a generation id is counted once
 * however often it arrives, so a `record` whose answer was lost (the object reset for a deploy)
 * is tried again.
 */
function ledgerClient(env: Env): LedgerClient {
  const stub = ledgerOf(env) as unknown as LedgerClient;
  return {
    check: (sub, session) => stub.check(sub, session),
    usage: (sub) => stub.usage(sub),
    session: (sid, since, until) => stub.session(sid, since, until),
    overview: (period) => stub.overview(period),
    user: (sub, period) => stub.user(sub, period),
    setUser: (sub, patch, by, period) => stub.setUser(sub, patch, by, period),
    settings: () => stub.settings(),
    setSettings: (patch, by) => stub.setSettings(patch, by),
    snapshot: () => stub.snapshot(),
    async record(call: FinishedCall) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await stub.record(call);
          return;
        } catch (caught) {
          const retryable = (caught as { retryable?: unknown } | null)?.retryable === true;
          if (!retryable || call.generationId === undefined || attempt >= RECORD_ATTEMPTS) {
            throw caught;
          }
          await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_MS * attempt));
        }
      }
    },
  };
}

const app = createApp<{ Bindings: Env }>((c) => ({
  config: configOf(c.env),
  ledger: ledgerClient(c.env),
  waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  stashPing: (body) => stashPing(body, r2Blobs(c.env.KEEPALIVE_BUCKET)),
}));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
