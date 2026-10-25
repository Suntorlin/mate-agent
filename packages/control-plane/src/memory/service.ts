/**
 * User memory over `UserMemoryStore` rows: who may write what, which status a write gets, and
 * what reads count as current (docs/USER_MEMORY.md):
 *
 * - A change writes a new version; nothing is overwritten. `append` extends
 *   the current text with " → <content>".
 * - What the user writes (`user_edit`) and what the agent records as said
 *   by them (`user_said`) is active at once, and so is a project record (what a
 *   session delivered). The agent's own inferences and whatever else the
 *   extraction did not hear the user say are pending until the user approves them.
 * - A locked key refuses every writer but the user (`locked`); a paused
 *   memory refuses every writer but the user (`paused`), who can always
 *   edit or delete what is theirs.
 * - A new key in a full layer is refused (`full`); text that is not memory
 *   (secrets, signed URLs, logs, several lines) is refused (`invalid`), and so
 *   is any write to `recent.*` but the summary job's.
 * - Every attempt is an op in the request's batch, and a batch can be undone.
 */

import {
  userMemoryContentChars,
  userMemoryContentProblem,
  userMemoryLayerForKey,
  USER_MEMORY_LIMITS,
  type UserMemoryChange,
  type UserMemoryContextCounts,
  type UserMemoryContextResponse,
  type UserMemoryEntry,
  type UserMemoryExport,
  type UserMemoryLayer,
  type UserMemoryListResponse,
  type UserMemoryOpInput,
  type UserMemoryOpOutcome,
  type UserMemoryOpResult,
  type UserMemoryRecallItem,
  type UserMemorySource,
  type UserMemoryStatus,
  type UserMemoryUpdatedMessage,
} from "@open-inspect/shared/types/user-memory";
import { USER_MEMORY_PAUSED_CONTEXT, renderUserMemoryContext } from "./context";
import { USER_MEMORY_RECALL_WEIGHTS, matchUserMemory } from "./search";
import {
  isCurrentUserMemoryRow,
  toUserMemoryEntry,
  type UserMemoryEntryRow,
  type UserMemoryOpKind,
  type UserMemoryOpRow,
  type UserMemoryStore,
} from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Candidates one "forget everything about …" preview lists; the forget route takes as many. */
const FORGET_PREVIEW_LIMIT = 200;

/** Current entries a layer may hold; a new key beyond this is `full`. */
const LAYER_CAPS: Readonly<Partial<Record<UserMemoryLayer, number>>> = {
  profile: USER_MEMORY_LIMITS.profileEntries,
  preference: USER_MEMORY_LIMITS.preferenceEntries,
  lesson: USER_MEMORY_LIMITS.lessonEntries,
  project: USER_MEMORY_LIMITS.projectEntries,
};

const LAYER_NAMES: Readonly<Record<UserMemoryLayer, string>> = {
  profile: "Profile fields",
  preference: "Preferences",
  lesson: "Lessons",
  project: "Projects",
  recent: "Recent",
};

export type UserMemoryErrorReason = "not_found" | "invalid" | "full" | "conflict";

const STATUS_BY_REASON: Record<UserMemoryErrorReason, number> = {
  not_found: 404,
  invalid: 400,
  full: 409,
  conflict: 409,
};

export class UserMemoryError extends Error {
  readonly status: number;
  constructor(
    readonly reason: UserMemoryErrorReason,
    message: string
  ) {
    super(message);
    this.name = "UserMemoryError";
    this.status = STATUS_BY_REASON[reason];
  }
}

/**
 * Who writes: the user in the memory page, the agent through `mem` in
 * a session's sandbox, the after-turn extraction, or the job that writes
 * `recent.summary`.
 */
export type UserMemoryWriter =
  | { kind: "user" }
  | { kind: "agent"; sessionId: string }
  | { kind: "extractor"; sessionId: string; messageId: string }
  | { kind: "consolidator"; sessionId: string | null };

export interface UserMemoryServiceDeps {
  store: UserMemoryStore;
  now?: () => number;
  generateId: () => string;
}

/** What one write request did. `changes` lists only what was applied. */
export interface UserMemoryApplied {
  batchId: string;
  results: UserMemoryOpResult[];
  changes: UserMemoryChange[];
  /** The source each applied change was written as, parallel to `changes`. */
  changeSources: UserMemorySource[];
}

interface OpContext {
  ownerUserId: string;
  writer: UserMemoryWriter;
  batchId: string;
  opId: string;
  paused: boolean;
}

interface OpOutcome {
  result: UserMemoryOpResult;
  change?: UserMemoryChange;
  source: UserMemorySource;
}

const EMPTY_COUNTS: UserMemoryContextCounts = {
  profile: 0,
  recent: false,
  preferences: 0,
  lessons: 0,
  projects: 0,
  pending: 0,
};

function opIdFor(batchId: string, index: number): string {
  return `${batchId}:${String(index).padStart(3, "0")}`;
}

function sourceFor(op: UserMemoryOpInput, writer: UserMemoryWriter): UserMemorySource {
  switch (writer.kind) {
    case "user":
      return "user_edit";
    case "agent":
      return op.op !== "forget" && op.said ? "user_said" : "agent";
    case "extractor":
    case "consolidator":
      return "extractor";
  }
}

/** The status a write gets, and whether it is the writer's own conclusion. */
function statusFor(
  op: Exclude<UserMemoryOpInput, { op: "forget" }>,
  writer: UserMemoryWriter,
  layer: UserMemoryLayer
): { status: UserMemoryStatus; isInference: boolean } {
  const said = op.said === true;
  if (writer.kind === "user") return { status: "active", isInference: false };
  // The profile is the user's to fill in: anyone else only suggests a field.
  if (layer === "profile") return { status: "pending", isInference: !said };
  switch (writer.kind) {
    case "agent": {
      const inference = !said && op.op === "set" && op.inference === true;
      return { status: inference ? "pending" : "active", isInference: inference };
    }
    case "extractor":
      // A project record is what the session delivered and how the user took it, not a guess.
      if (layer === "project") return { status: "active", isInference: false };
      return { status: said ? "active" : "pending", isInference: !said };
    case "consolidator":
      return { status: "active", isInference: false };
  }
}

function sessionOf(writer: UserMemoryWriter): string | null {
  return writer.kind === "user" ? null : writer.sessionId;
}

function messageOf(writer: UserMemoryWriter): string | null {
  return writer.kind === "extractor" ? writer.messageId : null;
}

/**
 * `recent.summary` is the one multi-line entry: at most three lines and
 * USER_MEMORY_LIMITS.recentSummaryChars, each line held to the same rules as
 * any entry. Returns the cleaned text or why it is not acceptable.
 */
function recentSummaryText(
  raw: string
): { ok: true; text: string } | { ok: false; problem: string } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: false, problem: "empty" };
  if (lines.length > 3) return { ok: false, problem: "at most three lines" };
  const text = lines.join("\n");
  if (text.length > USER_MEMORY_LIMITS.recentSummaryChars) {
    return {
      ok: false,
      problem: `longer than ${USER_MEMORY_LIMITS.recentSummaryChars} characters`,
    };
  }
  for (const line of lines) {
    const problem = userMemoryContentProblem(line);
    if (problem) return { ok: false, problem };
  }
  return { ok: true, text };
}

export class UserMemoryService {
  private readonly store: UserMemoryStore;
  private readonly now: () => number;

  constructor(private readonly deps: UserMemoryServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  newBatchId(prefix: "agent" | "edit" | "undo" | "consolidate"): string {
    return `${prefix}:${this.deps.generateId()}`;
  }

  // --- Writes ---------------------------------------------------------------------

  /**
   * Apply `ops` in order as one batch, logging every one. The user's
   * writes ignore the pause; everyone else's are refused while it is on.
   */
  async applyOps(
    ownerUserId: string,
    ops: readonly UserMemoryOpInput[],
    writer: UserMemoryWriter,
    batchId: string = this.newBatchId(writer.kind === "user" ? "edit" : "agent")
  ): Promise<UserMemoryApplied> {
    const paused = writer.kind === "user" ? false : await this.store.isPaused(ownerUserId);
    const applied: UserMemoryApplied = { batchId, results: [], changes: [], changeSources: [] };
    for (const [index, op] of ops.entries()) {
      const context: OpContext = {
        ownerUserId,
        writer,
        batchId,
        opId: opIdFor(batchId, index),
        paused,
      };
      const outcome = await this.applyOp(op, context);
      applied.results.push(outcome.result);
      if (outcome.change) {
        applied.changes.push(outcome.change);
        applied.changeSources.push(outcome.source);
      }
    }
    return applied;
  }

  private async applyOp(op: UserMemoryOpInput, context: OpContext): Promise<OpOutcome> {
    const source = sourceFor(op, context.writer);
    if (context.paused) {
      return this.refuse(op, context, source, "paused", "Memory is paused by the user");
    }
    const layer = userMemoryLayerForKey(op.key);
    if (layer === "recent" && context.writer.kind !== "consolidator") {
      return this.refuse(
        op,
        context,
        source,
        "invalid",
        "recent.* is written by the engine's own summary"
      );
    }
    // One retry: a concurrent writer that moved the key first fails this write's batch.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return op.op === "forget"
          ? await this.forgetKey(op, context, source, layer)
          : await this.writeKey(op, context, source, layer);
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
  }

  private async writeKey(
    op: Exclude<UserMemoryOpInput, { op: "forget" }>,
    context: OpContext,
    source: UserMemorySource,
    layer: UserMemoryLayer
  ): Promise<OpOutcome> {
    const now = this.now();
    const latest = await this.store.latestForKey(context.ownerUserId, op.key);
    const current = latest && isCurrentUserMemoryRow(latest, now) ? latest : null;
    const refusal = this.lockedFor(context, layer, current);
    if (refusal) return this.refuse(op, context, source, "locked", refusal, current ?? undefined);

    const content = this.contentFor(op, layer, current);
    if (!content.ok) {
      return content.unchanged && current
        ? this.unchanged(op, context, source, current)
        : this.refuse(op, context, source, "invalid", content.problem);
    }
    const { status, isInference } = statusFor(op, context.writer, layer);
    if (
      current &&
      current.content === content.text &&
      (current.status === "active" || status === "pending")
    ) {
      return this.unchanged(op, context, source, current);
    }
    if (!current) {
      const cap = LAYER_CAPS[layer];
      if (
        cap !== undefined &&
        (await this.store.countCurrent(context.ownerUserId, layer, now)) >= cap
      ) {
        return this.refuse(
          op,
          context,
          source,
          "full",
          `${LAYER_NAMES[layer]} are full (${cap}); merge or forget old ones first`
        );
      }
    }

    const row: UserMemoryEntryRow = {
      id: this.deps.generateId(),
      owner_user_id: context.ownerUserId,
      container: this.store.container,
      key: op.key,
      layer,
      content: content.text,
      source,
      status,
      locked: current?.locked ?? 0,
      version: (latest?.version ?? 0) + 1,
      is_latest: 1,
      relation: latest ? (op.op === "append" && current ? "extends" : "updates") : null,
      parent_id: latest?.id ?? null,
      is_inference: isInference ? 1 : 0,
      forget_after:
        op.op === "set"
          ? op.ttlDays === undefined
            ? null
            : now + op.ttlDays * DAY_MS
          : (current?.forget_after ?? null),
      forgotten_at: null,
      forget_reason: null,
      session_id: sessionOf(context.writer),
      batch_id: context.batchId,
      created_at: now,
      updated_at: now,
      last_used_at: null,
    };
    await this.store.writeVersion(
      row,
      latest?.id ?? null,
      this.opRow(context, source, now, {
        entry_id: row.id,
        key: op.key,
        op: op.op,
        before_content: current?.content ?? null,
        after_content: row.content,
        outcome: "applied",
      })
    );
    return {
      result: { key: op.key, outcome: "applied", entry: toUserMemoryEntry(row) },
      change: { op: op.op, key: op.key, layer, content: row.content, status },
      source,
    };
  }

  /** The text a set or append would store, or why it cannot (`unchanged` for a repeated append). */
  private contentFor(
    op: Exclude<UserMemoryOpInput, { op: "forget" }>,
    layer: UserMemoryLayer,
    current: UserMemoryEntryRow | null
  ): { ok: true; text: string } | { ok: false; problem: string; unchanged?: true } {
    if (layer === "recent") {
      const summary = recentSummaryText(op.content);
      return summary.ok ? summary : { ok: false, problem: summary.problem };
    }
    const text = op.content.trim();
    const problem = userMemoryContentProblem(text, layer);
    if (problem) return { ok: false, problem };
    if (op.op !== "append" || !current) return { ok: true, text };
    // A model appending sometimes copies the separator it sees in the entry.
    const addition = text.replace(/^(?:→\s*)+/, "");
    if (!addition || current.content === addition || current.content.endsWith(` → ${addition}`)) {
      return { ok: false, problem: "already there", unchanged: true };
    }
    const extended = `${current.content} → ${addition}`;
    if (userMemoryContentProblem(extended, layer)) {
      return {
        ok: false,
        problem: `the entry would grow past ${userMemoryContentChars(layer)} characters; set a shorter summary of it instead`,
      };
    }
    return { ok: true, text: extended };
  }

  private async forgetKey(
    op: Extract<UserMemoryOpInput, { op: "forget" }>,
    context: OpContext,
    source: UserMemorySource,
    layer: UserMemoryLayer
  ): Promise<OpOutcome> {
    const now = this.now();
    const latest = await this.store.latestForKey(context.ownerUserId, op.key);
    const current = latest && isCurrentUserMemoryRow(latest, now) ? latest : null;
    if (!current) return this.refuse(op, context, source, "missing", "Nothing to forget");
    const refusal = this.lockedFor(context, layer, current);
    if (refusal) return this.refuse(op, context, source, "locked", refusal, current ?? undefined);
    const forgotten = await this.store.forgetCurrent(
      context.ownerUserId,
      [current.id],
      {
        batchId: context.batchId,
        opId: context.opId,
        op: "forget",
        source,
        reason: op.reason ?? null,
        sessionId: sessionOf(context.writer),
        messageId: messageOf(context.writer),
      },
      now
    );
    if (forgotten === 0) throw new Error("The entry changed while it was being forgotten");
    return {
      result: { key: op.key, outcome: "applied", entry: toUserMemoryEntry(current) },
      change: { op: "forget", key: op.key, layer, content: null, status: current.status },
      source,
    };
  }

  /**
   * Why a writer other than the user may not change or forget `current`, or null when it may: the
   * user locked it, or it is a profile field the user has set (a pending suggestion can still be
   * replaced, which keeps an unapproved suggestion from hiding the value the user chose).
   */
  private lockedFor(
    context: OpContext,
    layer: UserMemoryLayer,
    current: UserMemoryEntryRow | null
  ): string | null {
    if (!current || context.writer.kind === "user") return null;
    if (current.locked) return "The user locked this entry";
    if (layer === "profile" && current.status === "active") {
      return "The user set this profile field; ask them to change it";
    }
    return null;
  }

  private async refuse(
    op: UserMemoryOpInput,
    context: OpContext,
    source: UserMemorySource,
    outcome: Exclude<UserMemoryOpOutcome, "applied" | "unchanged">,
    detail: string,
    current?: UserMemoryEntryRow
  ): Promise<OpOutcome> {
    const now = this.now();
    await this.store.logOp(
      this.opRow(context, source, now, {
        entry_id: current?.id ?? null,
        key: op.key,
        op: op.op,
        before_content: current?.content ?? null,
        after_content: op.op === "forget" ? null : op.content,
        outcome,
        detail,
      })
    );
    return { result: { key: op.key, outcome, detail }, source };
  }

  /** Log a write that changes nothing; `current` is null when the profile already holds it. */
  private async unchanged(
    op: UserMemoryOpInput,
    context: OpContext,
    source: UserMemorySource,
    current: UserMemoryEntryRow | null
  ): Promise<OpOutcome> {
    const now = this.now();
    const content = current?.content ?? (op.op === "forget" ? null : op.content.trim());
    await this.store.logOp(
      this.opRow(context, source, now, {
        entry_id: current?.id ?? null,
        key: op.key,
        op: op.op,
        before_content: content,
        after_content: content,
        outcome: "unchanged",
      })
    );
    return {
      result: {
        key: op.key,
        outcome: "unchanged",
        ...(current ? { entry: toUserMemoryEntry(current) } : {}),
      },
      source,
    };
  }

  private opRow(
    context: Pick<OpContext, "ownerUserId" | "writer" | "batchId" | "opId">,
    source: UserMemorySource,
    now: number,
    fields: Pick<
      UserMemoryOpRow,
      "entry_id" | "key" | "op" | "before_content" | "after_content" | "outcome"
    > &
      Partial<Pick<UserMemoryOpRow, "detail">>
  ): UserMemoryOpRow {
    return {
      id: context.opId,
      owner_user_id: context.ownerUserId,
      container: this.store.container,
      batch_id: context.batchId,
      detail: null,
      ...fields,
      source,
      session_id: sessionOf(context.writer),
      message_id: messageOf(context.writer),
      created_at: now,
    };
  }

  /** The live update a session shows for a write ("Remembered: …"), or null when nothing changed. */
  static updatedMessage(
    applied: UserMemoryApplied,
    writer: UserMemoryWriter
  ): UserMemoryUpdatedMessage | null {
    if (applied.changes.length === 0) return null;
    const source: UserMemorySource =
      writer.kind === "agent"
        ? applied.changeSources.every((each) => each === "user_said")
          ? "user_said"
          : "agent"
        : writer.kind === "user"
          ? "user_edit"
          : "extractor";
    return { type: "memory_updated", batchId: applied.batchId, source, changes: applied.changes };
  }

  // --- The memory page ------------------------------------------------------------

  async list(ownerUserId: string): Promise<UserMemoryListResponse> {
    const now = this.now();
    const [rows, paused] = await Promise.all([
      this.store.listCurrent(ownerUserId, now),
      this.store.isPaused(ownerUserId),
    ]);
    return { entries: rows.map(toUserMemoryEntry), paused };
  }

  /** The user adds (or rewrites) an entry. `created` is false when it already said that. */
  async create(
    ownerUserId: string,
    request: { key: string; content: string }
  ): Promise<{ entry: UserMemoryEntry; created: boolean }> {
    const { results } = await this.applyOps(
      ownerUserId,
      [{ op: "set", key: request.key, content: request.content }],
      { kind: "user" }
    );
    return this.savedEntry(results[0]!);
  }

  /** New text (a new version), a lock change, or both. */
  async update(
    ownerUserId: string,
    id: string,
    request: { content?: string; locked?: boolean }
  ): Promise<UserMemoryEntry> {
    const row = await this.requireCurrent(ownerUserId, id);
    const batchId = this.newBatchId("edit");
    let entry = toUserMemoryEntry(row);
    let opIndex = 0;
    if (request.content !== undefined) {
      const { results } = await this.applyOps(
        ownerUserId,
        [{ op: "set", key: row.key, content: request.content }],
        { kind: "user" },
        batchId
      );
      entry = this.savedEntry(results[0]!).entry;
      opIndex = 1;
    }
    if (request.locked !== undefined && request.locked !== entry.locked) {
      const now = this.now();
      const changed = await this.store.setLocked(
        ownerUserId,
        entry.id,
        request.locked,
        this.opRow(
          { ownerUserId, writer: { kind: "user" }, batchId, opId: opIdFor(batchId, opIndex) },
          "user_edit",
          now,
          {
            entry_id: entry.id,
            key: entry.key,
            op: request.locked ? "lock" : "unlock",
            before_content: null,
            after_content: null,
            outcome: "applied",
          }
        )
      );
      if (!changed) throw new UserMemoryError("conflict", "This entry changed; reload it");
      entry = { ...entry, locked: request.locked };
    }
    return entry;
  }

  private savedEntry(result: UserMemoryOpResult): { entry: UserMemoryEntry; created: boolean } {
    if ((result.outcome === "applied" || result.outcome === "unchanged") && result.entry) {
      return { entry: result.entry, created: result.outcome === "applied" };
    }
    const detail =
      result.detail ??
      (result.outcome === "unchanged"
        ? "The profile already says that"
        : `Not saved (${result.outcome})`);
    if (result.outcome === "invalid") throw new UserMemoryError("invalid", detail);
    if (result.outcome === "full") throw new UserMemoryError("full", detail);
    throw new UserMemoryError("conflict", detail);
  }

  /** Forget one current entry. */
  async forget(ownerUserId: string, id: string, reason?: string): Promise<number> {
    const row = await this.requireCurrent(ownerUserId, id);
    return this.forgetRows(ownerUserId, [row.id], "forget", reason ?? null);
  }

  /** Forget these entries (the previewed ones the user kept ticked); ids not current are skipped. */
  async forgetIds(ownerUserId: string, ids: readonly string[], reason?: string): Promise<number> {
    return this.forgetRows(ownerUserId, ids, "forget", reason ?? null);
  }

  /** Soft-forget everything current. */
  async clear(ownerUserId: string): Promise<number> {
    const batchId = this.newBatchId("edit");
    return this.store.forgetAllCurrent(
      ownerUserId,
      {
        batchId,
        op: "forget",
        source: "user_edit",
        reason: "cleared",
        sessionId: null,
        messageId: null,
      },
      this.now()
    );
  }

  private forgetRows(
    ownerUserId: string,
    ids: readonly string[],
    op: "forget" | "decline",
    reason: string | null
  ): Promise<number> {
    const batchId = this.newBatchId("edit");
    return this.store.forgetCurrent(
      ownerUserId,
      ids,
      {
        batchId,
        opId: ids.length === 1 ? opIdFor(batchId, 0) : undefined,
        op,
        source: "user_edit",
        reason,
        sessionId: null,
        messageId: null,
      },
      this.now()
    );
  }

  /** Make a pending entry active. */
  async approve(ownerUserId: string, id: string): Promise<UserMemoryEntry> {
    const row = await this.requireCurrent(ownerUserId, id);
    if (row.status === "active") return toUserMemoryEntry(row);
    const batchId = this.newBatchId("edit");
    const now = this.now();
    const context = {
      ownerUserId,
      writer: { kind: "user" } as const,
      batchId,
      opId: opIdFor(batchId, 0),
    };

    const approved = await this.store.approve(
      ownerUserId,
      row.id,
      this.opRow(context, "user_edit", now, {
        entry_id: row.id,
        key: row.key,
        op: "approve",
        before_content: row.content,
        after_content: row.content,
        outcome: "applied",
      }),
      now
    );
    if (!approved) throw new UserMemoryError("conflict", "This entry changed; reload it");
    return toUserMemoryEntry({ ...row, status: "active", updated_at: now });
  }

  /** Turn a suggestion down: it is forgotten. */
  async decline(ownerUserId: string, id: string): Promise<UserMemoryEntry> {
    const row = await this.requireCurrent(ownerUserId, id);
    const forgotten = await this.forgetRows(ownerUserId, [row.id], "decline", "declined");
    if (forgotten === 0) throw new UserMemoryError("conflict", "This entry changed; reload it");
    const now = this.now();
    return toUserMemoryEntry({
      ...row,
      forgotten_at: now,
      forget_reason: "declined",
      updated_at: now,
    });
  }

  /**
   * Undo what a batch applied, newest op first: a version it wrote steps down
   * for its parent (or is forgotten when it had none), an entry it forgot is
   * back, a lock or an approval is reversed. A key changed since by another
   * batch is left alone. Returns how many changes were undone.
   */
  async undo(ownerUserId: string, batchId: string): Promise<number> {
    const ops = await this.store.opsForBatch(ownerUserId, batchId);
    if (ops.length === 0) throw new UserMemoryError("not_found", "Nothing to undo");
    const undoBatchId = this.newBatchId("undo");
    let undone = 0;
    for (const op of [...ops].reverse()) {
      if (op.outcome !== "applied" || !op.entry_id) continue;
      const log = this.opRow(
        {
          ownerUserId,
          writer: { kind: "user" },
          batchId: undoBatchId,
          opId: opIdFor(undoBatchId, undone),
        },
        "user_edit",
        this.now(),
        {
          entry_id: op.entry_id,
          key: op.key,
          op: "undo",
          before_content: op.after_content,
          after_content: op.before_content,
          outcome: "applied",
          detail: `${op.op} ${op.id}`,
        }
      );
      if (await this.undoOp(ownerUserId, op, op.entry_id, log)) undone += 1;
    }
    return undone;
  }

  private async undoOp(
    ownerUserId: string,
    op: UserMemoryOpRow,
    entryId: string,
    log: UserMemoryOpRow
  ): Promise<boolean> {
    const now = log.created_at;
    const kind: UserMemoryOpKind = op.op;
    switch (kind) {
      case "set":
      case "append": {
        const row = await this.store.getOwned(ownerUserId, entryId);
        return row ? this.store.retireVersion(row, log, now) : false;
      }
      case "forget":
      case "decline":
        return this.store.restore(ownerUserId, entryId, log, now);
      case "lock":
      case "unlock":
        return this.store.setLocked(ownerUserId, entryId, kind === "unlock", log);
      case "approve": {
        const row = await this.store.getOwned(ownerUserId, entryId);
        if (!row) return false;
        return this.store.unapprove(ownerUserId, row.id, log, now);
      }
      default:
        return false;
    }
  }

  /** The current entries "forget everything about `query`" would remove, best match first. */
  async forgetPreview(ownerUserId: string, query: string): Promise<UserMemoryEntry[]> {
    const rows = await this.store.listCurrent(ownerUserId, this.now());
    return matchUserMemory(query, rows.map(toUserMemoryEntry))
      .slice(0, FORGET_PREVIEW_LIMIT)
      .map((match) => match.entry);
  }

  async export(ownerUserId: string): Promise<UserMemoryExport> {
    const rows = await this.store.listAllVersions(ownerUserId);
    return {
      exportedAt: this.now(),
      entries: rows.map((row) => ({
        ...toUserMemoryEntry(row),
        isLatest: row.is_latest === 1,
        forgottenAt: row.forgotten_at,
        forgetReason: row.forget_reason,
      })),
    };
  }

  async setPaused(ownerUserId: string, paused: boolean): Promise<{ paused: boolean }> {
    await this.store.setPaused(ownerUserId, paused, this.now());
    return { paused };
  }

  private async requireCurrent(ownerUserId: string, id: string): Promise<UserMemoryEntryRow> {
    const row = await this.store.getOwned(ownerUserId, id);
    if (!row || !isCurrentUserMemoryRow(row, this.now())) {
      throw new UserMemoryError("not_found", "Memory entry not found");
    }
    return row;
  }

  // --- The session's sandbox --------------------------------------------------------

  /** The session-start block, and which entries it holds. */
  async context(ownerUserId: string): Promise<UserMemoryContextResponse> {
    if (await this.store.isPaused(ownerUserId)) {
      return { text: USER_MEMORY_PAUSED_CONTEXT, entryIds: [], counts: EMPTY_COUNTS, paused: true };
    }
    const now = this.now();
    const rows = await this.store.listCurrent(ownerUserId, now);
    const context = renderUserMemoryContext(rows.map(toUserMemoryEntry));
    await this.store.markUsed(ownerUserId, context.entryIds, now);
    return { ...context, paused: false };
  }

  /**
   * Recall: active preferences, lessons and projects matching `query`, by
   * matched tokens times the layer weight, then recency. Nothing while paused.
   */
  async search(
    ownerUserId: string,
    query: string,
    options: { limit: number; exclude: ReadonlySet<string> }
  ): Promise<UserMemoryRecallItem[]> {
    if (await this.store.isPaused(ownerUserId)) return [];
    const now = this.now();
    const rows = await this.store.listCurrent(ownerUserId, now);
    const candidates = rows
      .filter((row) => row.status === "active" && !options.exclude.has(row.id))
      .map(toUserMemoryEntry);
    const results = matchUserMemory(query, candidates, USER_MEMORY_RECALL_WEIGHTS)
      .slice(0, options.limit)
      .map(({ entry }) => ({
        id: entry.id,
        key: entry.key,
        layer: entry.layer,
        content: entry.content,
        updatedAt: entry.updatedAt,
      }));
    await this.store.markUsed(
      ownerUserId,
      results.map((result) => result.id),
      now
    );
    return results;
  }
}
