// The ledger, whichever host runs it: the budget over its SQLite, the backfill of cut-off calls,
// the cache keep-alive and the usage reports to the product, which share one alarm. The Worker's
// ledger Durable Object (worker/ledger-do.ts) and the Node host (node/gateway.ts) build it over
// their own storage; tests build it over a scratch database with their own clock and fakes.
import { BACKFILL_INTERVAL_MS, createBackfill } from "./backfill";
import { type BudgetDecision, type BudgetPeriod, type RequestUsage, createBudget } from "./budget";
import { type DuePing, type StashedPing, createKeepAlive } from "./keepalive";
import { hasRequest, openLedger, sessionSpendBetween, sessionTotal } from "./ledger-store";
import { type Log, log as defaultLog } from "./log";
import type { Alarm, BlobStore, SqlStore } from "./sql";
import type { GatewayConfig } from "./config";
import { fetchGeneration, fetchKeyUsage, sendPing } from "./upstream";
import { createUsageReporter, withUsageReports } from "./usage-reports";

/** A forwarded Messages call, as the app reports it once its response is through. */
export interface FinishedCall {
  sid: string;
  sub: string;
  /** The product's user the session belongs to (the token's `app` claim), when there is one. */
  app?: string;
  model: string;
  /** What to count: the call's usage, or {} when it is pending under `generationId`. */
  usage?: RequestUsage;
  /** OpenRouter's id for the call; a call sent again under the same id is counted once. */
  generationId?: string;
  /** The session went silent after this call: renew its cache with up to `pings` pings. */
  keepAlive?: StashedPing & { url: string; headers: Record<string, string>; pings: number };
}

export interface UserPatch {
  budget_usd?: number | null;
  blocked?: boolean;
}

export interface SettingsPatch {
  monthly_budget_usd?: number | null;
  user_budget_usd?: number | null;
  key_budget_usd?: number | null;
}

export interface LedgerOptions {
  sql: SqlStore;
  alarm: Alarm;
  budgetUsd: number;
  userBudgetUsd: number;
  monthlyBudgetUsd: number | null;
  userBudgetPeriod: BudgetPeriod;
  /** Where ping bodies too large for a SQLite row were put. */
  bucket?: BlobStore;
  keepAliveIntervalMs?: number;
  fetchKeyUsage: () => Promise<number>;
  fetchGeneration: (id: string) => Promise<RequestUsage | null>;
  sendPing: (
    ping: DuePing,
    body: string
  ) => Promise<{ usage: RequestUsage | null; generationId?: string } | null>;
  alert?: (message: string) => void;
  /** Where each settled call of a product's user is reported (LLM_USAGE_REPORT_URL). */
  usageReport?: { url: string; token: string; fetch?: typeof fetch };
  now?: () => number;
  log?: Log;
}

export function createLedger(options: LedgerOptions) {
  const { sql, alarm } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? defaultLog;
  const note = (message: string) => log({ msg: message });
  const reporter = options.usageReport
    ? createUsageReporter({ sql, ...options.usageReport, now, log: note })
    : null;
  const budget = withUsageReports(
    createBudget({
      budgetUsd: options.budgetUsd,
      userBudgetUsd: options.userBudgetUsd,
      monthlyBudgetUsd: options.monthlyBudgetUsd,
      userBudgetPeriod: options.userBudgetPeriod,
      alert: options.alert,
      ledger: openLedger(sql),
      fetchKeyUsage: options.fetchKeyUsage,
      now,
      log: note,
    }),
    reporter
  );
  const backfill = createBackfill({
    budget,
    fetchGeneration: options.fetchGeneration,
    now,
    log: note,
  });
  const keepAlive = createKeepAlive({
    sql,
    bucket: options.bucket,
    intervalMs: options.keepAliveIntervalMs,
    now,
    log,
  });

  /** Sets the alarm for the next work: a due ping or usage report, or the next backfill pass. */
  async function schedule(): Promise<void> {
    const backfillAt = budget.pendingRequests().length > 0 ? now() + BACKFILL_INTERVAL_MS : null;
    const due = [keepAlive.nextDueAt(), backfillAt, reporter?.nextDueAt() ?? null].filter(
      (at): at is number => at !== null
    );
    if (due.length === 0) return;
    const next = Math.min(...due);
    const current = await alarm.get();
    if (current === null || current > next) await alarm.set(next);
  }

  async function ping(due: DuePing): Promise<void> {
    // The user may not spend any more: the session gets no ping.
    if (!(await budget.check(due.sub)).allowed) return keepAlive.stop(due);
    const body = await keepAlive.body(due);
    if (body === null) return keepAlive.stop(due);
    const sent = await options.sendPing(due, body).catch(() => null);
    const usage = sent?.usage ?? null;
    if (usage) {
      budget.record(due.sid, due.sub, usage, { id: sent?.generationId, model: due.model });
    }
    log({
      sid: due.sid,
      sub: due.sub,
      path: new URL(due.url).pathname,
      model: due.model,
      keepalive: due.ping,
      status: usage ? 200 : 502,
      cost: usage?.cost ?? null,
      cache_read: usage?.cache_read_input_tokens ?? null,
      cache_write: usage?.cache_creation_input_tokens ?? null,
    });
    keepAlive.pinged(due, usage !== null);
  }

  return {
    /** The budget's decision for one more call; an allowed Messages call cancels its session's pings. */
    async check(sub: string, session?: { sid: string; model: string }): Promise<BudgetDecision> {
      const decision = await budget.check(sub);
      if (decision.allowed && session) keepAlive.seen(session.sid, session.model);
      return decision;
    },

    /** Counts a finished call and, when its session went silent, schedules its pings. */
    async record(call: FinishedCall): Promise<void> {
      // Before the budget records it: a settled call is queued for the product's user at once.
      if (call.app) reporter?.remember(call.sid, call.app);
      // The Worker sends a call again when the answer to the first send was lost.
      const known = call.generationId !== undefined && hasRequest(sql, call.generationId);
      if (call.usage && !known) {
        budget.record(call.sid, call.sub, call.usage, { id: call.generationId, model: call.model });
      }
      if (call.keepAlive) {
        const { url, headers, pings } = call.keepAlive;
        const stashed: StashedPing =
          "bodyKey" in call.keepAlive
            ? { bodyKey: call.keepAlive.bodyKey }
            : { body: call.keepAlive.body };
        keepAlive.waiting(
          { sid: call.sid, sub: call.sub, model: call.model, url, headers, ...stashed },
          pings
        );
      }
      // The call is on record by now: a failure from here on must not read as a lost call.
      await schedule().catch((error: unknown) =>
        note(`ledger: setting the alarm failed: ${error}`)
      );
    },

    /**
     * The alarm's work: settle what the backfill can, send the pings and the usage reports that
     * are due. A call settled on this tick is reported on the next, which `schedule` sets at once.
     */
    async tick(): Promise<void> {
      // Side by side: slow lookups must not hold a ping past the cache's lifetime. A ping that
      // fails (its body unreadable) is tried again an interval later, like any other.
      const pings = keepAlive
        .claimDue()
        .map((due) =>
          ping(due).catch((error: unknown) =>
            note(`keepalive: ping ${due.ping} of ${due.sid} failed: ${error}`)
          )
        );
      await Promise.all([backfill.tick(), reporter?.send(), ...pings]);
      await schedule();
    },

    usage: (sub: string) => budget.usageFor(sub),
    /**
     * What one session's calls that finished between two times cost (the control plane asks for
     * a turn's window), and what the session has cost in all.
     */
    session: (sid: string, sinceMs: number, untilMs: number) => ({
      sid,
      since: sinceMs,
      until: untilMs,
      ...sessionSpendBetween(sql, sid, sinceMs, untilMs),
      total: sessionTotal(sql, sid),
    }),
    /** The budget's overview, with the usage reports not yet accepted (null when they are off). */
    overview: async (period?: string) => ({
      ...(await budget.adminOverview(period)),
      usage_reports: reporter?.stats() ?? null,
    }),
    user: (sub: string, period?: string) => ({
      ...budget.adminUser(sub, period),
      sessions: budget.adminSessions(sub),
    }),
    setUser(sub: string, patch: UserPatch, by: string, period?: string) {
      budget.setLimit(sub, patch, by);
      return budget.adminUser(sub, period);
    },
    async settings() {
      return budget.adminSettings(await budget.keySpent());
    },
    async setSettings(patch: SettingsPatch, by: string) {
      budget.setSettings(patch, by);
      return budget.adminSettings(await budget.keySpent());
    },
    snapshot: () => budget.snapshot(),
  };
}

export type LedgerCore = ReturnType<typeof createLedger>;

const ALERT_TIMEOUT_MS = 10_000;

/**
 * The ledger a host runs for `config`: OpenRouter for the key usage, the generation lookups and
 * the pings, and the Lark (Feishu) webhook for the monthly-budget alerts. Logs its settings.
 */
export function createLedgerFor(
  config: GatewayConfig,
  storage: { sql: SqlStore; alarm: Alarm; bucket?: BlobStore }
): LedgerCore {
  const note = (message: string) => defaultLog({ msg: message });
  const { alertWebhook, usageReport } = config;
  const ledger = createLedger({
    ...storage,
    ...(usageReport ? { usageReport } : {}),
    budgetUsd: config.budgetUsd,
    userBudgetUsd: config.userBudgetUsd,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    userBudgetPeriod: config.userBudgetPeriod,
    fetchKeyUsage: () => fetchKeyUsage(config.upstreamBase, config.apiKey),
    fetchGeneration: (id) => fetchGeneration(config.upstreamBase, config.apiKey, id),
    sendPing: (ping, body) => sendPing(ping.url, body, ping.headers, config.apiKey),
    ...(alertWebhook
      ? {
          alert: (message: string) => {
            void fetch(alertWebhook, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ msg_type: "text", content: { text: message } }),
              signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
            }).catch((error: unknown) => note(`budget: alert webhook failed: ${error}`));
          },
        }
      : {}),
  });
  const monthly = config.monthlyBudgetUsd === null ? "none" : `$${config.monthlyBudgetUsd}`;
  note(
    `gateway ledger: budget $${config.budgetUsd}, monthly ${monthly}, alerts ${alertWebhook ? "on" : "off"}, per user $${config.userBudgetUsd} a ${config.userBudgetPeriod}, cache keep-alive ${config.keepAlive ? "on" : "off"}, usage reports ${usageReport ? "on" : "off"}`
  );
  return ledger;
}

/** The ledger as the app reaches it: every operation asynchronous, as over the Worker's RPC. */
export type LedgerClient = {
  [K in Exclude<keyof LedgerCore, "tick">]: LedgerCore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** The ledger in this process as a LedgerClient. */
export function localClient(ledger: LedgerCore): LedgerClient {
  return {
    check: async (sub, session) => ledger.check(sub, session),
    record: async (call) => ledger.record(call),
    usage: async (sub) => ledger.usage(sub),
    session: async (sid, since, until) => ledger.session(sid, since, until),
    overview: async (period) => ledger.overview(period),
    user: async (sub, period) => ledger.user(sub, period),
    setUser: async (sub, patch, by, period) => ledger.setUser(sub, patch, by, period),
    settings: async () => ledger.settings(),
    setSettings: async (patch, by) => ledger.setSettings(patch, by),
    snapshot: async () => ledger.snapshot(),
  };
}
