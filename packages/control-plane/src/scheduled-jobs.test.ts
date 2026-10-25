import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import type { Logger } from "./logger";
import type { BackgroundTasks } from "./platform-ports";
import type * as UserMemoryPurgeModule from "./memory/purge";
import { USER_MEMORY_PURGE_CRON, purgeUserMemory } from "./memory/purge";
import type * as AbandonedDraftSweepModule from "./session/abandoned-draft-sweep";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import type { SessionRuntimeClient } from "./session/runtime-client";
import { SCHEDULED_JOBS, findScheduledJob, type ScheduledJobDeps } from "./scheduled-jobs";
import { readDevWranglerConfig } from "./test-helpers";
import type { Env } from "./types";

// The job bodies are mocked; the cron constants stay the production values so
// the Worker-config parity check below reads what the Worker really registers.
vi.mock("./memory/purge", async (importOriginal) => ({
  ...(await importOriginal<typeof UserMemoryPurgeModule>()),
  purgeUserMemory: vi.fn(async () => {}),
}));
vi.mock("./session/abandoned-draft-sweep", async (importOriginal) => ({
  ...(await importOriginal<typeof AbandonedDraftSweepModule>()),
  AbandonedDraftSweep: vi.fn(function () {
    return { run: sweepRun };
  }),
  SessionDraftExpiryClient: vi.fn(),
}));

const { sweepRun } = vi.hoisted(() => ({
  sweepRun: vi.fn(async () => ({})),
}));

/** The `crons` the dev environment's Worker config declares. */
const configuredCronTriggers = (): string[] => readDevWranglerConfig().triggers?.crons ?? [];

function fakeDeps(): ScheduledJobDeps & {
  submitted: Array<{ name: string; task: () => Promise<unknown> }>;
} {
  const submitted: Array<{ name: string; task: () => Promise<unknown> }> = [];
  const backgroundTasks: BackgroundTasks = {
    submit(task, metadata) {
      submitted.push({ name: metadata.name, task });
    },
  };
  return {
    env: { LOG_LEVEL: "error" } as unknown as Env,
    db: {} as SqlDatabase,
    sessions: {} as SessionRuntimeClient,
    backgroundTasks,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    correlation: { trace_id: "trace-1", request_id: "request-1" },
    submitted,
  };
}

describe("SCHEDULED_JOBS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds each cron expression to exactly one job, and the Worker config's triggers to exactly those", () => {
    const crons = SCHEDULED_JOBS.map((job) => job.cron);
    expect(new Set(crons).size).toBe(crons.length);
    expect(new Set(SCHEDULED_JOBS.map((job) => job.name)).size).toBe(crons.length);
    expect([...crons].sort()).toEqual([ABANDONED_DRAFT_SWEEP_CRON, USER_MEMORY_PURGE_CRON].sort());
    expect([...configuredCronTriggers()].sort()).toEqual([...crons].sort());
    for (const job of SCHEDULED_JOBS) expect(findScheduledJob(job.cron)).toBe(job);
    expect(findScheduledJob("0 0 * * *")).toBeUndefined();
  });

  it("runs the abandoned-draft sweep over the index store and the session client at the run's time", async () => {
    const deps = fakeDeps();

    await findScheduledJob(ABANDONED_DRAFT_SWEEP_CRON)!.run(deps, 1_234_567);

    expect(SessionDraftExpiryClient).toHaveBeenCalledWith(deps.sessions);
    const [index, client, log] = vi.mocked(AbandonedDraftSweep).mock.calls[0]!;
    expect(index).toBeInstanceOf(SessionIndexStore);
    expect(client).toBe(vi.mocked(SessionDraftExpiryClient).mock.instances[0]);
    expect(log).toBe(deps.log);
    expect(sweepRun).toHaveBeenCalledWith(1_234_567);
  });

  it("purges forgotten user memory daily at the run's time", async () => {
    const deps = fakeDeps();

    await findScheduledJob(USER_MEMORY_PURGE_CRON)!.run(deps, 1_234_567);

    expect(purgeUserMemory).toHaveBeenCalledWith(deps.db, deps.log, 1_234_567);
    expect(deps.submitted).toEqual([]);
  });
});
