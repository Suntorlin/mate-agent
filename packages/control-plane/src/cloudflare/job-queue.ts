/**
 * The jobs seam over Cloudflare Queues: one Queue per job kind. A message
 * carries the kind's payload alone, and the kind is recovered from the
 * queue it arrived on. That wire shape predates the seam and stays: a queue
 * holds messages across a deploy, so an envelope with the kind inside would
 * open a skew window for nothing.
 *
 * Terraform names each queue `<prefix>-<deployment name>`, the deployment
 * name being the `DEPLOYMENT_NAME` the Worker is configured with, so a
 * batch is routed by the exact name and a dead-letter queue
 * (`<prefix>-dlq-<deployment name>`) is never mistaken for a live one.
 * Terraform also declares each consumer's `max_retries` and `retry_delay`;
 * `job-queue.test.ts` holds those equal to the kind's `JobRetryPolicy`, so
 * the two cannot drift.
 */

import { deliverJob, type JobDeps, type JobKind, type Jobs } from "../jobs";

/** The queue name prefix Terraform gives each kind's queue; the deployment name follows. */
export const JOB_QUEUE_PREFIXES: Record<JobKind, string> = {
  "user_memory.extract": "agent-engine-memory-extract",
  "user_memory.consolidate": "agent-engine-memory-consolidate",
};

/** The Worker's producer bindings, one per job kind; a kind whose queue the deployment omits is absent. */
export interface JobQueueBindings {
  USER_MEMORY_EXTRACT_QUEUE?: Queue<unknown>;
  USER_MEMORY_CONSOLIDATE_QUEUE?: Queue<unknown>;
}

/** The producer binding Terraform gives the control-plane Worker for each kind's queue. */
export const JOB_QUEUE_BINDINGS: Record<JobKind, keyof JobQueueBindings> = {
  "user_memory.extract": "USER_MEMORY_EXTRACT_QUEUE",
  "user_memory.consolidate": "USER_MEMORY_CONSOLIDATE_QUEUE",
};

/** The queue Terraform names for `kind` on the deployment called `deploymentName`. */
export function jobQueueName(kind: JobKind, deploymentName: string): string {
  return `${JOB_QUEUE_PREFIXES[kind]}-${deploymentName}`;
}

/** The kind delivered on `queueName` for this deployment, or `undefined` for a queue no kind owns. */
export function jobKindForQueue(queueName: string, deploymentName: string): JobKind | undefined {
  return (Object.keys(JOB_QUEUE_PREFIXES) as JobKind[]).find(
    (kind) => queueName === jobQueueName(kind, deploymentName)
  );
}

/** The producer side: `send` resolves once the Queue holds the payload. */
export function createQueueJobs(bindings: JobQueueBindings): Jobs {
  return {
    async send(job, options) {
      const queue = bindings[JOB_QUEUE_BINDINGS[job.kind]];
      if (!queue) {
        throw new Error(`No queue is bound for ${job.kind} jobs on this deployment`);
      }
      if (options?.delayMs === undefined) {
        await queue.send(job.payload);
        return;
      }
      // Queues delay in whole seconds; round up so a delay is never shorter
      // than the caller asked for.
      await queue.send(job.payload, { delaySeconds: Math.ceil(options.delayMs / 1000) });
    },
  };
}

/** What the Worker gives every delivery in a batch; the correlation is minted per message. */
export type JobQueueHost = Omit<JobDeps, "correlation">;

/**
 * The consumer side: route the batch by its queue's exact name, deliver
 * each message, and map the outcome onto the message. A batch from a queue
 * no kind owns is retried whole so it dead-letters rather than disappears.
 */
export async function consumeJobBatch(
  batch: MessageBatch<unknown>,
  host: JobQueueHost
): Promise<void> {
  const kind = jobKindForQueue(batch.queue, host.env.DEPLOYMENT_NAME);
  if (!kind) {
    host.log.error("job.queue_unknown", {
      queue: batch.queue,
      known_queues: (Object.keys(JOB_QUEUE_PREFIXES) as JobKind[]).map((known) =>
        jobQueueName(known, host.env.DEPLOYMENT_NAME)
      ),
      messages: batch.messages.length,
    });
    batch.retryAll();
    return;
  }

  for (const message of batch.messages) {
    const outcome = await deliverJob(kind, message.body, message.attempts, {
      ...host,
      correlation: { trace_id: message.id, request_id: message.id },
    });
    if (outcome === "ack") {
      message.ack();
    } else if (outcome.delayMs === undefined) {
      message.retry();
    } else {
      message.retry({ delaySeconds: Math.ceil(outcome.delayMs / 1000) });
    }
  }
}
