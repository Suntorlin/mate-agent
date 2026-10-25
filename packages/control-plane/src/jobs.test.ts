import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "./db/sql-database";
import { consumeJobBatch } from "./cloudflare/job-queue";
import type * as ConsolidateModule from "./memory/consolidate";
import { handleUserMemoryConsolidate } from "./memory/consolidate";
import type * as ExtractModule from "./memory/extract";
import { handleUserMemoryExtract } from "./memory/extract";
import { USER_MEMORY_JOB_RETRY } from "./memory/llm";
import type { Logger } from "./logger";
import { JOB_KINDS, deliverJob, type Job, type JobDeps, type JobKind } from "./jobs";
import type { Env } from "./types";

// The handler bodies are mocked; the table's schemas and retry policies stay
// the production values so the tests below read what the hosts really use.
vi.mock("./memory/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof ExtractModule>()),
  handleUserMemoryExtract: vi.fn(),
}));
vi.mock("./memory/consolidate", async (importOriginal) => ({
  ...(await importOriginal<typeof ConsolidateModule>()),
  handleUserMemoryConsolidate: vi.fn(),
}));

const EXTRACT_PAYLOAD = {
  version: 1 as const,
  sessionId: "session-1",
  ownerUserId: "user-1",
  messageId: "message-1",
};

const CONSOLIDATE_PAYLOAD = {
  version: 1 as const,
  ownerUserId: "user-1",
  sessionId: "session-1",
};

function fakeDeps(): JobDeps & { log: { error: ReturnType<typeof vi.fn> } } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    env: { LOG_LEVEL: "error", DEPLOYMENT_NAME: "test" } as unknown as Env,
    db: {} as SqlDatabase,
    log: log as unknown as Logger & typeof log,
    correlation: { trace_id: "trace-1", request_id: "request-1" },
  };
}

describe("JOB_KINDS", () => {
  it("declares every kind with a retry policy a host can act on", () => {
    for (const [kind, definition] of Object.entries(JOB_KINDS)) {
      expect(definition.retry.maxAttempts, kind).toBeGreaterThanOrEqual(1);
      expect(definition.retry.retryDelayMs, kind).toBeGreaterThan(0);
    }
    expect(JOB_KINDS["user_memory.extract"].retry).toEqual({
      maxAttempts: 3,
      retryDelayMs: 60_000,
    });
    expect(JOB_KINDS["user_memory.consolidate"].retry).toBe(USER_MEMORY_JOB_RETRY);
  });

  it("types a job as its kind's payload", () => {
    // Compile-time: a payload of the wrong kind is refused.
    const finalize: Job = { kind: "user_memory.extract", payload: EXTRACT_PAYLOAD };
    const autofix: Job = { kind: "user_memory.consolidate", payload: CONSOLIDATE_PAYLOAD };
    // @ts-expect-error -- a consolidation payload is not an extraction payload
    const crossed: Job = { kind: "user_memory.extract", payload: CONSOLIDATE_PAYLOAD };
    expect([finalize.kind, autofix.kind, crossed.kind]).toEqual([
      "user_memory.extract",
      "user_memory.consolidate",
      "user_memory.extract",
    ]);
  });
});

describe("deliverJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("hands a parsed payload to the kind's handler with the delivery and returns its outcome", async () => {
    const deps = fakeDeps();
    vi.mocked(handleUserMemoryExtract).mockResolvedValueOnce({
      retry: true,
      delayMs: 365_000,
    });

    const outcome = await deliverJob("user_memory.extract", EXTRACT_PAYLOAD, 3, deps);

    expect(outcome).toEqual({ retry: true, delayMs: 365_000 });
    expect(handleUserMemoryExtract).toHaveBeenCalledWith(
      EXTRACT_PAYLOAD,
      { attempts: 3, maxAttempts: JOB_KINDS["user_memory.extract"].retry.maxAttempts },
      deps
    );
    expect(handleUserMemoryConsolidate).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("routes each kind to its own handler", async () => {
    const deps = fakeDeps();
    vi.mocked(handleUserMemoryConsolidate).mockResolvedValueOnce("ack");

    const outcome = await deliverJob("user_memory.consolidate", CONSOLIDATE_PAYLOAD, 1, deps);

    expect(outcome).toBe("ack");
    expect(handleUserMemoryConsolidate).toHaveBeenCalledWith(
      CONSOLIDATE_PAYLOAD,
      { attempts: 1, maxAttempts: JOB_KINDS["user_memory.consolidate"].retry.maxAttempts },
      deps
    );
  });

  it("retries a payload that does not parse, without running the handler", async () => {
    const deps = fakeDeps();

    const outcome = await deliverJob(
      "user_memory.extract",
      { sessionId: "session-2", callbackToken: "secret" },
      2,
      deps
    );

    expect(outcome).toEqual({ retry: true });
    expect(handleUserMemoryExtract).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "job.payload_invalid",
      expect.objectContaining({
        job_kind: "user_memory.extract",
        attempts: 2,
        request_id: "request-1",
        issues: expect.any(Array),
      })
    );
  });

  it("retries when the handler throws, and logs the failure against the delivery", async () => {
    const deps = fakeDeps();
    const failure = new Error("provider unreachable");
    vi.mocked(handleUserMemoryExtract).mockRejectedValueOnce(failure);

    const outcome = await deliverJob("user_memory.extract", EXTRACT_PAYLOAD, 5, deps);

    expect(outcome).toEqual({ retry: true });
    expect(deps.log.error).toHaveBeenCalledWith(
      "job.handler_failed",
      expect.objectContaining({ job_kind: "user_memory.extract", attempts: 5, error: failure })
    );
  });

  it("parses with the kind's own schema: a valid payload of another kind is refused", async () => {
    const deps = fakeDeps();

    const outcome = await deliverJob("user_memory.extract", CONSOLIDATE_PAYLOAD, 1, deps);

    expect(outcome).toEqual({ retry: true });
    expect(handleUserMemoryExtract).not.toHaveBeenCalled();
  });

  it("continues the real batch adapter after a handler throws", async () => {
    const deps = fakeDeps();
    vi.mocked(handleUserMemoryExtract)
      .mockRejectedValueOnce(new Error("provider unreachable"))
      .mockResolvedValueOnce("ack");
    const messages = ["failed", "completed"].map((id) => ({
      id,
      timestamp: new Date(),
      attempts: 1,
      body: EXTRACT_PAYLOAD,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    const batch = {
      queue: "agent-engine-memory-extract-test",
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;

    await consumeJobBatch(batch, deps);

    expect(handleUserMemoryExtract).toHaveBeenCalledTimes(2);
    expect(messages[0]!.retry).toHaveBeenCalledOnce();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
    expect(messages[1]!.ack).toHaveBeenCalledOnce();
    expect(messages[1]!.retry).not.toHaveBeenCalled();
  });

  it("covers every kind in the table", async () => {
    const deps = fakeDeps();
    vi.mocked(handleUserMemoryExtract).mockResolvedValue("ack");
    vi.mocked(handleUserMemoryConsolidate).mockResolvedValue("ack");
    const payloads: Record<JobKind, unknown> = {
      "user_memory.extract": EXTRACT_PAYLOAD,
      "user_memory.consolidate": CONSOLIDATE_PAYLOAD,
    };

    for (const kind of Object.keys(JOB_KINDS) as JobKind[]) {
      expect(await deliverJob(kind, payloads[kind], 1, deps), kind).toBe("ack");
    }
  });
});
