/**
 * The control plane's scheduled jobs: one table that both clocks drive.
 * Cloudflare fires `scheduled()` in `src/index.ts` from the cron triggers
 * the Worker config declares (`triggers.crons` in
 * `deploy/cloudflare/wrangler.staging.jsonc`), which must
 * list exactly the expressions below; a unit test checks the two agree. The
 * Node host drives the same table from an in-process loop over
 * `nextCronOccurrence` from `@open-inspect/shared` (src/node/cron-loop.ts).
 *
 * A slot may fire twice (a retried trigger, two hosts during a cutover) and
 * that is harmless: the sweeps are idempotent, so a double tick costs extra
 * reads and nothing else. The Node host is planned as one process, so
 * it needs no leader election.
 */

import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import { USER_MEMORY_PURGE_CRON, purgeUserMemory } from "./memory/purge";
import type { CorrelationContext, Logger } from "./logger";
import type { BackgroundTasks } from "./platform-ports";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import type { SessionRuntimeClient } from "./session/runtime-client";
import type { Env } from "./types";

/** What one run of a scheduled job is given. The host builds it per run. */
export interface ScheduledJobDeps {
  env: Env;
  db: SqlDatabase;
  sessions: SessionRuntimeClient;
  backgroundTasks: BackgroundTasks;
  log: Logger;
  /** Identifies this run in logs; the host mints one per run. */
  correlation: CorrelationContext;
}

export interface ScheduledJob {
  readonly name: string;
  /** Five-field cron expression, evaluated in UTC. */
  readonly cron: string;
  /** Run the job once for the slot at `nowMs` (epoch milliseconds). */
  run(deps: ScheduledJobDeps, nowMs: number): Promise<void>;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: "abandoned_draft_sweep",
    cron: ABANDONED_DRAFT_SWEEP_CRON,
    async run({ db, sessions, log }, nowMs) {
      await new AbandonedDraftSweep(
        new SessionIndexStore(db),
        new SessionDraftExpiryClient(sessions),
        log
      ).run(nowMs);
    },
  },
  {
    name: "user_memory_purge",
    cron: USER_MEMORY_PURGE_CRON,
    async run({ db, log }, nowMs) {
      await purgeUserMemory(db, log, nowMs);
    },
  },
];

/** The job bound to `cron`, or `undefined` when no job runs on that expression. */
export function findScheduledJob(cron: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((job) => job.cron === cron);
}
