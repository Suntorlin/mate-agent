import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type * as JobsModule from "../jobs";
import { JOB_KINDS, deliverJob, type JobKind } from "../jobs";
import type { Logger } from "../logger";
import { readDevWranglerConfig } from "../test-helpers";
import type { Env } from "../types";
import {
  JOB_QUEUE_BINDINGS,
  JOB_QUEUE_PREFIXES,
  consumeJobBatch,
  createQueueJobs,
  jobKindForQueue,
  jobQueueName,
} from "./job-queue";

// Delivery itself is `deliverJob`'s to test (jobs.test.ts); here only the
// Queue mechanics around it are exercised.
vi.mock("../jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof JobsModule>()),
  deliverJob: vi.fn(),
}));

/** The dev environment's resource names end in this; its queues are `<prefix>-staging`. */
const DEV_DEPLOYMENT = "staging";

interface ConfiguredConsumer {
  queuePrefix: string;
  bindingName: string | undefined;
  maxRetries: number;
  retryDelaySeconds: number;
}

/** Every queue consumer the dev environment's Worker config declares, by queue prefix. */
function configuredConsumers(): ConfiguredConsumer[] {
  const { queues } = readDevWranglerConfig();
  return (queues?.consumers ?? []).map((consumer) => ({
    queuePrefix: consumer.queue.replace(new RegExp(`-${DEV_DEPLOYMENT}$`), ""),
    bindingName: queues?.producers?.find((producer) => producer.queue === consumer.queue)?.binding,
    maxRetries: consumer.max_retries,
    retryDelaySeconds: consumer.retry_delay,
  }));
}

function message(id: string, body: unknown, attempts = 1) {
  return { id, timestamp: new Date(), body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function batch(queue: string, ...messages: ReturnType<typeof message>[]) {
  return {
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown> & { retryAll: ReturnType<typeof vi.fn> };
}

function fakeHost() {
  return {
    env: { LOG_LEVEL: "error", DEPLOYMENT_NAME: "prod" } as unknown as Env,
    db: {} as SqlDatabase,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
}

const EXTRACT_PAYLOAD = {
  version: 1 as const,
  sessionId: "session-1",
  ownerUserId: "user-1",
  messageId: "message-1",
};

describe("jobKindForQueue", () => {
  it("recovers the kind from the exact name this deployment gives the queue", () => {
    expect(jobQueueName("user_memory.consolidate", "prod")).toBe(
      "agent-engine-memory-consolidate-prod"
    );
    expect(jobKindForQueue("agent-engine-memory-extract-prod", "prod")).toBe("user_memory.extract");
    expect(jobKindForQueue("agent-engine-memory-consolidate-prod", "prod")).toBe(
      "user_memory.consolidate"
    );
  });

  it("owns only this deployment's queues: another deployment's, a dead-letter, or a foreign queue is unknown", () => {
    expect(jobKindForQueue("agent-engine-memory-consolidate-prod", "staging")).toBeUndefined();
    expect(jobKindForQueue("agent-engine-memory-consolidate-dlq-prod", "prod")).toBeUndefined();
    expect(jobKindForQueue("agent-engine-memory-extract-dlq-prod", "prod")).toBeUndefined();
    expect(jobKindForQueue("open-inspect-slack-completion-prod", "prod")).toBeUndefined();
    expect(jobKindForQueue("agent-engine-memory-consolidate", "prod")).toBeUndefined();
  });

  it("does not misroute a deployment named after another kind", () => {
    expect(
      jobKindForQueue("agent-engine-memory-extract-consolidate-test", "consolidate-test")
    ).toBe("user_memory.extract");
  });
});

describe("Worker config parity", () => {
  it("declares one consumer per job kind on the dev Worker, with the kind's retry policy", () => {
    const consumers = configuredConsumers();
    const kinds = Object.keys(JOB_KINDS) as JobKind[];

    expect(consumers.map((consumer) => consumer.queuePrefix).sort()).toEqual(
      kinds.map((kind) => JOB_QUEUE_PREFIXES[kind]).sort()
    );
    for (const consumer of consumers) {
      const kind = jobKindForQueue(`${consumer.queuePrefix}-${DEV_DEPLOYMENT}`, DEV_DEPLOYMENT);
      expect(kind, consumer.queuePrefix).toBeDefined();
      const { retry } = JOB_KINDS[kind!];
      // Cloudflare counts retries after the first delivery; the table counts deliveries.
      expect(consumer.maxRetries, `${kind} max_retries`).toBe(retry.maxAttempts - 1);
      // Cloudflare takes whole seconds; the adapter rounds a delay up the same way.
      expect(consumer.retryDelaySeconds, `${kind} retry_delay`).toBe(
        Math.ceil(retry.retryDelayMs / 1000)
      );
      expect(consumer.bindingName, `${kind} producer binding`).toBe(JOB_QUEUE_BINDINGS[kind!]);
    }
  });
});

describe("createQueueJobs", () => {
  it("sends the payload alone to the kind's queue", async () => {
    const finalization = { send: vi.fn(async () => undefined) };
    const autofix = { send: vi.fn(async () => undefined) };
    const jobs = createQueueJobs({
      USER_MEMORY_EXTRACT_QUEUE: finalization as unknown as Queue<unknown>,
      USER_MEMORY_CONSOLIDATE_QUEUE: autofix as unknown as Queue<unknown>,
    });

    await jobs.send({ kind: "user_memory.extract", payload: EXTRACT_PAYLOAD });

    expect(finalization.send).toHaveBeenCalledWith(EXTRACT_PAYLOAD);
    expect(autofix.send).not.toHaveBeenCalled();
  });

  it("defers a delayed send in the whole seconds a Queue accepts", async () => {
    const finalization = { send: vi.fn(async () => undefined) };
    const jobs = createQueueJobs({
      USER_MEMORY_EXTRACT_QUEUE: finalization as unknown as Queue<unknown>,
    });

    await jobs.send({ kind: "user_memory.extract", payload: EXTRACT_PAYLOAD }, { delayMs: 30_500 });

    // Rounded up: a delay must never come back sooner than asked.
    expect(finalization.send).toHaveBeenCalledWith(EXTRACT_PAYLOAD, { delaySeconds: 31 });
  });

  it("rejects a kind whose queue this deployment does not bind", async () => {
    const jobs = createQueueJobs({
      USER_MEMORY_EXTRACT_QUEUE: { send: vi.fn() } as unknown as Queue<unknown>,
    });

    await expect(
      jobs.send({
        kind: "user_memory.consolidate",
        payload: { version: 1, ownerUserId: "user-1", sessionId: "session-1" },
      })
    ).rejects.toThrow(/user_memory\.consolidate/);
  });

  it("surfaces the queue's failure so the producer keeps its row recoverable", async () => {
    const jobs = createQueueJobs({
      USER_MEMORY_EXTRACT_QUEUE: {
        send: vi.fn(async () => {
          throw new Error("queue unavailable");
        }),
      } as unknown as Queue<unknown>,
    });

    await expect(
      jobs.send({ kind: "user_memory.extract", payload: EXTRACT_PAYLOAD })
    ).rejects.toThrow("queue unavailable");
  });
});

describe("consumeJobBatch", () => {
  beforeEach(() => {
    vi.mocked(deliverJob).mockReset();
  });

  it("delivers each message to its queue's kind, with the message as the correlation, and acks", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob).mockResolvedValue("ack");
    const first = message("message-1", EXTRACT_PAYLOAD, 1);
    const second = message("message-2", EXTRACT_PAYLOAD, 4);

    await consumeJobBatch(batch("agent-engine-memory-extract-prod", first, second), host);

    expect(deliverJob).toHaveBeenNthCalledWith(1, "user_memory.extract", EXTRACT_PAYLOAD, 1, {
      ...host,
      correlation: { trace_id: "message-1", request_id: "message-1" },
    });
    expect(deliverJob).toHaveBeenNthCalledWith(2, "user_memory.extract", EXTRACT_PAYLOAD, 4, {
      ...host,
      correlation: { trace_id: "message-2", request_id: "message-2" },
    });
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
  });

  it("maps a retry onto the message: the handler's delay when named, the queue's own otherwise", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob)
      .mockResolvedValueOnce({ retry: true, delayMs: 364_001 })
      .mockResolvedValueOnce({ retry: true });
    const delayed = message("message-1", EXTRACT_PAYLOAD);
    const bare = message("message-2", EXTRACT_PAYLOAD);

    await consumeJobBatch(batch("agent-engine-memory-extract-prod", delayed, bare), host);

    expect(delayed.retry).toHaveBeenCalledWith({ delaySeconds: 365 });
    expect(bare.retry).toHaveBeenCalledWith();
    expect(delayed.ack).not.toHaveBeenCalled();
    expect(bare.ack).not.toHaveBeenCalled();
  });

  it("keeps delivering after one message's outcome: a batch is never aborted midway", async () => {
    const host = fakeHost();
    vi.mocked(deliverJob).mockResolvedValueOnce({ retry: true }).mockResolvedValueOnce("ack");
    const retried = message("message-1", EXTRACT_PAYLOAD);
    const acked = message("message-2", EXTRACT_PAYLOAD);

    await consumeJobBatch(batch("agent-engine-memory-consolidate-prod", retried, acked), host);

    expect(deliverJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deliverJob).mock.calls[0]![0]).toBe("user_memory.consolidate");
    expect(retried.retry).toHaveBeenCalledOnce();
    expect(acked.ack).toHaveBeenCalledOnce();
  });

  it("retries a whole batch from a queue no kind owns, so it dead-letters rather than vanishes", async () => {
    const host = fakeHost();
    const stray = message("message-1", EXTRACT_PAYLOAD);
    const unknown = batch("open-inspect-slack-completion-prod", stray);

    await consumeJobBatch(unknown, host);

    expect(deliverJob).not.toHaveBeenCalled();
    expect(unknown.retryAll).toHaveBeenCalledOnce();
    expect(stray.ack).not.toHaveBeenCalled();
    expect(host.log.error).toHaveBeenCalledWith(
      "job.queue_unknown",
      expect.objectContaining({
        queue: "open-inspect-slack-completion-prod",
        known_queues: ["agent-engine-memory-extract-prod", "agent-engine-memory-consolidate-prod"],
        messages: 1,
      })
    );
  });

  it("never runs a dead-letter queue's messages as live jobs", async () => {
    const host = fakeHost();
    const poison = message("message-1", EXTRACT_PAYLOAD);
    const deadLetter = batch("agent-engine-memory-extract-dlq-prod", poison);

    await consumeJobBatch(deadLetter, host);

    expect(deliverJob).not.toHaveBeenCalled();
    expect(deadLetter.retryAll).toHaveBeenCalledOnce();
  });
});
