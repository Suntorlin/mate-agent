// Reports each settled model call of a product's user to the product (LLM_USAGE_REPORT_URL), so
// the product can bill it: the gateway says what the call cost, the product decides what to
// charge. A call is reported when its session's gateway token named the product's user (the
// `app` claim, which the control plane sets for a session an `app:<id>` user owns), and only once
// it has its cost: a finished call at once, a cut-off call when the backfill settles it, and every
// cache keep-alive ping. A call that never gets a cost is never reported.
//
// Reports wait in the ledger's SQLite and the ledger's alarm sends them, so one survives a restart
// and a product that is down. A failed POST is tried again after 30 s, doubling to an hour, up to
// USAGE_REPORT_MAX_ATTEMPTS times. A report the product refuses as malformed (400, 404, 422), or
// one that keeps failing, stays in `usage_reports` as dead, with its last error, to reconcile by
// hand. The product must be idempotent on request_id: sending a report again is safe.
import type { RequestRecord, createBudget } from "./budget";
import type { SqlStore } from "./sql";

/** How many times one report is POSTed before it is dead. */
export const USAGE_REPORT_MAX_ATTEMPTS = 12;
/** The delay before the second attempt; it doubles per attempt up to USAGE_REPORT_MAX_DELAY_MS. */
export const USAGE_REPORT_FIRST_DELAY_MS = 30_000;
export const USAGE_REPORT_MAX_DELAY_MS = 60 * 60 * 1000;
/** How many due reports one alarm sends, side by side. */
const USAGE_REPORT_BATCH = 25;
const USAGE_REPORT_TIMEOUT_MS = 10_000;
/** Answers that mean the report itself is wrong: sending it again cannot help. */
const REFUSED_STATUSES = new Set([400, 404, 422]);
// Cloudflare in front of a product rejects some default client agents (error 1010).
const USER_AGENT = "agent-engine-gateway/1 (usage-report)";

const SCHEMA = [
  // Which product user a session belongs to, as its calls' tokens named it.
  "CREATE TABLE IF NOT EXISTS usage_report_sessions (sid TEXT PRIMARY KEY, app TEXT NOT NULL)",
  // One row per report not yet accepted; `next_at` is null once the report is dead.
  `CREATE TABLE IF NOT EXISTS usage_reports (
    request_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_at INTEGER,
    last_error TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS usage_reports_next_at ON usage_reports (next_at)",
];

/** The body POSTed to LLM_USAGE_REPORT_URL: one model call, as the product bills it. */
export interface UsageReport {
  /** The call's id in the gateway's ledger (OpenRouter's generation id when there was one). */
  request_id: string;
  /** The product's own user id (the token's `app` claim). */
  user_id: string;
  session_id: string;
  model: string | null;
  usd_cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** When the call was made, ISO 8601. */
  occurred_at: string;
}

export interface UsageReporter {
  /** Notes the product user a session belongs to, from one of its calls' tokens. */
  remember(sid: string, app: string): void;
  /** Queues a settled call, when its session belongs to a product user. */
  queue(record: RequestRecord): void;
  /** When the next report is due, or null when none waits. */
  nextDueAt(): number | null;
  /** Sends the reports that are due. Never rejects. */
  send(): Promise<void>;
  /** The reports not yet accepted: waiting to be sent, or dead. */
  stats(): { waiting: number; dead: number };
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function usageReportOf(record: RequestRecord, app: string): UsageReport {
  return {
    request_id: record.id,
    user_id: app,
    session_id: record.sid,
    model: record.model ?? null,
    usd_cost: num(record.usage.cost),
    input_tokens: num(record.usage.input_tokens),
    output_tokens: num(record.usage.output_tokens),
    cache_read_input_tokens: num(record.usage.cache_read_input_tokens),
    cache_creation_input_tokens: num(record.usage.cache_creation_input_tokens),
    occurred_at: record.at,
  };
}

/** The delay before attempt `attempts + 1`. */
export function usageReportDelayMs(attempts: number): number {
  return Math.min(USAGE_REPORT_FIRST_DELAY_MS * 2 ** (attempts - 1), USAGE_REPORT_MAX_DELAY_MS);
}

export function createUsageReporter(options: {
  sql: SqlStore;
  url: string;
  token: string;
  now: () => number;
  log: (message: string) => void;
  fetch?: typeof fetch;
}): UsageReporter {
  const { sql, now, log } = options;
  const doFetch = options.fetch ?? fetch;
  for (const statement of SCHEMA) sql.exec(statement);
  const known = new Map<string, string>();

  function productUser(sid: string): string | null {
    const cached = known.get(sid);
    if (cached) return cached;
    const [row] = sql.exec<{ app: string }>(
      "SELECT app FROM usage_report_sessions WHERE sid = ?",
      sid
    );
    if (row) known.set(sid, row.app);
    return row?.app ?? null;
  }

  /** Sends one report; the outcome is written back to its row. */
  async function deliver(row: { request_id: string; body: string; attempts: number }) {
    const attempts = row.attempts + 1;
    let failure: string;
    let refused = false;
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
          "user-agent": USER_AGENT,
        },
        body: row.body,
        signal: AbortSignal.timeout(USAGE_REPORT_TIMEOUT_MS),
      });
      if (response.ok) {
        sql.exec("DELETE FROM usage_reports WHERE request_id = ?", row.request_id);
        return;
      }
      refused = REFUSED_STATUSES.has(response.status);
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      failure = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
    } catch (error) {
      failure = String(error);
    }
    const dead = refused || attempts >= USAGE_REPORT_MAX_ATTEMPTS;
    sql.exec(
      "UPDATE usage_reports SET attempts = ?, next_at = ?, last_error = ? WHERE request_id = ?",
      attempts,
      dead ? null : now() + usageReportDelayMs(attempts),
      failure,
      row.request_id
    );
    if (dead) {
      log(
        `usage-report: gave up on request_id ${row.request_id} after ${attempts} attempts: ${failure}`
      );
    }
  }

  return {
    remember(sid, app) {
      if (known.get(sid) === app) return;
      sql.exec(
        `INSERT INTO usage_report_sessions (sid, app) VALUES (?, ?)
         ON CONFLICT (sid) DO UPDATE SET app = excluded.app`,
        sid,
        app
      );
      known.set(sid, app);
    },

    queue(record) {
      const app = productUser(record.sid);
      if (!app) return;
      sql.exec(
        `INSERT INTO usage_reports (request_id, body, attempts, next_at) VALUES (?, ?, 0, ?)
         ON CONFLICT (request_id) DO NOTHING`,
        record.id,
        JSON.stringify(usageReportOf(record, app)),
        now()
      );
    },

    nextDueAt() {
      const [row] = sql.exec<{ next: number | null }>(
        "SELECT MIN(next_at) AS next FROM usage_reports WHERE next_at IS NOT NULL"
      );
      return typeof row?.next === "number" ? row.next : null;
    },

    async send() {
      const due = sql.exec<{ request_id: string; body: string; attempts: number }>(
        `SELECT request_id, body, attempts FROM usage_reports
         WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?`,
        now(),
        USAGE_REPORT_BATCH
      );
      await Promise.all(
        due.map((row) =>
          deliver(row).catch((error: unknown) =>
            log(`usage-report: request_id ${row.request_id}: ${error}`)
          )
        )
      );
    },

    stats() {
      const [row] = sql.exec<{ waiting: number; dead: number }>(
        `SELECT COUNT(next_at) AS waiting, COUNT(*) - COUNT(next_at) AS dead FROM usage_reports`
      );
      return { waiting: num(row?.waiting), dead: num(row?.dead) };
    },
  };
}

type Budget = ReturnType<typeof createBudget>;

/**
 * The budget with usage reports attached: `record` and `settle` work as before, and each call
 * they settle is also queued for the product. Without a reporter the budget is returned as is.
 */
export function withUsageReports(budget: Budget, reporter: UsageReporter | null): Budget {
  if (!reporter) return budget;
  return {
    ...budget,
    record(...args: Parameters<Budget["record"]>) {
      const entry = budget.record(...args);
      // A call without a cost waits as pending; it is queued when `settle` gives it one.
      if (entry.status === "settled") reporter.queue(entry);
      return entry;
    },
    settle(...args: Parameters<Budget["settle"]>) {
      const entry = budget.settle(...args);
      if (entry) reporter.queue(entry);
      return entry;
    },
  };
}
