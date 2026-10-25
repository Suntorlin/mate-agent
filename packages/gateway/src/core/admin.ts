// The admin operations' input: what the control plane (for a signed-in admin) reads and sets.
// Over HTTP they are /llm/admin/* and /admin/usage (app.ts); on the Worker the GatewayAdmin
// entrypoint offers the same over RPC (worker/admin-rpc.ts), and stays when ADMIN_HTTP_ENABLED
// turns the HTTP routes off.
import type { SettingsPatch, UserPatch } from "./ledger";

export const PERIOD_KEY = /^\d{4}-\d{2}(-\d{2})?$/;
export const PERIOD_MESSAGE = "period must look like 2026-10";

type Parsed<T> = { patch: T } | { error: string };

const isAmount = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** An admin's change to the budgets: null restores the deployment's value. */
export function parseSettingsPatch(body: Record<string, unknown> | null): Parsed<SettingsPatch> {
  const patch: SettingsPatch = {};
  for (const key of ["monthly_budget_usd", "user_budget_usd", "key_budget_usd"] as const) {
    if (!body || !(key in body)) continue;
    const value = body[key];
    if (!isAmount(value)) return { error: `${key} must be null or >= 0` };
    patch[key] = value as number | null;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "Send monthly_budget_usd, user_budget_usd and/or key_budget_usd" };
  }
  return { patch };
}

/** An admin's change to one user: their own budget (null restores the default), or a block. */
export function parseUserPatch(body: Record<string, unknown> | null): Parsed<UserPatch> {
  const patch: UserPatch = {};
  if (body && "budget_usd" in body) {
    if (!isAmount(body.budget_usd)) return { error: "budget_usd must be null or >= 0" };
    patch.budget_usd = body.budget_usd as number | null;
  }
  if (body && "blocked" in body) {
    if (typeof body.blocked !== "boolean") return { error: "blocked must be a boolean" };
    patch.blocked = body.blocked;
  }
  if (!body || Object.keys(patch).length === 0) {
    return { error: "Send budget_usd and/or blocked" };
  }
  return { patch };
}

export const WINDOW_MESSAGE =
  "since and until must be whole milliseconds since the epoch, with since not after until";
const MAX_TIME_MS = 8_640_000_000_000_000;

/** The `since` and `until` of a session's window: both optional, from the epoch to now. */
export function parseWindow(
  since: string | null | undefined,
  until: string | null | undefined,
  nowMs: number
): { since: number; until: number } | { error: string } {
  const read = (value: string | null | undefined, fallback: number) =>
    value === null || value === undefined
      ? fallback
      : /^\d{1,16}$/.test(value)
        ? Number(value)
        : -1;
  const window = { since: read(since, 0), until: read(until, nowMs) };
  const valid = window.since >= 0 && window.until <= MAX_TIME_MS && window.since <= window.until;
  return valid ? window : { error: WINDOW_MESSAGE };
}
