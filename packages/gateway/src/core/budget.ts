// USD budgets for LLM calls, checked before a request is forwarded:
// - per user (JWT `sub`) and calendar period (UTC month by default), from the
//   ledger below, so one user running out never blocks anyone else;
// - service-wide per UTC month, from the same ledger, when a monthly budget is
//   set (an admin's setting, else LLM_MONTHLY_BUDGET_USD); crossing 80% and
//   100% of it sends one alert each per month;
// - globally, as a safety net, on the OpenRouter key itself:
//   spent = key usage now - key usage recorded on the gateway's first check.
// The ledger (per session, per user, per user and period) is built from the
// `usage.cost` OpenRouter reports on each response. A response cut off before
// its end carries no cost; it stays pending until the backfill (backfill.ts)
// reads the call's real cost from OpenRouter by its generation id. The ledger
// lives in memory and every change goes through a LedgerStore, which knows
// nothing of the rules here: SQLite (ledger-store.ts). A cost is known only
// when a response completes, so concurrent requests of one user can overshoot
// their budget by what is in flight. Single writer only: the in-memory ledger
// is the one the checks read, which the one ledger Durable Object (or the one
// Node process) guarantees.

/** How long a key usage reading is used as is. */
export const USAGE_CACHE_MS = 20_000;
/** How long an older reading still answers while a fresh one is read (or after a failed read). */
export const USAGE_MAX_STALE_MS = 5 * 60_000;

export interface SpendRow {
  usd: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** When the last call counted here was made. */
  last_at?: string;
}

export interface Ledger {
  total: SpendRow;
  by_session: Record<string, SpendRow>;
  by_user: Record<string, SpendRow>;
  /** Which user each session belongs to. */
  session_owner?: Record<string, string>;
  /** Per budget period key ("2026-10" for a month, "2026-10-01" for a day), then per user. */
  by_period: Record<string, Record<string, SpendRow>>;
}

export const BUDGET_PERIODS = ["month", "day"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export interface PeriodWindow {
  key: string;
  start: Date;
  end: Date;
}

/** The UTC calendar period containing `nowMs`. */
export function periodWindow(period: BudgetPeriod, nowMs: number): PeriodWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "month") {
    return {
      key: now.toISOString().slice(0, 7),
      start: new Date(Date.UTC(year, month, 1)),
      end: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  const day = now.getUTCDate();
  return {
    key: now.toISOString().slice(0, 10),
    start: new Date(Date.UTC(year, month, day)),
    end: new Date(Date.UTC(year, month, day + 1)),
  };
}

/** One user's spend in the current period, as the product shows it. */
export interface UserUsage {
  period: BudgetPeriod;
  period_start: string;
  resets_at: string;
  budget_usd: number;
  spent_usd: number;
  remaining_usd: number;
  requests: number;
}

export interface GatewayState {
  baseline_usd?: number;
  baseline_at?: string;
  ledger: Ledger;
  /** Calls whose cost is not known yet, by id. */
  pending?: Record<string, RequestRecord>;
  /** Per-user overrides set by an admin, by user (JWT `sub`). */
  limits?: Record<string, UserLimit>;
  /** An admin's budgets, overriding the deployment's. */
  settings?: BudgetSettings;
  /** Monthly-budget alerts already sent, by month: the thresholds (0.8, 1). */
  alerts?: Record<string, number[]>;
}

/** Budgets an admin set; absent or null means the deployment's value. */
export interface BudgetSettings {
  monthly_budget_usd?: number | null;
  user_budget_usd?: number | null;
  /** The safety net on the OpenRouter key (`budgetUsd`). */
  key_budget_usd?: number | null;
  updated_at: string;
  updated_by: string;
}

/** Fractions of the monthly budget that send an alert, once each per month. */
export const ALERT_THRESHOLDS = [0.8, 1] as const;

/** An admin's override for one user: their own budget instead of the default, or a block. */
export interface UserLimit {
  /** USD per period; absent or null means the default `userBudgetUsd`. */
  budget_usd?: number | null;
  blocked?: boolean;
  updated_at: string;
  updated_by: string;
}

export interface RequestUsage {
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One model call. Settled calls count in the ledger; pending ones wait for their cost. */
export interface RequestRecord {
  /** OpenRouter's generation id, or a random id when the response had none. */
  id: string;
  sid: string;
  sub: string;
  /** The budget period the call was made in. */
  period: string;
  at: string;
  model?: string;
  status: "settled" | "pending" | "unresolved";
  /** Where the cost came from: the response itself, or a later lookup by generation id. */
  source: "stream" | "generation";
  usage: RequestUsage;
}

/** Where the ledger is persisted. The in-memory ledger is current; each save writes what changed. */
export interface LedgerStore {
  saveBaseline(state: GatewayState): void;
  saveRequest(record: RequestRecord, state: GatewayState): void;
  saveLimit(sub: string, limit: UserLimit, state: GatewayState): void;
  saveSettings(settings: BudgetSettings, state: GatewayState): void;
  saveAlerts(month: string, sent: number[], state: GatewayState): void;
}

export type BudgetDecision =
  | { allowed: true; spent: number }
  | {
      allowed: false;
      status: 403 | 429 | 503;
      scope: "user" | "global";
      message: string;
      /** When the exhausted budget starts over, if it does on its own. */
      resetsAt?: string;
    };

export type BudgetRefusal = Extract<BudgetDecision, { allowed: false }>;

/**
 * The machine-readable tag a refusal's message ends with, or null for a refusal that is only
 * momentary (the budget could not be checked). Claude Code hands the agent runtime nothing of a
 * refused call but its status and message (not the error type, other body fields or headers),
 * so this tag is how the runtime and the web tell "a limit is spent, waiting a moment will not
 * help" from a busy model service. Grammar, kept stable for those readers:
 * `[llm_budget=<user|global|blocked>( resets_at=<ISO 8601>)?]`
 * - user: the caller's own budget for the period; resets at `resets_at`.
 * - global: the service-wide limit; `resets_at` only when it is the monthly budget.
 * - blocked: an admin paused this account; it never resets on its own.
 */
export function refusalTag(refusal: BudgetRefusal): string | null {
  const kind = refusalKind(refusal);
  if (!kind) return null;
  const resets = refusal.resetsAt ? ` resets_at=${refusal.resetsAt}` : "";
  return `[llm_budget=${kind}${resets}]`;
}

/** Which limit a refusal is about, or null for one that is only momentary. */
export function refusalKind(refusal: BudgetRefusal): "user" | "global" | "blocked" | null {
  if (refusal.status === 503) return null;
  return refusal.status === 403 ? "blocked" : refusal.scope;
}

const EMPTY_ROW: SpendRow = Object.freeze({
  usd: 0,
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(row: SpendRow | undefined, usage: RequestUsage, at?: string): SpendRow {
  const base = row ?? EMPTY_ROW;
  const lastAt = at && (!base.last_at || at > base.last_at) ? at : base.last_at;
  return {
    ...(lastAt ? { last_at: lastAt } : {}),
    usd: num(base.usd) + num(usage.cost),
    requests: num(base.requests) + 1,
    input_tokens: num(base.input_tokens) + num(usage.input_tokens),
    output_tokens: num(base.output_tokens) + num(usage.output_tokens),
    cache_read_input_tokens: num(base.cache_read_input_tokens) + num(usage.cache_read_input_tokens),
    // Rows written before cache writes were kept have no such field.
    cache_creation_input_tokens:
      num(base.cache_creation_input_tokens) + num(usage.cache_creation_input_tokens),
  };
}

export function emptyLedger(): Ledger {
  return { total: EMPTY_ROW, by_session: {}, by_user: {}, by_period: {} };
}

/** The ledger with one settled call added. */
export function addToLedger(ledger: Ledger, record: RequestRecord): Ledger {
  const { sid, sub, period: key, usage, at } = record;
  const period = ledger.by_period[key] ?? {};
  return {
    total: addUsage(ledger.total, usage, at),
    by_session: { ...ledger.by_session, [sid]: addUsage(ledger.by_session[sid], usage, at) },
    by_user: { ...ledger.by_user, [sub]: addUsage(ledger.by_user[sub], usage, at) },
    session_owner: { ...ledger.session_owner, [sid]: sub },
    by_period: {
      ...ledger.by_period,
      [key]: { ...period, [sub]: addUsage(period[sub], usage, at) },
    },
  };
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

function resetPhrase(period: BudgetPeriod, end: Date): string {
  if (period === "day") return "It resets at midnight UTC.";
  const date = end.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `It resets on ${date} (UTC).`;
}

// End users read these in the chat, so they say what happened and what to
// expect, never which knob an operator would turn.
const GLOBAL_LIMIT_MESSAGE =
  "AI usage is paused for everyone because the service-wide limit has been reached. Please try again later.";
const BLOCKED_MESSAGE = "AI usage is paused for this account. Please contact support.";
export const UNAVAILABLE_MESSAGE =
  "AI usage could not be checked right now. Please try again in a moment.";

export function createBudget(options: {
  /** Global cap on the OpenRouter key's spend since the gateway's first check. */
  budgetUsd: number;
  /** Cap on each user's spend per `userBudgetPeriod`. */
  userBudgetUsd: number;
  /** Service-wide cap per UTC month from the ledger; null for none. */
  monthlyBudgetUsd?: number | null;
  /** Sends an operator alert (the monthly budget's thresholds). */
  alert?: (message: string) => void;
  userBudgetPeriod: BudgetPeriod;
  /** The persisted ledger: where changes go, and the state it loaded. */
  ledger: { store: LedgerStore; state: GatewayState };
  fetchKeyUsage: () => Promise<number>;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  const store = options.ledger.store;
  let state = options.ledger.state;
  let lastGood: { usage: number; at: number } | null = null;
  let inflight: Promise<{ usage: number; at: number }> | null = null;

  function refresh(): Promise<{ usage: number; at: number }> {
    inflight ??= options
      .fetchKeyUsage()
      .then((usage) => {
        if (state.baseline_usd === undefined) {
          state = { ...state, baseline_usd: usage, baseline_at: new Date(now()).toISOString() };
          store.saveBaseline(state);
          log(`budget: recorded baseline key usage ${usage}`);
        }
        lastGood = { usage, at: now() };
        return lastGood;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function currentUsage(force: boolean): Promise<{ usage: number; at: number }> {
    if (!force && lastGood) {
      const age = now() - lastGood.at;
      if (age < USAGE_CACHE_MS) return lastGood;
      // Answer from the last reading and refresh behind it: waiting here would put a round
      // trip to OpenRouter in front of the model's first token, while the cap only needs
      // the reading of a request or so ago.
      if (age < USAGE_MAX_STALE_MS) {
        refresh().catch((error) => log(`budget: key usage refresh failed: ${error}`));
        return lastGood;
      }
    }
    try {
      return await refresh();
    } catch (error) {
      if (lastGood && now() - lastGood.at < USAGE_MAX_STALE_MS) {
        log(`budget: key usage refresh failed, using value from ${lastGood.at}: ${error}`);
        return lastGood;
      }
      throw error;
    }
  }

  /** Every user's default budget per period: an admin's setting, or the deployment's. */
  function defaultUserBudget(): number {
    const set = state.settings?.user_budget_usd;
    return typeof set === "number" ? set : options.userBudgetUsd;
  }

  /** The service-wide monthly budget, or null for none. */
  function monthlyBudget(): number | null {
    const set = state.settings?.monthly_budget_usd;
    return typeof set === "number" ? set : (options.monthlyBudgetUsd ?? null);
  }

  /** The cap on the OpenRouter key's spend since the baseline: an admin's setting, or the deployment's. */
  function keyBudget(): number {
    const set = state.settings?.key_budget_usd;
    return typeof set === "number" ? set : options.budgetUsd;
  }

  /** Everyone's settled spend in a UTC month ("2026-10"), whatever the user period. */
  function monthSpent(month: string): number {
    let total = 0;
    for (const [key, users] of Object.entries(state.ledger.by_period)) {
      if (!key.startsWith(month)) continue;
      for (const row of Object.values(users)) total += num(row.usd);
    }
    return total;
  }

  const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

  /** Sends each threshold's alert the first time this month's spend crosses it. */
  function maybeAlert(): void {
    const budget = monthlyBudget();
    if (budget === null || budget <= 0) return;
    const month = monthOf(now());
    const spent = monthSpent(month);
    const sent = state.alerts?.[month] ?? [];
    const due = ALERT_THRESHOLDS.filter((t) => spent >= budget * t && !sent.includes(t));
    if (due.length === 0) return;
    const next = [...sent, ...due];
    state = { ...state, alerts: { ...state.alerts, [month]: next } };
    store.saveAlerts(month, next, state);
    const top = Math.max(...due);
    const what =
      top >= 1
        ? "has reached it: AI usage is paused for everyone until the month ends or the budget is raised"
        : `is at ${Math.round((spent / budget) * 100)}% of it`;
    const message = `Mate Agent: AI spend this month (${month}) is ${usd(spent)} of the ${usd(budget)} monthly budget and ${what}.`;
    log(`budget: alert: ${message}`);
    options.alert?.(message);
  }

  /** The user's budget per period: an admin's override, or the default. */
  function budgetOf(sub: string): number {
    const custom = state.limits?.[sub]?.budget_usd;
    return typeof custom === "number" ? custom : defaultUserBudget();
  }

  function usageFor(sub: string, periodKey?: string): UserUsage {
    const window = periodWindow(options.userBudgetPeriod, now());
    const row = state.ledger.by_period[periodKey ?? window.key]?.[sub] ?? EMPTY_ROW;
    const budget = budgetOf(sub);
    return {
      period: options.userBudgetPeriod,
      period_start: window.start.toISOString(),
      resets_at: window.end.toISOString(),
      budget_usd: budget,
      spent_usd: row.usd,
      remaining_usd: Math.max(0, budget - row.usd),
      requests: row.requests,
    };
  }

  /** Whether `sub` may make one more call: not blocked, their own budget, then the global cap. */
  async function check(sub: string): Promise<BudgetDecision> {
    if (state.limits?.[sub]?.blocked) {
      return { allowed: false, status: 403, scope: "user", message: BLOCKED_MESSAGE };
    }
    const user = usageFor(sub);
    if (user.spent_usd >= user.budget_usd) {
      const which = options.userBudgetPeriod === "month" ? "this month's" : "today's";
      return {
        allowed: false,
        status: 429,
        scope: "user",
        message: `You've used ${which} AI budget (${usd(user.spent_usd)} of ${usd(user.budget_usd)}). ${resetPhrase(options.userBudgetPeriod, new Date(user.resets_at))}`,
        resetsAt: user.resets_at,
      };
    }
    const monthly = monthlyBudget();
    if (monthly !== null && monthSpent(monthOf(now())) >= monthly) {
      return {
        allowed: false,
        status: 429,
        scope: "global",
        message: GLOBAL_LIMIT_MESSAGE,
        resetsAt: periodWindow("month", now()).end.toISOString(),
      };
    }
    return checkGlobal();
  }

  /** The safety net: the key's spend across every user. Also records the baseline on first use. */
  async function checkGlobal(): Promise<BudgetDecision> {
    let usage: number;
    try {
      usage = (await currentUsage(false)).usage;
    } catch (error) {
      log(`budget: key usage unavailable: ${error}`);
      return { allowed: false, status: 503, scope: "global", message: UNAVAILABLE_MESSAGE };
    }
    const spent = usage - (state.baseline_usd ?? usage);
    const cap = keyBudget();
    if (spent >= cap) {
      log(`budget: global budget exhausted: spent ${usd(spent)} of ${usd(cap)}`);
      return { allowed: false, status: 429, scope: "global", message: GLOBAL_LIMIT_MESSAGE };
    }
    return { allowed: true, spent };
  }

  /**
   * Records one model call. Without a cost but with OpenRouter's generation id (a response cut
   * off before its end) the call stays pending until `settle` gives it its real cost.
   */
  function record(
    sid: string,
    sub: string,
    usage: RequestUsage,
    meta: { id?: string; model?: string } = {}
  ): RequestRecord {
    const settled = typeof usage.cost === "number" || !meta.id;
    const entry: RequestRecord = {
      id: meta.id ?? crypto.randomUUID(),
      sid,
      sub,
      period: periodWindow(options.userBudgetPeriod, now()).key,
      at: new Date(now()).toISOString(),
      ...(meta.model ? { model: meta.model } : {}),
      status: settled ? "settled" : "pending",
      source: "stream",
      usage,
    };
    if (settled) {
      state = { ...state, ledger: addToLedger(state.ledger, entry) };
    } else {
      state = { ...state, pending: { ...state.pending, [entry.id]: entry } };
    }
    store.saveRequest(entry, state);
    if (settled) maybeAlert();
    return entry;
  }

  function pendingRequests(): RequestRecord[] {
    return Object.values(state.pending ?? {});
  }

  function withoutPending(id: string): Record<string, RequestRecord> {
    const rest = { ...state.pending };
    delete rest[id];
    return rest;
  }

  /**
   * Gives a pending call the cost OpenRouter reports for it and counts it in the period it was
   * made in. Token counts read from the stream before the cut win; the lookup fills the rest.
   */
  function settle(id: string, looked: RequestUsage): RequestRecord | null {
    const entry = state.pending?.[id];
    if (!entry) return null;
    const usage: RequestUsage = { ...looked, ...entry.usage, cost: looked.cost };
    if (looked.output_tokens !== undefined) usage.output_tokens = looked.output_tokens;
    const done: RequestRecord = { ...entry, status: "settled", source: "generation", usage };
    state = { ...state, ledger: addToLedger(state.ledger, done), pending: withoutPending(id) };
    store.saveRequest(done, state);
    maybeAlert();
    return done;
  }

  /** Stops waiting for a pending call's cost; it stays on record but never counts. */
  function abandon(id: string): RequestRecord | null {
    const entry = state.pending?.[id];
    if (!entry) return null;
    const done: RequestRecord = { ...entry, status: "unresolved" };
    state = { ...state, pending: withoutPending(id) };
    store.saveRequest(done, state);
    return done;
  }

  /** Sets or clears an admin's override for one user. `budget_usd: null` restores the default. */
  function setLimit(
    sub: string,
    patch: { budget_usd?: number | null; blocked?: boolean },
    by: string
  ): UserLimit {
    const current = state.limits?.[sub];
    const limit: UserLimit = {
      ...(current ?? {}),
      ...patch,
      updated_at: new Date(now()).toISOString(),
      updated_by: by,
    };
    state = { ...state, limits: { ...state.limits, [sub]: limit } };
    store.saveLimit(sub, limit, state);
    return limit;
  }

  /** Sets an admin's budgets; null restores the deployment's value. */
  function setSettings(
    patch: {
      monthly_budget_usd?: number | null;
      user_budget_usd?: number | null;
      key_budget_usd?: number | null;
    },
    by: string
  ): BudgetSettings {
    const settings: BudgetSettings = {
      ...(state.settings ?? {}),
      ...patch,
      updated_at: new Date(now()).toISOString(),
      updated_by: by,
    };
    state = { ...state, settings };
    store.saveSettings(settings, state);
    if ("monthly_budget_usd" in patch) {
      // A new budget gets its own alerts; one already crossed alerts at once.
      const month = monthOf(now());
      state = { ...state, alerts: { ...state.alerts, [month]: [] } };
      store.saveAlerts(month, [], state);
    }
    maybeAlert();
    return settings;
  }

  /**
   * The budgets as an admin sees them. `keySpent` is the key's spend since the baseline when the
   * caller has read it (null or absent: not known).
   */
  function adminSettings(keySpent?: number | null) {
    const month = monthOf(now());
    const monthly = monthlyBudget();
    const spent = monthSpent(month);
    const keyCap = keyBudget();
    return {
      month,
      monthly_budget_usd: monthly,
      deployment_monthly_budget_usd: options.monthlyBudgetUsd ?? null,
      month_spent_usd: spent,
      month_remaining_usd: monthly === null ? null : Math.max(0, monthly - spent),
      alerts_sent: state.alerts?.[month] ?? [],
      user_budget_usd: defaultUserBudget(),
      deployment_user_budget_usd: options.userBudgetUsd,
      user_budget_period: options.userBudgetPeriod,
      key_budget_usd: keyCap,
      deployment_key_budget_usd: options.budgetUsd,
      key_spent_usd: keySpent ?? null,
      updated_at: state.settings?.updated_at ?? null,
      updated_by: state.settings?.updated_by ?? null,
    };
  }

  /** One user as an admin sees them: this period's spend and budget, their override, all-time totals. */
  function adminUser(sub: string, periodKey?: string) {
    const window = periodWindow(options.userBudgetPeriod, now());
    const key = periodKey ?? window.key;
    const row = state.ledger.by_period[key]?.[sub] ?? EMPTY_ROW;
    const limit = state.limits?.[sub];
    const budget = budgetOf(sub);
    return {
      sub,
      period: key,
      spent_usd: row.usd,
      requests: row.requests,
      budget_usd: budget,
      remaining_usd: Math.max(0, budget - row.usd),
      custom_budget: typeof limit?.budget_usd === "number",
      blocked: limit?.blocked === true,
      last_at: state.ledger.by_user[sub]?.last_at ?? null,
      all_time: state.ledger.by_user[sub] ?? EMPTY_ROW,
      limit: limit ?? null,
    };
  }

  /** Every user seen in the period or holding an override, plus the service-wide figures. */
  async function adminOverview(periodKey?: string) {
    const window = periodWindow(options.userBudgetPeriod, now());
    const key = periodKey ?? window.key;
    const subs = new Set([
      ...Object.keys(state.ledger.by_period[key] ?? {}),
      ...Object.keys(state.limits ?? {}),
    ]);
    const users = [...subs]
      .map((sub) => adminUser(sub, key))
      .sort((a, b) => b.spent_usd - a.spent_usd || a.sub.localeCompare(b.sub));
    const periods = Object.keys(state.ledger.by_period).sort().reverse();
    const service = await snapshot();
    return {
      period: key,
      periods: periods.includes(window.key) ? periods : [window.key, ...periods],
      period_type: options.userBudgetPeriod,
      resets_at: window.end.toISOString(),
      default_user_budget_usd: defaultUserBudget(),
      settings: adminSettings(service.spent_usd),
      global: {
        budget_usd: service.budget_usd,
        spent_usd: service.spent_usd,
        remaining_usd: service.remaining_usd,
        since: service.baseline_at,
        checked_at: service.checked_at,
        ...(service.error ? { error: service.error } : {}),
      },
      pending_requests: service.pending_requests,
      users,
    };
  }

  /** A user's sessions, most recent first. */
  function adminSessions(sub: string) {
    const owner = state.ledger.session_owner ?? {};
    return Object.entries(state.ledger.by_session)
      .filter(([sid]) => owner[sid] === sub)
      .map(([sid, row]) => ({ sid, ...row }))
      .sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  }

  /** The key's spend since the baseline from the cached reading; null when it cannot be read. */
  async function keySpent(): Promise<number | null> {
    try {
      const { usage } = await currentUsage(false);
      return usage - (state.baseline_usd ?? usage);
    } catch {
      return null;
    }
  }

  async function snapshot() {
    let current: { usage: number; at: number } | null = null;
    let error: string | undefined;
    try {
      current = await currentUsage(true);
    } catch (caught) {
      error = String(caught);
    }
    const baseline = state.baseline_usd ?? null;
    const spent = current && baseline !== null ? current.usage - baseline : null;
    const window = periodWindow(options.userBudgetPeriod, now());
    const keyCap = keyBudget();
    return {
      budget_usd: keyCap,
      user_budget_usd: options.userBudgetUsd,
      user_budget_period: options.userBudgetPeriod,
      period: window.key,
      resets_at: window.end.toISOString(),
      baseline_usd: baseline,
      baseline_at: state.baseline_at ?? null,
      key_usage_usd: current?.usage ?? null,
      checked_at: current ? new Date(current.at).toISOString() : null,
      spent_usd: spent,
      remaining_usd: spent === null ? null : Math.max(0, keyCap - spent),
      ...(error ? { error } : {}),
      pending_requests: pendingRequests().length,
      ledger: state.ledger,
    };
  }

  return {
    check,
    checkGlobal,
    record,
    settle,
    abandon,
    pendingRequests,
    usageFor,
    snapshot,
    setLimit,
    setSettings,
    adminSettings,
    keySpent,
    adminUser,
    adminOverview,
    adminSessions,
  };
}

export type Budget = ReturnType<typeof createBudget>;
