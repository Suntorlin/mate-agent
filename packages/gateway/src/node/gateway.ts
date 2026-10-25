// The gateway in one Node process: the core app over a ledger in a SQLite file, with a timer
// for the ledger's alarm. A single process is the one writer the in-memory ledger needs.
import { createApp } from "../core/app";
import type { GatewayConfig } from "../core/config";
import { KEEPALIVE_MAX_BODY_BYTES, stashPing } from "../core/keepalive";
import { createLedgerFor, localClient } from "../core/ledger";
import { log } from "../core/log";
import type { Alarm } from "../core/sql";
import { openSqlite } from "./sqlite";

export function createNodeGateway(options: { config: GatewayConfig; databasePath: string }) {
  const { config } = options;
  const sql = openSqlite(options.databasePath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alarmAt: number | null = null;
  const alarm: Alarm = {
    get: async () => alarmAt,
    set: async (at) => {
      if (timer) clearTimeout(timer);
      alarmAt = at;
      timer = setTimeout(() => void fire(), Math.max(0, at - Date.now()));
      timer.unref();
    },
  };
  const ledger = createLedgerFor(config, { sql, alarm });
  const note = (message: string) => log({ msg: message });

  /** The alarm's time came: as on the Worker, it is cleared before the ledger's work runs. */
  async function fire(): Promise<void> {
    alarmAt = null;
    timer = null;
    await ledger.tick().catch((error: unknown) => note(`ledger: alarm failed: ${error}`));
  }

  // What runs after a response: kept so a test, or a shutdown, can wait for it.
  const inflight = new Set<Promise<unknown>>();
  const client = localClient(ledger);
  const app = createApp(() => ({
    config,
    ledger: client,
    waitUntil: (promise) => {
      const tracked = promise.catch((error: unknown) => note(`after a response: ${error}`));
      inflight.add(tracked);
      void tracked.finally(() => inflight.delete(tracked));
    },
    // SQLite in a file holds a ping body of any size the keep-alive takes.
    stashPing: (body) => stashPing(body, undefined, KEEPALIVE_MAX_BODY_BYTES),
  }));

  return {
    app,
    ledger,
    /** Picks up what the last run left: pending calls to settle and pings that are due. */
    start: () => fire(),
    /** Resolves once the work started after every response so far is done. */
    idle: async () => {
      while (inflight.size > 0) await Promise.all(inflight);
    },
    close(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      sql.close();
    },
  };
}

export type NodeGateway = ReturnType<typeof createNodeGateway>;
