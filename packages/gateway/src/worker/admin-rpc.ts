// The admin API over RPC, for a Worker holding a service binding to this one
// (`entrypoint: "GatewayAdmin"`). The same operations and answers as the HTTP routes; bad input
// throws with the HTTP route's message. Served even when ADMIN_HTTP_ENABLED turns HTTP off.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  PERIOD_KEY,
  PERIOD_MESSAGE,
  parseSettingsPatch,
  parseUserPatch,
  parseWindow,
} from "../core/admin";
import { log } from "../core/log";
import { type Env, ledgerOf } from "./env";

function checkPeriod(period: string | undefined): void {
  if (period !== undefined && !PERIOD_KEY.test(period)) throw new RangeError(PERIOD_MESSAGE);
}

function checkAdmin(by: unknown): string {
  if (typeof by !== "string" || by.trim() === "") throw new TypeError("by must name the admin");
  return by;
}

/** `by` names the admin, as the admin token's subject does over HTTP. */
export class GatewayAdmin extends WorkerEntrypoint<Env> {
  /** GET /llm/admin/overview[?period=] */
  overview(period?: string) {
    checkPeriod(period);
    return ledgerOf(this.env).overview(period);
  }

  /** GET /llm/admin/users/:sub[?period=] */
  user(sub: string, period?: string) {
    checkPeriod(period);
    return ledgerOf(this.env).user(sub, period);
  }

  /** GET /llm/admin/sessions/:sid[?since=&until=] (milliseconds since the epoch) */
  session(sid: string, sinceMs?: number, untilMs?: number) {
    const window = parseWindow(sinceMs?.toString(), untilMs?.toString(), Date.now());
    if ("error" in window) throw new RangeError(window.error);
    return ledgerOf(this.env).session(sid, window.since, window.until);
  }

  /** PATCH /llm/admin/users/:sub {budget_usd?, blocked?} */
  async setUser(sub: string, body: Record<string, unknown>, by: string, period?: string) {
    checkPeriod(period);
    const admin = checkAdmin(by);
    const parsed = parseUserPatch(body);
    if ("error" in parsed) throw new RangeError(parsed.error);
    const user = await ledgerOf(this.env).setUser(sub, parsed.patch, admin, period);
    log({ rpc: "setUser", status: 200, admin, target: sub, ...parsed.patch });
    return user;
  }

  /** GET /llm/admin/settings */
  settings() {
    return ledgerOf(this.env).settings();
  }

  /** PATCH /llm/admin/settings {monthly_budget_usd?, user_budget_usd?, key_budget_usd?} */
  async setSettings(body: Record<string, unknown>, by: string) {
    const admin = checkAdmin(by);
    const parsed = parseSettingsPatch(body);
    if ("error" in parsed) throw new RangeError(parsed.error);
    const settings = await ledgerOf(this.env).setSettings(parsed.patch, admin);
    log({ rpc: "setSettings", status: 200, admin, ...parsed.patch });
    return settings;
  }

  /** GET /admin/usage: the key's spend and the whole ledger. */
  usage() {
    return ledgerOf(this.env).snapshot();
  }
}
