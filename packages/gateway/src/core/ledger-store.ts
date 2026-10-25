// The ledger in SQLite: the ledger Durable Object's, or the Node host's file. `requests` has one
// row per model call (the pending ones the backfill settles, and every call to reconcile
// against); `spend` holds the ledger's totals, one row per service total, session, user, and user
// in a period, written as the in-memory ledger has them after each settled call; `user_limits`
// holds admins' per-user overrides, `meta` the key-usage baseline, the admin's settings and the
// alerts sent. Opening reads the totals back instead of replaying every call, so a woken ledger
// is ready at once. Writes are synchronous and each save is one transaction, so what is persisted
// is always the in-memory ledger.
import {
  type BudgetSettings,
  type GatewayState,
  type Ledger,
  type LedgerStore,
  type RequestRecord,
  type RequestUsage,
  type SpendRow,
  type UserLimit,
  emptyLedger,
} from "./budget";
import type { SqlRow, SqlStore } from "./sql";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    sub TEXT NOT NULL,
    period TEXT NOT NULL,
    at TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS requests_status ON requests (status)",
  "CREATE INDEX IF NOT EXISTS requests_sid_at ON requests (sid, at)",
  // kind: total | session | user | period. `period` is the period of a period row, '' otherwise;
  // `id` the session or user, '' for the total; `owner` a session's user.
  `CREATE TABLE IF NOT EXISTS spend (
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    id TEXT NOT NULL,
    owner TEXT,
    usd REAL NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL,
    cache_creation_input_tokens INTEGER NOT NULL,
    last_at TEXT,
    PRIMARY KEY (kind, period, id)
  )`,
  "CREATE TABLE IF NOT EXISTS user_limits (sub TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

const USAGE_COLUMNS = [
  ["cost_usd", "cost"],
  ["input_tokens", "input_tokens"],
  ["output_tokens", "output_tokens"],
  ["cache_read_input_tokens", "cache_read_input_tokens"],
  ["cache_creation_input_tokens", "cache_creation_input_tokens"],
] as const;

type Row = SqlRow;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function fromRequestRow(row: Row): RequestRecord {
  const usage: RequestUsage = {};
  for (const [column, field] of USAGE_COLUMNS) {
    const value = row[column];
    if (typeof value === "number") usage[field] = value;
  }
  return {
    id: String(row.id),
    sid: String(row.sid),
    sub: String(row.sub),
    period: String(row.period),
    at: String(row.at),
    ...(typeof row.model === "string" && row.model ? { model: row.model } : {}),
    status: row.status as RequestRecord["status"],
    source: row.source as RequestRecord["source"],
    usage,
  };
}

function fromSpendRow(row: Row): SpendRow {
  return {
    ...(typeof row.last_at === "string" ? { last_at: row.last_at } : {}),
    usd: Number(row.usd),
    requests: Number(row.requests),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_input_tokens: Number(row.cache_read_input_tokens),
    cache_creation_input_tokens: Number(row.cache_creation_input_tokens),
  };
}

function loadLedger(sql: SqlStore): Ledger {
  const ledger = emptyLedger();
  const owners: Record<string, string> = {};
  for (const row of sql.exec<Row>("SELECT * FROM spend ORDER BY rowid")) {
    const spend = fromSpendRow(row);
    const id = String(row.id);
    if (row.kind === "total") ledger.total = spend;
    else if (row.kind === "session") {
      ledger.by_session[id] = spend;
      if (typeof row.owner === "string") owners[id] = row.owner;
    } else if (row.kind === "user") ledger.by_user[id] = spend;
    else if (row.kind === "period") (ledger.by_period[String(row.period)] ??= {})[id] = spend;
  }
  return Object.keys(owners).length > 0 ? { ...ledger, session_owner: owners } : ledger;
}

function meta(sql: SqlStore, key: string): unknown {
  const [row] = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  return row ? JSON.parse(row.value) : undefined;
}

function setMeta(sql: SqlStore, key: string, value: unknown): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value)
  );
}

/** Whether a call is on record already, pending or settled. */
export function hasRequest(sql: SqlStore, id: string): boolean {
  return sql.exec("SELECT 1 FROM requests WHERE id = ? LIMIT 1", id).length > 0;
}

/** What one session's calls cost over a stretch of time. */
export interface SessionWindow {
  /** The cost of the settled calls, in USD. */
  usd: number;
  /** Every call in the window, settled or not. */
  requests: number;
  /** The calls whose cost is not known yet (cut off, waiting for the backfill). */
  unsettled: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * The calls of session `sid` that finished between two times, in milliseconds since the epoch:
 * a call's `at` is the moment it was recorded, so a call belongs to the window it ended in.
 */
export function sessionSpendBetween(
  sql: SqlStore,
  sid: string,
  sinceMs: number,
  untilMs: number
): SessionWindow {
  const [row] = sql.exec<Row>(
    `SELECT COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN status = 'settled' THEN cost_usd END), 0) AS usd,
         COALESCE(SUM(status != 'settled'), 0) AS unsettled,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
       FROM requests WHERE sid = ? AND at >= ? AND at <= ?`,
    sid,
    new Date(sinceMs).toISOString(),
    new Date(untilMs).toISOString()
  );
  return {
    usd: Number(row.usd),
    requests: Number(row.requests),
    unsettled: Number(row.unsettled),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_input_tokens: Number(row.cache_read_input_tokens),
    cache_creation_input_tokens: Number(row.cache_creation_input_tokens),
  };
}

/** What a session has cost in all, and whose it is; null for a session the ledger has not seen. */
export function sessionTotal(
  sql: SqlStore,
  sid: string
): { sub: string | null; usd: number; requests: number; last_at: string | null } | null {
  const [row] = sql.exec<Row>(
    "SELECT owner, usd, requests, last_at FROM spend WHERE kind = 'session' AND id = ?",
    sid
  );
  if (!row) return null;
  return {
    sub: typeof row.owner === "string" ? row.owner : null,
    usd: Number(row.usd),
    requests: Number(row.requests),
    last_at: typeof row.last_at === "string" ? row.last_at : null,
  };
}

const ALERTS_PREFIX = "alerts:";

/** Opens the ledger in `sql`: the state it holds, and the store that keeps it current. */
export function openLedger(sql: SqlStore): {
  store: LedgerStore;
  state: GatewayState;
} {
  for (const statement of SCHEMA) sql.exec(statement);

  const pending: Record<string, RequestRecord> = {};
  for (const row of sql.exec<Row>(
    "SELECT * FROM requests WHERE status = 'pending' ORDER BY rowid"
  )) {
    const record = fromRequestRow(row);
    pending[record.id] = record;
  }
  const limits: Record<string, UserLimit> = {};
  for (const row of sql.exec<{ sub: string; data: string }>("SELECT sub, data FROM user_limits")) {
    limits[row.sub] = JSON.parse(row.data) as UserLimit;
  }
  const alerts: Record<string, number[]> = {};
  for (const row of sql.exec<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'alerts:%'"
  )) {
    alerts[row.key.slice(ALERTS_PREFIX.length)] = JSON.parse(row.value) as number[];
  }
  const baseline = meta(sql, "baseline") as { usd: number; at: string } | undefined;
  const settings = meta(sql, "settings") as BudgetSettings | undefined;
  const state: GatewayState = {
    ledger: loadLedger(sql),
    pending,
    limits,
    ...(settings ? { settings } : {}),
    alerts,
    ...(baseline ? { baseline_usd: baseline.usd, baseline_at: baseline.at } : {}),
  };

  function writeSpend(
    kind: string,
    period: string,
    id: string,
    row: SpendRow,
    owner: string | null = null
  ): void {
    sql.exec(
      `INSERT INTO spend (kind, period, id, owner, usd, requests, input_tokens, output_tokens,
         cache_read_input_tokens, cache_creation_input_tokens, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, period, id) DO UPDATE SET
         owner = excluded.owner, usd = excluded.usd, requests = excluded.requests,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         last_at = excluded.last_at`,
      kind,
      period,
      id,
      owner,
      row.usd,
      row.requests,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_input_tokens,
      row.cache_creation_input_tokens,
      row.last_at ?? null
    );
  }

  function writeRequest(record: RequestRecord): void {
    const { usage } = record;
    sql.exec(
      `INSERT INTO requests (id, sid, sub, period, at, model, status, source, cost_usd,
         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         sid = excluded.sid, sub = excluded.sub, period = excluded.period, at = excluded.at,
         model = excluded.model, status = excluded.status, source = excluded.source,
         cost_usd = excluded.cost_usd, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens`,
      record.id,
      record.sid,
      record.sub,
      record.period,
      record.at,
      record.model ?? null,
      record.status,
      record.source,
      ...USAGE_COLUMNS.map(([, field]) => numberOrNull(usage[field]))
    );
  }

  const store: LedgerStore = {
    saveBaseline(current) {
      const { baseline_usd: usd, baseline_at: at } = current;
      if (usd === undefined || !at) return;
      // The first baseline stays.
      sql.exec(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('baseline', ?)",
        JSON.stringify({ usd, at })
      );
    },
    saveRequest(record, current) {
      sql.transaction(() => {
        writeRequest(record);
        if (record.status !== "settled") return;
        const { ledger } = current;
        const { sid, sub, period } = record;
        writeSpend("total", "", "", ledger.total);
        writeSpend("session", "", sid, ledger.by_session[sid], ledger.session_owner?.[sid]);
        writeSpend("user", "", sub, ledger.by_user[sub]);
        writeSpend("period", period, sub, ledger.by_period[period][sub]);
      });
    },
    saveLimit(sub, limit) {
      sql.exec(
        "INSERT INTO user_limits (sub, data) VALUES (?, ?) ON CONFLICT (sub) DO UPDATE SET data = excluded.data",
        sub,
        JSON.stringify(limit)
      );
    },
    saveSettings(settings) {
      setMeta(sql, "settings", settings);
    },
    saveAlerts(month, sent) {
      setMeta(sql, `${ALERTS_PREFIX}${month}`, sent);
    },
  };

  return { store, state };
}
