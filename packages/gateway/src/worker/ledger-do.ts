// The ledger Durable Object: one instance (LEDGER_NAME), so one writer, holding the budget in
// memory over its SQLite. The Worker asks it before a call (`check`) and tells it after
// (`record`); the upstream stream itself never passes through here. Its alarm runs the backfill
// and the keep-alive pings.
import { DurableObject } from "cloudflare:workers";
import {
  type FinishedCall,
  type LedgerCore,
  type SettingsPatch,
  type UserPatch,
  createLedgerFor,
} from "../core/ledger";
import { type Env, configOf } from "./env";
import { durableAlarm, durableSql, r2Blobs } from "./storage";

export class LedgerDO extends DurableObject<Env> {
  private readonly ledger: LedgerCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = createLedgerFor(configOf(env), {
      sql: durableSql(ctx.storage),
      alarm: durableAlarm(ctx.storage),
      bucket: r2Blobs(env.KEEPALIVE_BUCKET),
    });
  }

  check(sub: string, session?: { sid: string; model: string }) {
    return this.ledger.check(sub, session);
  }

  record(call: FinishedCall) {
    return this.ledger.record(call);
  }

  usage(sub: string) {
    return this.ledger.usage(sub);
  }

  session(sid: string, sinceMs: number, untilMs: number) {
    return this.ledger.session(sid, sinceMs, untilMs);
  }

  overview(period?: string) {
    return this.ledger.overview(period);
  }

  user(sub: string, period?: string) {
    return this.ledger.user(sub, period);
  }

  setUser(sub: string, patch: UserPatch, by: string, period?: string) {
    return this.ledger.setUser(sub, patch, by, period);
  }

  settings() {
    return this.ledger.settings();
  }

  setSettings(patch: SettingsPatch, by: string) {
    return this.ledger.setSettings(patch, by);
  }

  snapshot() {
    return this.ledger.snapshot();
  }

  async alarm(): Promise<void> {
    await this.ledger.tick();
  }
}
