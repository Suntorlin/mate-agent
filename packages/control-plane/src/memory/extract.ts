/**
 * `user_memory.extract` (docs/USER_MEMORY.md): after a successful turn, a small model reads what
 * the user said and what the agent answered, next to the current memory, and proposes what is
 * worth remembering. The ops apply as the extraction (`extractor`): what the user said in the
 * turn is active at once, everything else waits for approval.
 *
 * Delivery is at least once, so a turn's ops share the batch
 * `extract:<messageId>` and a delivery that finds it written does nothing.
 * Skipped while memory is paused, for turns where the user only said
 * "continue", and for turns someone other than the owner wrote.
 *
 * What the agent itself saved with `mem` during the turn is not written
 * again: the model sees those keys marked, and an op that only restates one of
 * them (under that key or another) is dropped, so a turn remembers a fact once.
 */

import {
  userMemoryOpInputSchema,
  USER_MEMORY_LIMITS,
  type UserMemoryLayer,
  type UserMemoryOpInput,
} from "@open-inspect/shared/types/user-memory";
import { listEventsResponseSchema } from "@open-inspect/shared/types/sandbox-events";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import type { SessionEntry } from "../db/session-index";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient, type SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { broadcastUserMemoryEvent } from "./events";
import {
  afterUserMemoryModelFailure,
  askUserMemoryModel,
  userMemoryModel,
  USER_MEMORY_JOB_RETRY,
} from "./llm";
import { UserMemoryService, type UserMemoryApplied, type UserMemoryWriter } from "./service";
import { UserMemoryStore, type UserMemoryEntryRow } from "./store";

export const userMemoryExtractJobSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  ownerUserId: z.string().min(1),
  messageId: z.string().min(1),
});
export type UserMemoryExtractJob = z.infer<typeof userMemoryExtractJobSchema>;

/** How long after an extraction that changed memory the recent-focus summary is rewritten. */
export const USER_MEMORY_CONSOLIDATE_DELAY_MS = 5 * 60 * 1000;
const EXTRACT_MAX_TOKENS = 1_200;
/** The tail of the agent's reply the model reads; the final answer is at the end. */
const AGENT_REPLY_MAX_CHARS = 4_000;
const USER_MESSAGE_MAX_CHARS = 4_000;
const MAX_OPS = 10;
/** Share of character pairs two texts must have in common to count as the same fact. */
const SAME_FACT_SHARE = 0.6;
/** Token events one turn may have (one per text part); the Claude harness writes one. */
const MAX_REPLY_PARTS = 50;
/** Current entries the prompt lists per layer, newest first. */
const PROMPT_ENTRIES: Readonly<Partial<Record<UserMemoryLayer, number>>> = {
  profile: USER_MEMORY_LIMITS.profileEntries,
  preference: USER_MEMORY_LIMITS.preferenceEntries,
  lesson: 30,
  project: 10,
};

/** A user message that is only a go-ahead ("continue", "ok", "好", "继续", "thanks"). */
const GO_AHEAD =
  /^(?:continue|go on|go ahead|keep going|ok(?:ay)?|yes|yep|yeah|sure|thanks|thank you|thx|好的?|好吧|行|可以|嗯+|继续|谢谢|收到)$/i;

export function userMemoryExtractBatchId(messageId: string): string {
  return `extract:${messageId}`;
}

/** Whether a user message carries nothing to remember: at most four characters, or a go-ahead. */
export function isTrivialUserMessage(text: string): boolean {
  if (text.replace(/\s+/g, "").length <= 4) return true;
  return GO_AHEAD.test(text.trim().replace(/[\s.!?。！？~～,，]+$/u, ""));
}

const logger = createLogger("user-memory");

/**
 * Sessions a person started by talking: in this deployment's own web client (`user`) or in a
 * product's (`app`, whose backend acts for its user). Agents, automations and bots write
 * prompts no person said.
 */
const PERSON_SPAWN_SOURCES: ReadonlySet<string> = new Set(["user", "app"]);

/**
 * Queue the extraction of a turn that finished well, when this deployment has a model for it
 * and the session is a person's own (PERSON_SPAWN_SOURCES; not spawned by an agent or an
 * automation, whose prompts are not the person talking).
 */
export async function queueUserMemoryExtraction(
  env: Env,
  readSession: () => Promise<SessionEntry | null>,
  messageId: string
): Promise<void> {
  if (!userMemoryModel(env, logger)) return;
  const session = await readSession();
  if (
    !session?.userId ||
    session.parentSessionId ||
    !PERSON_SPAWN_SOURCES.has(session.spawnSource ?? "user")
  ) {
    return;
  }
  await env.JOBS.send({
    kind: "user_memory.extract",
    payload: { version: 1, sessionId: session.id, ownerUserId: session.userId, messageId },
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 86_400_000;

/** Today with its weekday, and the dates of this week and next (Monday first): models get weekdays wrong. */
function calendarFor(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  const named = (ms: number) => {
    const date = new Date(ms);
    return `${WEEKDAYS[date.getUTCDay()]} ${date.toISOString().slice(0, 10)}`;
  };
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS;
  const week = (start: number) =>
    Array.from({ length: 7 }, (_, offset) => named(start + offset * DAY_MS)).join(", ");
  return `Today is ${named(day.getTime())}. This week: ${week(monday)}. Next week: ${week(monday + 7 * DAY_MS)}.`;
}

/** The extraction's instructions (the job and the memory eval share them). */
export function userMemoryExtractionSystemPrompt(today: string): string {
  const chars = USER_MEMORY_LIMITS.contentChars;
  const projectChars = USER_MEMORY_LIMITS.projectContentChars;
  return [
    "You keep the long-term memory of a user of an AI agent. After each turn you read what the user said and what the agent replied, and decide what is worth remembering for their FUTURE sessions.",
    "",
    "What to remember, only durable facts about THIS user:",
    "- profile.<field>: who the user is, in the user's own words: name, role, what they do, city or time zone, language. Only suggest a field that is not set yet, or replace your own pending suggestion; a field marked \"set by the user\" is theirs, never set or forget it. Every profile write waits for the user's approval.",
    "- pref.<topic>: stable likes and dislikes, one topic per key (separate topics are separate keys, never merged into one).",
    "- lesson.<topic>: what worked or failed for this user's own work and why.",
    `- project.<yyyy-mm-dd>.<short-name>: one per piece of work, dated today when first written: what it is, what was used, any date that matters for it (always as yyyy-mm-dd), and how the user reacted. Write it in the turn the work is first delivered, in under ${chars} characters so later reactions fit; append later reactions and the final approval to it.`,
    "",
    "Never remember, in any entry (projects included): settings for this one piece of work only (they go in its project entry, never in pref), tools, models or the sandbox misbehaving (errors, timeouts, retries and their workarounds), progress or status, costs, file paths, ids, URLs, anything about other people, sensitive personal data.",
    "",
    "How to write:",
    "- Keys are lowercase ASCII after the prefix (a-z, 0-9, hyphens, underscores) whatever language the user writes in: project.2026-10-03.new-product-teaser, never project.2026-10-03.新品预热.",
    "- Prefer updating an existing key (listed with its current text) over creating a new one; never touch a locked key.",
    '- An entry marked "saved this turn" is what the agent already wrote during this very turn: it already holds the turn, so never set it again, never forget it, and never write the same fact under another key; at most append what the user said that it leaves out.',
    '- set replaces the whole entry, so write all of it: keep every part of the current text the user did not change (current "short answers, no emoji", user says "and no bullet lists" → "short answers, no emoji, no bullet lists").',
    `- One line, in the user's language, third person, terse: at most ${chars} characters, a project entry at most ${projectChars}.`,
    "- append adds to the end of an entry; when the entry would pass its limit, set it again as a shorter summary instead.",
    "- Record a reaction in the user's terms, both what they liked and what they want changed; call a piece of work approved only when they approved it. A reaction that states a lasting preference is also set as that preference.",
    "- Every date in an entry is an absolute yyyy-mm-dd looked up in the calendar below, never 下周五 or next Friday: 下周五 or next Friday is the Friday in next week's list, 这周五 or this Friday the one in this week's list.",
    '- "said": true only when the user explicitly said it in this turn; otherwise it is your inference.',
    `- At most ${MAX_OPS} ops.`,
    '- If nothing durable happened, return {"ops": []}.',
    "",
    `Calendar: ${calendarFor(today)}`,
    "",
    'Answer with JSON only: {"ops":[{"op":"set"|"append"|"forget","key":"…","content":"…","said":true|false}]}',
  ].join("\n");
}

function memoryForPrompt(
  rows: readonly UserMemoryEntryRow[],
  savedThisTurn: ReadonlySet<string>
): string {
  const lines: string[] = [];
  for (const [layer, limit] of Object.entries(PROMPT_ENTRIES)) {
    const shown = rows.filter((row) => row.layer === layer).slice(0, limit);
    for (const row of shown) {
      const flags = [
        row.layer === "profile" && row.status === "active" ? "set by the user" : null,
        row.locked ? "locked" : null,
        row.status === "pending" ? "pending" : null,
        savedThisTurn.has(row.key) ? "saved this turn" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`${row.key}${flags ? ` (${flags})` : ""}: ${row.content}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/**
 * What the extraction is shown about one turn: the current memory (the keys the agent saved
 * during the turn marked) and the turn.
 */
export function userMemoryExtractionPrompt(
  rows: readonly UserMemoryEntryRow[],
  turn: Pick<Turn, "user" | "agent">,
  savedThisTurn: ReadonlySet<string> = new Set()
): string {
  return [
    "<memory>",
    memoryForPrompt(rows, savedThisTurn),
    "</memory>",
    "<turn>",
    `<user>${tail(turn.user, USER_MESSAGE_MAX_CHARS)}</user>`,
    `<agent>${tail(turn.agent, AGENT_REPLY_MAX_CHARS)}</agent>`,
    "</turn>",
  ].join("\n");
}

/** The model's answer as `{ ops }`, or null when it is not that JSON. */
export function parseExtraction(text: string): { ops: unknown[] } | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ops } = value as Record<string, unknown>;
  if (!Array.isArray(ops)) return null;
  return { ops };
}

/** A short stable tag for a name that is not ASCII (FNV-1a, base 36). */
function nameTag(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 5);
}

/**
 * Keys are ASCII, but a model writing for a Chinese-speaking user sometimes names them in Chinese
 * (`project.2026-10-03.新品预热`). Such a segment keeps its ASCII part and gets a tag of the
 * whole name, so the same name maps to the same key from one turn to the next.
 */
function asciiKey(key: string): string {
  return key
    .split(".")
    .map((segment, index) => {
      if (index === 0 || /^[a-z0-9][a-z0-9_-]*$/.test(segment)) return segment;
      const ascii = segment.replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
      return `${ascii || "item"}-${nameTag(segment)}`;
    })
    .join(".");
}

/** One proposed op in the `mem` shape, or null when it is not a valid one. */
export function normalizeExtractedOp(raw: unknown): UserMemoryOpInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const proposed = raw as Record<string, unknown>;
  const key =
    typeof proposed.key === "string" ? asciiKey(proposed.key.trim().toLowerCase()) : proposed.key;
  const candidate =
    proposed.op === "forget"
      ? {
          op: "forget",
          key,
          ...(typeof proposed.reason === "string" ? { reason: proposed.reason.slice(0, 200) } : {}),
        }
      : {
          // A model sometimes leaves out "op" for what can only be a set.
          op: proposed.op ?? (typeof proposed.content === "string" ? "set" : undefined),
          key,
          content: proposed.content,
          ...(proposed.said === true ? { said: true } : {}),
        };
  const parsed = userMemoryOpInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

interface Turn {
  user: string;
  /** Who sent the message, when the session recorded it. */
  authorUserId: string | null;
  agent: string;
  /** When the user's message was recorded (ms). */
  startedAt: number;
}

/** The turn's prompt and the agent's reply, read from the session's events. */
async function readTurn(
  sessions: SessionRuntimeClient,
  sessionId: string,
  messageId: string
): Promise<Turn | null> {
  const list = async (type: "user_message" | "token", limit: number) => {
    const search = new URLSearchParams({ message_id: messageId, type, limit: String(limit) });
    const response = await sessions.fetch(
      sessionId,
      SessionInternalPaths.events,
      { method: "GET" },
      `?${search}`
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The session's events answered ${response.status}`);
    }
    return listEventsResponseSchema.parse(await response.json()).events;
  };
  const [prompts, parts] = await Promise.all([
    list("user_message", 1),
    list("token", MAX_REPLY_PARTS),
  ]);
  const prompt = prompts[0]?.data;
  if (typeof prompt?.content !== "string") return null;
  const author = prompt.author as { userId?: unknown } | undefined;
  return {
    user: prompt.content,
    authorUserId: typeof author?.userId === "string" ? author.userId : null,
    startedAt: prompts[0]!.createdAt,
    agent: [...parts]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((part) => (typeof part.data.content === "string" ? part.data.content : ""))
      .filter(Boolean)
      .join("\n\n"),
  };
}

export async function handleUserMemoryExtract(
  job: UserMemoryExtractJob,
  delivery: JobDelivery,
  deps: JobDeps
): Promise<JobOutcome> {
  const context = {
    job_kind: "user_memory.extract",
    session_id: job.sessionId,
    message_id: job.messageId,
    attempts: delivery.attempts,
    trace_id: deps.correlation.trace_id,
    request_id: deps.correlation.request_id,
  };
  const skip = (reason: string): JobOutcome => {
    deps.log.info("user_memory.extract_skipped", {
      ...context,
      event: "user_memory.extract_skipped",
      reason,
    });
    return "ack";
  };
  const model = userMemoryModel(deps.env, deps.log);
  if (!model) return skip("no_model");
  const owner = job.ownerUserId;
  const store = new UserMemoryStore(deps.db);
  const batchId = userMemoryExtractBatchId(job.messageId);
  if (await store.hasBatch(owner, batchId)) return skip("done");
  if (await store.isPaused(owner)) return skip("paused");

  const sessions = createSessionRuntimeClient(deps.env, deps.correlation);
  let turn: Turn | null;
  try {
    turn = await readTurn(sessions, job.sessionId, job.messageId);
  } catch (error) {
    deps.log.warn("user_memory.extract_turn_unavailable", {
      ...context,
      event: "user_memory.extract_turn_unavailable",
      error: error instanceof Error ? error : String(error),
    });
    return { retry: true, delayMs: USER_MEMORY_JOB_RETRY.retryDelayMs };
  }
  if (!turn) return skip("no_message");
  if (turn.authorUserId && turn.authorUserId !== owner) return skip("not_the_owner");
  if (isTrivialUserMessage(turn.user)) return skip("trivial");

  const now = Date.now();
  const [rows, agentWrote] = await Promise.all([
    store.listCurrent(owner, now),
    store.agentWritesSince(owner, job.sessionId, turn.startedAt),
  ]);
  let reply;
  try {
    reply = await askUserMemoryModel(model, {
      userId: owner,
      sessionId: job.sessionId,
      system: userMemoryExtractionSystemPrompt(new Date(now).toISOString().slice(0, 10)),
      prompt: userMemoryExtractionPrompt(rows, turn, new Set(agentWrote.map((write) => write.key))),
      maxTokens: EXTRACT_MAX_TOKENS,
      nowMs: now,
    });
  } catch (error) {
    return afterUserMemoryModelFailure(error, deps.log, context);
  }
  const usage = {
    model: reply.model,
    input_tokens: reply.inputTokens,
    output_tokens: reply.outputTokens,
    latency_ms: reply.latencyMs,
    stop_reason: reply.stopReason,
  };
  const extraction = parseExtraction(reply.text);
  if (!extraction) {
    deps.log.warn("user_memory.extract_unparsed", {
      ...context,
      ...usage,
      event: "user_memory.extract_unparsed",
      answer: reply.text.slice(0, 300),
    });
    return "ack";
  }

  const service = new UserMemoryService({ store, generateId: () => generateId() });
  const writer = {
    kind: "extractor",
    sessionId: job.sessionId,
    messageId: job.messageId,
  } as const;
  // Read after the model answered: an Undo clicked while it ran counts too.
  const userChanges = await store.userChangesSince(owner, turn.startedAt);
  const { ops, applied, leftToUser, leftToAgent } = await applyUserMemoryExtraction(
    service,
    owner,
    extraction,
    writer,
    batchId,
    userChanges,
    agentWrote
  );

  const update = applied ? UserMemoryService.updatedMessage(applied, writer) : null;
  if (update) {
    await broadcastUserMemoryEvent(sessions, job.sessionId, update).catch((error: unknown) => {
      deps.log.warn("user_memory.broadcast_failed", {
        ...context,
        event: "user_memory.broadcast_failed",
        error: error instanceof Error ? error : String(error),
      });
    });
    await deps.env.JOBS.send(
      {
        kind: "user_memory.consolidate",
        payload: { version: 1, ownerUserId: owner, sessionId: job.sessionId },
      },
      { delayMs: USER_MEMORY_CONSOLIDATE_DELAY_MS }
    ).catch((error: unknown) => {
      deps.log.warn("user_memory.consolidate_not_queued", {
        ...context,
        event: "user_memory.consolidate_not_queued",
        error: error instanceof Error ? error : String(error),
      });
    });
  }
  deps.log.info("user_memory.extracted", {
    ...context,
    ...usage,
    event: "user_memory.extracted",
    batch_id: batchId,
    proposed: extraction.ops.length,
    valid: ops.length,
    applied: applied?.changes.length ?? 0,
    outcomes: applied?.results.map((result) => result.outcome).join(",") ?? "",
    left_to_user: leftToUser,
    left_to_agent: leftToAgent,
  });
  return "ack";
}

/** Character pairs of a text without spaces or punctuation (works for Chinese as for English). */
function characterPairs(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")];
  const pairs = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    pairs.add(chars[index]! + chars[index + 1]!);
  }
  return pairs;
}

/**
 * Whether two texts say much the same thing (Dice similarity of their character pairs): a
 * paraphrase of a removed preference counts, an entry that only mentions it among other things
 * (a project's timeline) does not.
 */
export function saysMuchTheSame(left: string, right: string): boolean {
  const a = characterPairs(left);
  const b = characterPairs(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const pair of a) if (b.has(pair)) shared += 1;
  return (2 * shared) / (a.size + b.size) >= SAME_FACT_SHARE;
}

/** What the user did to memory since the turn began (see `userChangesSince`). */
export interface UserChanges {
  keys: ReadonlySet<string>;
  removed: readonly string[];
}

/** An entry the agent saved itself (`mem`) during the turn, with the text it left. */
export interface AgentWrite {
  key: string;
  content: string;
}

/** Whether an op only redoes what the agent saved this turn: forgets it, or restates one of its facts. */
function redoesAgentWrite(op: UserMemoryOpInput, agentWrote: readonly AgentWrite[]): boolean {
  if (op.op === "forget") return agentWrote.some((write) => write.key === op.key);
  return agentWrote.some((write) => saysMuchTheSame(write.content, op.content));
}

/**
 * Apply what the model proposed: valid ops (at most MAX_OPS) as the extraction. What the user
 * dealt with since the turn began is left alone: the keys they changed, undid, forgot or
 * declined, and any text much like what they took away (under whatever key the model picked).
 * The extraction reads the turn, not what the user did about it since. So is what the agent
 * saved itself during the turn (`agentWrote`): an op that forgets one of those keys or restates
 * one of those facts, under that key or another, is dropped; an append of something new still
 * applies. The job and the memory eval share it.
 */
export async function applyUserMemoryExtraction(
  service: UserMemoryService,
  ownerUserId: string,
  extraction: { ops: unknown[] },
  writer: Extract<UserMemoryWriter, { kind: "extractor" }>,
  batchId: string,
  userChanges: UserChanges = { keys: new Set(), removed: [] },
  agentWrote: readonly AgentWrite[] = []
): Promise<{
  ops: UserMemoryOpInput[];
  applied: UserMemoryApplied | null;
  leftToUser: number;
  leftToAgent: number;
}> {
  const normalized = extraction.ops
    .map(normalizeExtractedOp)
    .filter((op): op is UserMemoryOpInput => op !== null);
  const notTheUsers = normalized.filter(
    (op) =>
      !userChanges.keys.has(op.key) &&
      (op.op === "forget" || !userChanges.removed.some((text) => saysMuchTheSame(text, op.content)))
  );
  const ops = notTheUsers.filter((op) => !redoesAgentWrite(op, agentWrote)).slice(0, MAX_OPS);
  const applied = ops.length > 0 ? await service.applyOps(ownerUserId, ops, writer, batchId) : null;
  return {
    ops,
    applied,
    leftToUser: normalized.length - notTheUsers.length,
    leftToAgent: notTheUsers.length - ops.length,
  };
}
