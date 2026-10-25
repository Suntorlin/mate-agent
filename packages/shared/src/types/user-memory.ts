/**
 * User memory: what the agent remembers about a user across sessions, kept by the engine rather
 * than in files the agent edits. Memory entries are one short fact each, under a key whose
 * prefix names its layer (`profile.*`, `pref.*`, `lesson.*`, `project.*`, `recent.*`).
 *
 * Entries are never overwritten: a change writes a new version that `updates` (or `extends`) the
 * latest one, and only the newest version of a key is current. Forgetting is soft and can be
 * undone. Every write is logged as an op in a batch, so one turn's or one extraction's writes can
 * be undone together.
 *
 * Design: docs/USER_MEMORY.md.
 */

import { z } from "zod";

/** Every cap in one place: validation, prompt rendering and injection all read these. */
export const USER_MEMORY_LIMITS = Object.freeze({
  /** One entry's text, in characters. */
  contentChars: 300,
  /** A project entry's text: its reactions are appended to it, so it gets more room. */
  projectContentChars: 600,
  keyChars: 80,
  /** Current (latest, not forgotten) entries per layer; `full` beyond these. */
  profileEntries: 30,
  preferenceEntries: 40,
  lessonEntries: 60,
  projectEntries: 500,
  /** What the session-start block may hold, in estimated tokens (see `estimateTokens`). */
  injectionTokens: 2_000,
  /** Per-turn recall: results and characters per result. */
  recallResults: 5,
  /** Ops in one request. */
  opsPerRequest: 20,
  /** The generated recent-focus summary, in characters. */
  recentSummaryChars: 600,
  /** Days a recent-focus summary stays current without being regenerated. */
  recentSummaryDays: 14,
  /** Free text the user gives "forget everything about …", in characters. */
  forgetQueryChars: 200,
});

/**
 * How an entry is read, which its key prefix decides:
 * - `profile`: who the user is (name, role, time zone, language, whatever the product asks
 *   for); always injected first. Only the user sets a field directly: what the agent or the
 *   extraction writes is a pending suggestion until the user approves it.
 * - `preference`: stable likes and dislikes; injected at session start.
 * - `lesson`: what worked or failed for this user; the newest are injected, the rest recalled by
 *   relevance.
 * - `project`: one line per finished piece of work; the newest titles are injected.
 * - `recent`: the generated "what this user is working on now" summary.
 */
export const USER_MEMORY_LAYERS = ["profile", "preference", "lesson", "project", "recent"] as const;
export const userMemoryLayerSchema = z.enum(USER_MEMORY_LAYERS);
export type UserMemoryLayer = z.infer<typeof userMemoryLayerSchema>;

const LAYER_BY_PREFIX: Record<string, UserMemoryLayer> = {
  profile: "profile",
  pref: "preference",
  lesson: "lesson",
  project: "project",
  recent: "recent",
};

/**
 * `profile.name`, `pref.voice`, `lesson.product-closeups`, `project.2026-10-02.coffee-launch`,
 * `recent.summary`: a layer prefix and one to three lowercase segments.
 */
export const userMemoryKeySchema = z
  .string()
  .max(USER_MEMORY_LIMITS.keyChars)
  .regex(/^(profile|pref|lesson|project|recent)(\.[a-z0-9][a-z0-9_-]*){1,3}$/, {
    message:
      "Use a key like profile.<field>, pref.voice, lesson.<topic> or project.<yyyy-mm-dd>.<name>",
  });
export type UserMemoryKey = z.infer<typeof userMemoryKeySchema>;

export function userMemoryLayerForKey(key: string): UserMemoryLayer {
  const layer = LAYER_BY_PREFIX[key.split(".", 1)[0] ?? ""];
  if (!layer) throw new Error(`Not a memory key: ${key}`);
  return layer;
}

/**
 * Who wrote an entry: the user in the memory page (`user_edit`), the
 * agent recording something the user said (`user_said`) or concluded on
 * its own (`agent`), the after-turn extraction (`extractor`), or an import.
 */
export const USER_MEMORY_SOURCES = [
  "user_edit",
  "user_said",
  "agent",
  "extractor",
  "import",
] as const;
export const userMemorySourceSchema = z.enum(USER_MEMORY_SOURCES);
export type UserMemorySource = z.infer<typeof userMemorySourceSchema>;

/** `pending`: inferred or imported; used with less weight until approved. */
export const userMemoryStatusSchema = z.enum(["active", "pending"]);
export type UserMemoryStatus = z.infer<typeof userMemoryStatusSchema>;

/** How a version relates to the one before it (null for a key's first version). */
export const userMemoryRelationSchema = z.enum(["updates", "extends", "derives"]);
export type UserMemoryRelation = z.infer<typeof userMemoryRelationSchema>;

/** The current version of one key, as lists and the memory page show it. */
export const userMemoryEntrySchema = z.object({
  id: z.string(),
  key: userMemoryKeySchema,
  layer: userMemoryLayerSchema,
  content: z.string(),
  source: userMemorySourceSchema,
  status: userMemoryStatusSchema,
  locked: z.boolean(),
  version: z.number().int().positive(),
  relation: userMemoryRelationSchema.nullable(),
  isInference: z.boolean(),
  /** Epoch ms after which the entry stops being current (a dated fact); null when it does not lapse. */
  forgetAfter: z.number().nullable(),
  sessionId: z.string().nullable(),
  /** The batch that wrote this version: one turn's agent writes, one extraction or one edit. */
  batchId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type UserMemoryEntry = z.infer<typeof userMemoryEntrySchema>;

/** The most characters an entry of a layer may hold (a project timeline gets more). */
export function userMemoryContentChars(layer?: UserMemoryLayer): number {
  return layer === "project"
    ? USER_MEMORY_LIMITS.projectContentChars
    : USER_MEMORY_LIMITS.contentChars;
}

/**
 * Why a piece of text cannot be memory (in the given layer), or null when it
 * can. Mirrors `validate_content` in sandbox_runtime/memory.py: secrets,
 * signed URLs, logs and raw tool output never become memory.
 */
export function userMemoryContentProblem(text: string, layer?: UserMemoryLayer): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  const maxChars = userMemoryContentChars(layer);
  if (trimmed.length > maxChars) {
    return `longer than ${maxChars} characters; say it shorter`;
  }
  if (/[\r\n]/.test(trimmed)) return "one line only";
  if (
    /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(api|secret|access)[_-]?key\s*[:=]|password\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,})/i.test(
      trimmed
    )
  ) {
    return "looks like a secret";
  }
  if (/[?&](X-Amz-Signature|X-Amz-Credential|Signature|sig|token)=/i.test(trimmed)) {
    return "contains a signed URL";
  }
  if (
    /^(\$ |>>> |Traceback|\s*at [\w.$]+ \(|\{\s*"|\[\s*\{|drwx|-rw-)/.test(trimmed) ||
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?\S*\s*$/.test(trimmed)
  ) {
    return "looks like a log line or raw output";
  }
  return null;
}

/**
 * A rough token count for budgeting injected text: Claude spends about one
 * token per CJK character and one per four characters of other text.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    if (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(char)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

// --- Sandbox API (the agent's `mem` command) ---------------------------------

/**
 * `set` writes a key's next version (or its first). `append` extends a
 * timeline-style entry with "→ <content>". `forget` soft-deletes the key.
 * `said: true` marks what the user said themselves (current at once);
 * `inference: true` marks a conclusion of the agent's own (pending until
 * approved). `ttlDays` makes a dated fact lapse.
 */
export const userMemoryOpInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    key: userMemoryKeySchema,
    content: z.string(),
    said: z.boolean().optional(),
    inference: z.boolean().optional(),
    ttlDays: z.number().int().min(1).max(365).optional(),
  }),
  z.strictObject({
    op: z.literal("append"),
    key: userMemoryKeySchema,
    content: z.string(),
    said: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal("forget"),
    key: userMemoryKeySchema,
    reason: z.string().max(200).optional(),
  }),
]);
export type UserMemoryOpInput = z.infer<typeof userMemoryOpInputSchema>;

/** `POST /sessions/:id/memory/ops` */
export const userMemoryOpsRequestSchema = z.strictObject({
  ops: z.array(userMemoryOpInputSchema).min(1).max(USER_MEMORY_LIMITS.opsPerRequest),
});
export type UserMemoryOpsRequest = z.infer<typeof userMemoryOpsRequestSchema>;

/**
 * Why an op was not applied: the key is locked, its layer is full, memory is
 * paused, the content is not allowed (`invalid`), there is nothing to forget
 * (`missing`), or nothing changed (`unchanged`, which still counts as applied).
 */
export const userMemoryOpOutcomeSchema = z.enum([
  "applied",
  "unchanged",
  "locked",
  "full",
  "paused",
  "invalid",
  "missing",
]);
export type UserMemoryOpOutcome = z.infer<typeof userMemoryOpOutcomeSchema>;

export const userMemoryOpResultSchema = z.object({
  key: z.string(),
  outcome: userMemoryOpOutcomeSchema,
  /** For `invalid` and `full`: what to change. */
  detail: z.string().optional(),
  entry: userMemoryEntrySchema.optional(),
});
export type UserMemoryOpResult = z.infer<typeof userMemoryOpResultSchema>;

export const userMemoryOpsResponseSchema = z.object({
  batchId: z.string(),
  results: z.array(userMemoryOpResultSchema),
});
export type UserMemoryOpsResponse = z.infer<typeof userMemoryOpsResponseSchema>;

/** What the session-start block was built from, for the "Using memory" line. */
export const userMemoryContextCountsSchema = z.object({
  profile: z.number().int().nonnegative(),
  recent: z.boolean(),
  preferences: z.number().int().nonnegative(),
  lessons: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type UserMemoryContextCounts = z.infer<typeof userMemoryContextCountsSchema>;

/**
 * `GET /sessions/:id/memory/context`: the block injected at session
 * start (already rendered and trimmed to the injection budget) and the ids of
 * the entries in it, so per-turn recall does not repeat them.
 */
export const userMemoryContextResponseSchema = z.object({
  text: z.string(),
  entryIds: z.array(z.string()),
  counts: userMemoryContextCountsSchema,
  paused: z.boolean(),
});
export type UserMemoryContextResponse = z.infer<typeof userMemoryContextResponseSchema>;

export const userMemoryRecallItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  layer: userMemoryLayerSchema,
  content: z.string(),
  updatedAt: z.number(),
});
export type UserMemoryRecallItem = z.infer<typeof userMemoryRecallItemSchema>;

/** `GET /sessions/:id/memory/search?q=&limit=&exclude=id,id` */
export const userMemorySearchResponseSchema = z.object({
  results: z.array(userMemoryRecallItemSchema),
});
export type UserMemorySearchResponse = z.infer<typeof userMemorySearchResponseSchema>;

// --- Web API (the memory page) -------------------------------------------------

/** `GET /memory` (and `GET /sessions/:id/memory` for the agent). */
export const userMemoryListResponseSchema = z.object({
  entries: z.array(userMemoryEntrySchema),
  paused: z.boolean(),
});
export type UserMemoryListResponse = z.infer<typeof userMemoryListResponseSchema>;

/** `POST /memory/entries`: the user adds an entry. */
export const createUserMemoryEntryRequestSchema = z.strictObject({
  key: userMemoryKeySchema,
  content: z.string(),
});

/** `PATCH /memory/entries/:id`: new text (a new version) and/or the lock. */
export const updateUserMemoryEntryRequestSchema = z
  .strictObject({
    content: z.string().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => value.content !== undefined || value.locked !== undefined, {
    message: "Nothing to change",
  });

export const userMemoryEntryResponseSchema = z.object({ entry: userMemoryEntrySchema });

/** `POST /memory/forget-preview`: the entries "forget everything about …" would remove. */
export const userMemoryForgetPreviewRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(USER_MEMORY_LIMITS.forgetQueryChars),
});
export const userMemoryForgetPreviewResponseSchema = z.object({
  candidates: z.array(userMemoryEntrySchema),
});

/** `POST /memory/forget`: forget exactly these (the previewed ones the user kept ticked). */
export const userMemoryForgetRequestSchema = z.strictObject({
  ids: z.array(z.string()).min(1).max(200),
  reason: z.string().max(200).optional(),
});
export const userMemoryCountResponseSchema = z.object({ count: z.number().int().nonnegative() });

/** `PUT /memory/settings` */
export const userMemorySettingsSchema = z.strictObject({ paused: z.boolean() });
export type UserMemorySettings = z.infer<typeof userMemorySettingsSchema>;

/** `GET /memory/export`: everything, including past versions and forgotten entries. */
export const userMemoryExportSchema = z.object({
  exportedAt: z.number(),
  entries: z.array(
    userMemoryEntrySchema.extend({
      isLatest: z.boolean(),
      forgottenAt: z.number().nullable(),
      forgetReason: z.string().nullable(),
    })
  ),
});
export type UserMemoryExport = z.infer<typeof userMemoryExportSchema>;

// --- Live updates (server messages) ---------------------------------------------

export const userMemoryChangeSchema = z.object({
  op: z.enum(["set", "append", "forget"]),
  key: z.string(),
  layer: userMemoryLayerSchema,
  /** The new text, or null for `forget`. */
  content: z.string().nullable(),
  status: userMemoryStatusSchema,
});
export type UserMemoryChange = z.infer<typeof userMemoryChangeSchema>;

/** Broadcast to a session when its turn changed the user's memory ("Remembered: …"). */
export const userMemoryUpdatedMessageSchema = z.object({
  type: z.literal("memory_updated"),
  batchId: z.string(),
  source: userMemorySourceSchema,
  changes: z.array(userMemoryChangeSchema),
});
export type UserMemoryUpdatedMessage = z.infer<typeof userMemoryUpdatedMessageSchema>;

/** Broadcast when a session's sandbox loaded the user's memory ("Using memory: …"). */
export const userMemoryLoadedMessageSchema = z.object({
  type: z.literal("memory_loaded"),
  counts: userMemoryContextCountsSchema,
  paused: z.boolean(),
});
export type UserMemoryLoadedMessage = z.infer<typeof userMemoryLoadedMessageSchema>;
