// Keeps a session's prompt cache alive across a silence. The cache lasts five minutes from its
// last read; a render or a generation that takes longer lets it lapse, and the next model call
// writes the whole conversation again at the write price (25 times the read). So when a session
// goes silent its last request is sent again for a single output token: that reads the cache,
// which renews it. While the agent runs a tool the next call is certain, so the pings go on for
// an hour (13 of them still cost half of one rewrite). After the agent finished its turn the
// creator may never come back, so only the first minutes are covered.
//
// The schedule lives in the ledger's SQLite, one row per session and model, due at its next
// ping; the ledger's alarm sends the pings that are due, a few per pass. The ping body is kept in
// the row when it fits the host's row limit; on the Worker a larger one goes to R2
// (KEEPALIVE_BUCKET), put there by the Worker itself, so the one ledger object never holds a
// conversation of many megabytes. Without a bucket, or over KEEPALIVE_MAX_BODY_BYTES, the session
// is not kept alive and a log line says so.
import type { BlobStore, SqlStore } from "./sql";

/** Inside the five-minute cache lifetime, with room for the ping itself. */
export const KEEPALIVE_INTERVAL_MS = 270_000;
/** While a tool runs: 13 pings keep the cache for an hour. */
export const KEEPALIVE_TOOL_PINGS = 13;
/** After the turn ended: 3 pings cover a creator who answers within about 19 minutes. */
export const KEEPALIVE_IDLE_PINGS = 3;
/** Below this many cached tokens a rewrite costs too little to be worth a ping. */
export const KEEPALIVE_MIN_CACHED_TOKENS = 20_000;
/** A conversation larger than this (inlined images) is not kept for a ping. */
export const KEEPALIVE_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Up to this size a ping body is kept in a Durable Object's SQLite row (which holds at most 2 MB). */
export const KEEPALIVE_MAX_ROW_BODY_BYTES = 1_900_000;
/** Pings one alarm pass sends (bodies in memory at once); the rest go on the next, right after. */
export const KEEPALIVE_PINGS_PER_PASS = 8;

/** Where a ping body is kept: in its row, or in the bucket under `bodyKey`. */
export type StashedPing = { body: string } | { bodyKey: string };

/** A session gone silent: its last call, and the ping that would renew its cache. */
export type KeepAliveCall = StashedPing & {
  sid: string;
  sub: string;
  model: string;
  /** Where the request went upstream. */
  url: string;
  headers: Record<string, string>;
};

/** A ping that is due: which session, and which of its pings this is. */
export interface DuePing {
  key: string;
  /** Set anew by every `waiting`, so a ping that was out while a newer call came is not repeated. */
  armed: string;
  sid: string;
  sub: string;
  model: string;
  url: string;
  headers: Record<string, string>;
  ping: number;
  maxPings: number;
}

/**
 * How many pings a session is due after a call: none unless the call left enough in the cache,
 * the long allowance when it ended in a tool call, the short one when it ended the turn.
 */
export function pingsAfter(
  stopReason: string | undefined,
  cachedTokens: number,
  allowance: { toolPings?: number; idlePings?: number } = {}
): number {
  if (cachedTokens < KEEPALIVE_MIN_CACHED_TOKENS) return 0;
  if (stopReason === "tool_use") return allowance.toolPings ?? KEEPALIVE_TOOL_PINGS;
  if (stopReason === "end_turn") return allowance.idlePings ?? KEEPALIVE_IDLE_PINGS;
  return 0;
}

/**
 * The same request, asking for one token: it reads the cache and says nothing. Only `max_tokens`
 * changes. Turning `stream` off as well made OpenRouter read a different cache entry for the
 * conversation (measured: the system prompt and tools were read, the messages written anew), so
 * the ping renewed its own copy and left the session's to expire.
 */
export function pingBody(body: Record<string, unknown>): string {
  return JSON.stringify({ ...body, max_tokens: 1 });
}

const encoder = new TextEncoder();

export type Stashed = StashedPing | { skipped: string; bytes: number };

/**
 * Where a silent session's ping body is kept, decided before the ledger hears of it: in its row
 * when it fits `maxRowBytes`, in the bucket when it does not and there is one, otherwise nowhere
 * (`skipped` says why).
 */
export async function stashPing(
  body: string,
  bucket: BlobStore | undefined,
  maxRowBytes = KEEPALIVE_MAX_ROW_BODY_BYTES
): Promise<Stashed> {
  const bytes = encoder.encode(body);
  const skipped = (reason: string) => ({ skipped: reason, bytes: bytes.byteLength });
  if (bytes.byteLength > KEEPALIVE_MAX_BODY_BYTES) {
    return skipped("body over KEEPALIVE_MAX_BODY_BYTES");
  }
  if (bytes.byteLength <= maxRowBytes) return { body };
  if (!bucket) return skipped("body too large for a row and no bucket");
  const bodyKey = `keepalive/${crypto.randomUUID()}`;
  try {
    await bucket.put(bodyKey, bytes);
  } catch (error) {
    return skipped(`storing the body in the bucket failed: ${error}`);
  }
  return { bodyKey };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS keepalive (
    key TEXT PRIMARY KEY,
    armed TEXT NOT NULL,
    sid TEXT NOT NULL,
    sub TEXT NOT NULL,
    model TEXT NOT NULL,
    url TEXT NOT NULL,
    headers TEXT NOT NULL,
    body TEXT,
    body_key TEXT,
    ping INTEGER NOT NULL,
    max_pings INTEGER NOT NULL,
    due_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS keepalive_due ON keepalive (due_at)",
];

export function createKeepAlive(options: {
  sql: SqlStore;
  /** Where ping bodies too large for a row were put. */
  bucket?: BlobStore;
  intervalMs?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}) {
  const { sql, bucket } = options;
  const intervalMs = options.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((fields: Record<string, unknown>) => console.log(fields));
  for (const statement of SCHEMA) sql.exec(statement);
  // One row per session and model: a side call on the small model leaves the main one's alone.
  const keyOf = (sid: string, model: string) => `${sid}\n${model}`;

  function forget(bodyKey: unknown): void {
    if (typeof bodyKey !== "string" || !bucket) return;
    bucket
      .delete(bodyKey)
      .catch((error: unknown) => log({ msg: `keepalive: deleting ${bodyKey} failed: ${error}` }));
  }

  /** Drops a session's row (only the one `armed` names, when given), and its body in R2. */
  function drop(key: string, armed?: string): void {
    const rows =
      armed === undefined
        ? sql.exec<{ body_key: string | null }>(
            "DELETE FROM keepalive WHERE key = ? RETURNING body_key",
            key
          )
        : sql.exec<{ body_key: string | null }>(
            "DELETE FROM keepalive WHERE key = ? AND armed = ? RETURNING body_key",
            key,
            armed
          );
    for (const row of rows) forget(row.body_key);
  }

  /** Every model call of the session: the agent is talking again, so no ping is due. */
  function seen(sid: string, model: string): void {
    drop(keyOf(sid, model));
  }

  /** The session went silent after `call`: ping it up to `maxPings` times. */
  function waiting(call: KeepAliveCall, maxPings: number): void {
    const key = keyOf(call.sid, call.model);
    drop(key);
    const bodyKey = "bodyKey" in call ? call.bodyKey : null;
    if (maxPings < 1) return forget(bodyKey);
    sql.exec(
      `INSERT OR REPLACE INTO keepalive
         (key, armed, sid, sub, model, url, headers, body, body_key, ping, max_pings, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      key,
      crypto.randomUUID(),
      call.sid,
      call.sub,
      call.model,
      call.url,
      JSON.stringify(call.headers),
      "body" in call ? call.body : null,
      bodyKey,
      maxPings,
      now() + intervalMs
    );
  }

  /** Up to `limit` pings due now, earliest first, each moved one interval on so no pass repeats it. */
  function claimDue(limit = KEEPALIVE_PINGS_PER_PASS): DuePing[] {
    const at = now();
    const due = sql
      .exec(
        `SELECT key, armed, sid, sub, model, url, headers, ping, max_pings
         FROM keepalive WHERE due_at <= ? ORDER BY due_at LIMIT ?`,
        at,
        limit
      )
      .map(
        (row): DuePing => ({
          key: String(row.key),
          armed: String(row.armed),
          sid: String(row.sid),
          sub: String(row.sub),
          model: String(row.model),
          url: String(row.url),
          headers: JSON.parse(String(row.headers)) as Record<string, string>,
          ping: Number(row.ping),
          maxPings: Number(row.max_pings),
        })
      );
    for (const ping of due) {
      sql.exec(
        "UPDATE keepalive SET due_at = ? WHERE key = ? AND armed = ?",
        at + intervalMs,
        ping.key,
        ping.armed
      );
    }
    return due;
  }

  /** The ping's body, or null when it is gone (the session moved on, or R2 lost it). */
  async function body(ping: DuePing): Promise<string | null> {
    const [row] = sql.exec<{ body: string | null; body_key: string | null }>(
      "SELECT body, body_key FROM keepalive WHERE key = ? AND armed = ?",
      ping.key,
      ping.armed
    );
    if (!row) return null;
    if (row.body !== null) return row.body;
    if (row.body_key === null || !bucket) return null;
    return bucket.get(row.body_key);
  }

  /** After a ping: the next one an interval from now, unless it failed or was the last. */
  function pinged(ping: DuePing, ok: boolean): void {
    if (!ok || ping.ping >= ping.maxPings) return drop(ping.key, ping.armed);
    sql.exec(
      "UPDATE keepalive SET ping = ping + 1, due_at = ? WHERE key = ? AND armed = ?",
      now() + intervalMs,
      ping.key,
      ping.armed
    );
  }

  /** Stops pinging a session (its user may not spend any more). */
  function stop(ping: DuePing): void {
    drop(ping.key, ping.armed);
  }

  /** When the next ping is due, or null when no session is waiting. */
  function nextDueAt(): number | null {
    const [row] = sql.exec<{ next: number | null }>("SELECT MIN(due_at) AS next FROM keepalive");
    return row?.next ?? null;
  }

  return { seen, waiting, claimDue, body, pinged, stop, nextDueAt };
}

export type KeepAlive = ReturnType<typeof createKeepAlive>;
