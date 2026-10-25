/**
 * `user_memory.consolidate` (docs/USER_MEMORY.md): rewrite `recent.summary`,
 * the few dated lines on what the user is working on now that open the
 * next session's memory block. Built by a small model from the current preferences,
 * the newest lessons and projects and the last two weeks of changes; written
 * as the extraction, active at once, lapsing after
 * USER_MEMORY_LIMITS.recentSummaryDays. An empty answer forgets the summary.
 *
 * An extraction that changed memory queues this a few minutes later; a
 * summary written in the last half hour is left as it is.
 */

import { USER_MEMORY_LIMITS } from "@open-inspect/shared/types/user-memory";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import { afterUserMemoryModelFailure, askUserMemoryModel, userMemoryModel } from "./llm";
import { UserMemoryService } from "./service";
import { UserMemoryStore, type UserMemoryEntryRow, type UserMemoryOpRow } from "./store";

export const userMemoryConsolidateJobSchema = z.object({
  version: z.literal(1),
  ownerUserId: z.string().min(1),
  /** The session whose turn changed memory; the gateway call is recorded against it. */
  sessionId: z.string().min(1),
});
export type UserMemoryConsolidateJob = z.infer<typeof userMemoryConsolidateJobSchema>;

export const USER_MEMORY_SUMMARY_KEY = "recent.summary";
/** A summary touched this recently is not rewritten. */
export const USER_MEMORY_CONSOLIDATE_INTERVAL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the changes the summary reads go. */
const CHANGES_WINDOW_MS = 14 * DAY_MS;
const CONSOLIDATE_MAX_TOKENS = 800;
const FACT_LIMITS = { preferences: 20, lessons: 10, projects: 5, changes: 40 } as const;

const SYSTEM_PROMPT = `Write what this user is working on right now, for their agent to read at the start of the next session: at most 3 short lines, at most ${USER_MEMORY_LIMITS.recentSummaryChars} characters in total, in the user's language, each line starting with a date (yyyy-mm-dd). Use only the facts given. If there is nothing current, answer with an empty string. Answer with the text only.`;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function section(name: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? [`<${name}>`, ...lines, `</${name}>`] : [];
}

/** The facts the summary may use, or null when there are none. */
function factsFor(
  rows: readonly UserMemoryEntryRow[],
  changes: readonly UserMemoryOpRow[],
  now: number
): string | null {
  const active = (layer: UserMemoryEntryRow["layer"], limit: number) =>
    rows
      .filter((row) => row.layer === layer && row.status === "active")
      .slice(0, limit)
      .map((row) => `- ${row.key}: ${row.content}`);
  const recentChanges = changes
    .filter((change) => !change.key.startsWith("recent."))
    .map(
      (change) =>
        `- ${isoDate(change.created_at)} ${change.op} ${change.key}` +
        (change.after_content ? `: ${change.after_content}` : "")
    );
  const lines = [
    ...section("preferences", active("preference", FACT_LIMITS.preferences)),
    ...section("lessons", active("lesson", FACT_LIMITS.lessons)),
    ...section("projects", active("project", FACT_LIMITS.projects)),
    ...section("recent-changes", recentChanges),
  ];
  return lines.length > 0 ? [`Today is ${isoDate(now)}.`, ...lines].join("\n") : null;
}

/** The model's answer as summary text: at most three non-empty lines, within the summary limit. */
export function cleanUserMemorySummary(answer: string): string {
  const text = answer
    .replace(/```[a-z]*/gi, "")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split(/\r?\n/).map((each) => each.trim())) {
    if (!line) continue;
    if (kept.length === 3) break;
    const added = (kept.length > 0 ? 1 : 0) + line.length;
    if (length + added > USER_MEMORY_LIMITS.recentSummaryChars) {
      if (kept.length === 0) kept.push(line.slice(0, USER_MEMORY_LIMITS.recentSummaryChars));
      break;
    }
    kept.push(line);
    length += added;
  }
  return kept.join("\n");
}

export async function handleUserMemoryConsolidate(
  job: UserMemoryConsolidateJob,
  delivery: JobDelivery,
  deps: JobDeps
): Promise<JobOutcome> {
  const context = {
    job_kind: "user_memory.consolidate",
    session_id: job.sessionId,
    attempts: delivery.attempts,
    trace_id: deps.correlation.trace_id,
    request_id: deps.correlation.request_id,
  };
  const skip = (reason: string): JobOutcome => {
    deps.log.info("user_memory.consolidate_skipped", {
      ...context,
      event: "user_memory.consolidate_skipped",
      reason,
    });
    return "ack";
  };
  const model = userMemoryModel(deps.env, deps.log);
  if (!model) return skip("no_model");
  const owner = job.ownerUserId;
  const store = new UserMemoryStore(deps.db);
  if (await store.isPaused(owner)) return skip("paused");
  const now = Date.now();
  const last = await store.lastOpAt(owner, USER_MEMORY_SUMMARY_KEY);
  if (last !== null && last > now - USER_MEMORY_CONSOLIDATE_INTERVAL_MS) return skip("recent");

  const service = new UserMemoryService({ store, generateId: () => generateId() });
  const writer = { kind: "consolidator", sessionId: job.sessionId } as const;
  const [rows, changes] = await Promise.all([
    store.listCurrent(owner, now),
    store.appliedOpsSince(owner, now - CHANGES_WINDOW_MS, FACT_LIMITS.changes),
  ]);
  const facts = factsFor(rows, changes, now);
  let summary = "";
  let usage: Record<string, unknown> = {};
  if (facts) {
    try {
      const reply = await askUserMemoryModel(model, {
        userId: owner,
        sessionId: job.sessionId,
        system: SYSTEM_PROMPT,
        prompt: facts,
        maxTokens: CONSOLIDATE_MAX_TOKENS,
        nowMs: now,
      });
      summary = cleanUserMemorySummary(reply.text);
      usage = {
        model: reply.model,
        input_tokens: reply.inputTokens,
        output_tokens: reply.outputTokens,
        latency_ms: reply.latencyMs,
      };
    } catch (error) {
      return afterUserMemoryModelFailure(error, deps.log, context);
    }
  }

  const applied = await service.applyOps(
    owner,
    [
      summary
        ? {
            op: "set",
            key: USER_MEMORY_SUMMARY_KEY,
            content: summary,
            ttlDays: USER_MEMORY_LIMITS.recentSummaryDays,
          }
        : { op: "forget", key: USER_MEMORY_SUMMARY_KEY, reason: "nothing current" },
    ],
    writer,
    service.newBatchId("consolidate")
  );
  const result = applied.results[0];
  deps.log.info("user_memory.consolidated", {
    ...context,
    ...usage,
    event: "user_memory.consolidated",
    batch_id: applied.batchId,
    outcome: result?.outcome,
    detail: result?.detail,
    summary_chars: summary.length,
  });
  return "ack";
}
