/**
 * Rows of the user memory tables (migration 0087): every version of every
 * entry, the op log, the pause switch and the platform-lesson queue. Every
 * read a person or a sandbox drives is keyed by the owner, so an entry id
 * alone never reaches a row someone else owns.
 *
 * A key's versions form a chain through `parent_id`; exactly one row per key
 * is `is_latest` (a partial unique index holds that). A row that is latest but
 * forgotten, or whose `forget_after` has passed, is not current: reads treat
 * the key as gone. Each mutation below is one batch that also writes its op
 * row, and the op row is written from the same predicate as the change, so an
 * op is logged as applied exactly when the change happened.
 */

import type {
  UserMemoryEntry,
  UserMemoryLayer,
  UserMemoryOpOutcome,
  UserMemoryRelation,
  UserMemorySource,
  UserMemoryStatus,
} from "@open-inspect/shared/types/user-memory";
import { MAX_D1_QUERY_PARAMETERS } from "../db/query-limits";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

/** The visibility boundary entries are written under: the owner's own memory, for now. */
const USER_MEMORY_OWNER_CONTAINER = "owner";

/** A key soft-deleted (or lapsed) this long ago is deleted for good, with all its versions. */
export const USER_MEMORY_FORGOTTEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Op log rows older than this are deleted. */
export const USER_MEMORY_OP_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export interface UserMemoryEntryRow {
  id: string;
  owner_user_id: string;
  container: string;
  key: string;
  layer: UserMemoryLayer;
  content: string;
  source: UserMemorySource;
  status: UserMemoryStatus;
  locked: number;
  version: number;
  is_latest: number;
  relation: UserMemoryRelation | null;
  parent_id: string | null;
  is_inference: number;
  forget_after: number | null;
  forgotten_at: number | null;
  forget_reason: string | null;
  session_id: string | null;
  batch_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export type UserMemoryOpKind =
  | "set"
  | "append"
  | "forget"
  | "lock"
  | "unlock"
  | "approve"
  | "decline"
  | "restore"
  | "undo";

export interface UserMemoryOpRow {
  id: string;
  owner_user_id: string;
  container: string;
  batch_id: string;
  entry_id: string | null;
  key: string;
  op: UserMemoryOpKind;
  before_content: string | null;
  after_content: string | null;
  source: UserMemorySource;
  outcome: UserMemoryOpOutcome;
  detail: string | null;
  session_id: string | null;
  message_id: string | null;
  created_at: number;
}

/** Who wrote a forget, and why: the op fields a forget logs for every entry it touches. */
export interface UserMemoryForgetOp {
  batchId: string;
  /**
   * The op row's id when one entry is forgotten; without it each op row is
   * `<batchId>:<entry id>`.
   */
  opId?: string;
  op: Extract<UserMemoryOpKind, "forget" | "decline">;
  source: UserMemorySource;
  reason: string | null;
  sessionId: string | null;
  messageId: string | null;
}

export function toUserMemoryEntry(row: UserMemoryEntryRow): UserMemoryEntry {
  return {
    id: row.id,
    key: row.key,
    layer: row.layer,
    content: row.content,
    source: row.source,
    status: row.status,
    locked: row.locked === 1,
    version: row.version,
    relation: row.relation,
    isInference: row.is_inference === 1,
    forgetAfter: row.forget_after,
    sessionId: row.session_id,
    batchId: row.batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Whether `row` is its key's current entry at `now`: latest, not forgotten, not lapsed. */
export function isCurrentUserMemoryRow(row: UserMemoryEntryRow, now: number): boolean {
  return (
    row.is_latest === 1 &&
    row.forgotten_at === null &&
    (row.forget_after === null || row.forget_after >= now)
  );
}

const ENTRY_COLUMNS =
  "id, owner_user_id, container, key, layer, content, source, status, locked, version, " +
  "is_latest, relation, parent_id, is_inference, forget_after, forgotten_at, forget_reason, " +
  "session_id, batch_id, created_at, updated_at, last_used_at";

const OP_COLUMNS =
  "id, owner_user_id, container, batch_id, entry_id, key, op, before_content, after_content, " +
  "source, outcome, detail, session_id, message_id, created_at";

/** The live-entry predicate over `user_memory_entries`, binding `now` once. */
const CURRENT =
  "is_latest = 1 AND forgotten_at IS NULL AND (forget_after IS NULL OR forget_after >= ?)";

/** Ids per `IN (...)` list, leaving room for the statement's other parameters. */
const IDS_PER_STATEMENT = MAX_D1_QUERY_PARAMETERS - 20;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export class UserMemoryStore {
  constructor(
    private readonly db: SqlDatabase,
    /** The container this store reads and writes; new rows must carry it. */
    readonly container = USER_MEMORY_OWNER_CONTAINER
  ) {}

  // --- Entries: reads ---------------------------------------------------------

  /** The key's latest version, current or not. */
  async latestForKey(ownerUserId: string, key: string): Promise<UserMemoryEntryRow | null> {
    return this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM user_memory_entries
         WHERE owner_user_id = ? AND container = ? AND key = ? AND is_latest = 1`
      )
      .bind(ownerUserId, this.container, key)
      .first<UserMemoryEntryRow>();
  }

  async getOwned(ownerUserId: string, id: string): Promise<UserMemoryEntryRow | null> {
    return this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM user_memory_entries
         WHERE id = ? AND owner_user_id = ? AND container = ?`
      )
      .bind(id, ownerUserId, this.container)
      .first<UserMemoryEntryRow>();
  }

  /** Every current entry, newest first. */
  async listCurrent(ownerUserId: string, now: number): Promise<UserMemoryEntryRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM user_memory_entries
         WHERE owner_user_id = ? AND container = ? AND ${CURRENT}
         ORDER BY updated_at DESC, id`
      )
      .bind(ownerUserId, this.container, now)
      .all<UserMemoryEntryRow>();
    return result.results;
  }

  async countCurrent(ownerUserId: string, layer: UserMemoryLayer, now: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM user_memory_entries
         WHERE owner_user_id = ? AND container = ? AND layer = ? AND ${CURRENT}`
      )
      .bind(ownerUserId, this.container, layer, now)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  /** Every version of every key, forgotten ones included, for export. */
  async listAllVersions(ownerUserId: string): Promise<UserMemoryEntryRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM user_memory_entries
         WHERE owner_user_id = ? AND container = ?
         ORDER BY key, version`
      )
      .bind(ownerUserId, this.container)
      .all<UserMemoryEntryRow>();
    return result.results;
  }

  // --- Entries: writes --------------------------------------------------------

  /**
   * Make `row` the key's latest version, retiring `previousId`, and log `op`,
   * atomically. When another writer moved the key first, the insert breaks
   * the one-latest-per-key index and the whole batch fails: the caller reads
   * again rather than resurrecting what it read.
   */
  async writeVersion(
    row: UserMemoryEntryRow,
    previousId: string | null,
    op: UserMemoryOpRow
  ): Promise<void> {
    const statements: SqlStatement[] = [];
    if (previousId) {
      statements.push(
        this.db
          .prepare(
            `UPDATE user_memory_entries SET is_latest = 0
             WHERE id = ? AND owner_user_id = ? AND is_latest = 1`
          )
          .bind(previousId, row.owner_user_id)
      );
    }
    statements.push(this.insertEntry(row), this.insertOp(op));
    await this.db.batch(statements);
  }

  /**
   * Soft-forget whichever of `ids` are current, logging one op per entry
   * forgotten. Returns how many were.
   */
  async forgetCurrent(
    ownerUserId: string,
    ids: readonly string[],
    op: UserMemoryForgetOp,
    now: number
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const statements: SqlStatement[] = [];
    for (const group of chunks([...new Set(ids)], IDS_PER_STATEMENT)) {
      const placeholders = group.map(() => "?").join(", ");
      statements.push(
        ...this.forgetStatements(ownerUserId, `id IN (${placeholders})`, group, op, now)
      );
    }
    const results = await this.db.batch(statements);
    return results
      .filter((_, index) => index % 2 === 1)
      .reduce((total, result) => total + result.meta.changes, 0);
  }

  /** Soft-forget every current entry. Returns how many there were. */
  async forgetAllCurrent(
    ownerUserId: string,
    op: UserMemoryForgetOp,
    now: number
  ): Promise<number> {
    const [, forgotten] = await this.db.batch(
      this.forgetStatements(ownerUserId, "1 = 1", [], op, now)
    );
    return forgotten?.meta.changes ?? 0;
  }

  /**
   * Log, then forget, the current entries matching `where`. The op rows are
   * selected with the same predicate the update uses, before it runs, so an
   * entry gets an op row exactly when it is forgotten.
   */
  private forgetStatements(
    ownerUserId: string,
    where: string,
    whereValues: readonly unknown[],
    op: UserMemoryForgetOp,
    now: number
  ): [SqlStatement, SqlStatement] {
    const scope = `owner_user_id = ? AND container = ? AND ${CURRENT} AND ${where}`;
    const scopeValues = [ownerUserId, this.container, now, ...whereValues];
    return [
      this.db
        .prepare(
          `INSERT INTO user_memory_ops (${OP_COLUMNS})
           SELECT ${op.opId ? "?" : "? || ':' || id"}, owner_user_id, container, ?, id, key, ?,
                  content, NULL, ?, 'applied', ?, ?, ?, ?
           FROM user_memory_entries WHERE ${scope}`
        )
        .bind(
          op.opId ?? op.batchId,
          op.batchId,
          op.op,
          op.source,
          op.reason,
          op.sessionId,
          op.messageId,
          now,
          ...scopeValues
        ),
      this.db
        .prepare(
          `UPDATE user_memory_entries SET forgotten_at = ?, forget_reason = ?, updated_at = ?
           WHERE ${scope}`
        )
        .bind(now, op.reason, now, ...scopeValues),
    ];
  }

  /** Approve a current pending entry in place. Returns whether it was pending. */
  async approve(ownerUserId: string, id: string, op: UserMemoryOpRow, now: number) {
    return this.changeCurrent(
      ownerUserId,
      id,
      "status = 'pending'",
      "status = 'active', updated_at = ?",
      [now],
      op
    );
  }

  /** Lock or unlock a current entry in place. Returns whether the lock changed. */
  async setLocked(ownerUserId: string, id: string, locked: boolean, op: UserMemoryOpRow) {
    return this.changeCurrent(
      ownerUserId,
      id,
      `locked = ${locked ? 0 : 1}`,
      `locked = ${locked ? 1 : 0}`,
      [],
      op
    );
  }

  /**
   * Log `op` and apply `set` to entry `id` if it is current and matches
   * `condition`, atomically. Returns whether it applied.
   */
  private async changeCurrent(
    ownerUserId: string,
    id: string,
    condition: string,
    set: string,
    setValues: readonly unknown[],
    op: UserMemoryOpRow
  ): Promise<boolean> {
    const scope = `id = ? AND owner_user_id = ? AND container = ? AND ${CURRENT} AND ${condition}`;
    const scopeValues = [id, ownerUserId, this.container, op.created_at];
    const [, changed] = await this.db.batch([
      this.insertOpWhere(op, scope, scopeValues),
      this.db
        .prepare(`UPDATE user_memory_entries SET ${set} WHERE ${scope}`)
        .bind(...setValues, ...scopeValues),
    ]);
    return (changed?.meta.changes ?? 0) > 0;
  }

  /**
   * Undo a version a batch wrote: retire it (marked forgotten as undone) and
   * make its parent the key's latest again, or, without a parent, forget it.
   * Applies only while `row` is still the key's latest and not forgotten,
   * that is while nothing after the batch changed the key. Returns whether it
   * applied.
   */
  async retireVersion(row: UserMemoryEntryRow, op: UserMemoryOpRow, now: number): Promise<boolean> {
    const scope = `id = ? AND owner_user_id = ? AND container = ? AND is_latest = 1
                   AND forgotten_at IS NULL`;
    const scopeValues = [row.id, row.owner_user_id, this.container];
    const statements: SqlStatement[] = [
      this.insertOpWhere(op, scope, scopeValues),
      this.db
        .prepare(
          `UPDATE user_memory_entries SET ${row.parent_id ? "is_latest = 0, " : ""}
                  forgotten_at = ?, forget_reason = ?, updated_at = ?
           WHERE ${scope}`
        )
        .bind(now, "undone", now, ...scopeValues),
    ];
    if (row.parent_id) {
      // Only once the version above stepped down: the key then has no latest row.
      statements.push(
        this.db
          .prepare(
            `UPDATE user_memory_entries SET is_latest = 1
             WHERE id = ? AND owner_user_id = ? AND container = ? AND is_latest = 0
               AND NOT EXISTS (
                 SELECT 1 FROM user_memory_entries AS latest
                 WHERE latest.owner_user_id = ? AND latest.container = ? AND latest.key = ?
                   AND latest.is_latest = 1
               )`
          )
          .bind(
            row.parent_id,
            row.owner_user_id,
            this.container,
            row.owner_user_id,
            this.container,
            row.key
          )
      );
    }
    const results = await this.db.batch(statements);
    return (results[1]?.meta.changes ?? 0) > 0;
  }

  /**
   * Bring back a forgotten latest version, undoing a forget, a decline or a
   * profile approval. Returns whether it applied.
   */
  async restore(
    ownerUserId: string,
    id: string,
    op: UserMemoryOpRow,
    now: number
  ): Promise<boolean> {
    const scope = `id = ? AND owner_user_id = ? AND container = ? AND is_latest = 1
                   AND forgotten_at IS NOT NULL`;
    const scopeValues = [id, ownerUserId, this.container];
    const [, changed] = await this.db.batch([
      this.insertOpWhere(op, scope, scopeValues),
      this.db
        .prepare(
          `UPDATE user_memory_entries SET forgotten_at = NULL, forget_reason = NULL,
                  updated_at = ?
           WHERE ${scope}`
        )
        .bind(now, ...scopeValues),
    ]);
    return (changed?.meta.changes ?? 0) > 0;
  }

  /** Return a current entry to pending (undoing an approval). Returns whether it applied. */
  async unapprove(ownerUserId: string, id: string, op: UserMemoryOpRow, now: number) {
    return this.changeCurrent(
      ownerUserId,
      id,
      "status = 'active'",
      "status = 'pending', updated_at = ?",
      [now],
      op
    );
  }

  /** Record that these entries were handed to a session (context or recall). */
  async markUsed(ownerUserId: string, ids: readonly string[], now: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db.batch(
      chunks([...new Set(ids)], IDS_PER_STATEMENT).map((group) =>
        this.db
          .prepare(
            `UPDATE user_memory_entries SET last_used_at = ?
             WHERE owner_user_id = ? AND id IN (${group.map(() => "?").join(", ")})`
          )
          .bind(now, ownerUserId, ...group)
      )
    );
  }

  private insertEntry(row: UserMemoryEntryRow): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO user_memory_entries (${ENTRY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.owner_user_id,
        row.container,
        row.key,
        row.layer,
        row.content,
        row.source,
        row.status,
        row.locked,
        row.version,
        row.is_latest,
        row.relation,
        row.parent_id,
        row.is_inference,
        row.forget_after,
        row.forgotten_at,
        row.forget_reason,
        row.session_id,
        row.batch_id,
        row.created_at,
        row.updated_at,
        row.last_used_at
      );
  }

  // --- Ops ----------------------------------------------------------------------

  private opValues(op: UserMemoryOpRow): unknown[] {
    return [
      op.id,
      op.owner_user_id,
      op.container,
      op.batch_id,
      op.entry_id,
      op.key,
      op.op,
      op.before_content,
      op.after_content,
      op.source,
      op.outcome,
      op.detail,
      op.session_id,
      op.message_id,
      op.created_at,
    ];
  }

  private insertOp(op: UserMemoryOpRow): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO user_memory_ops (${OP_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...this.opValues(op));
  }

  /** Insert `op` only when an entry matches `scope` (evaluated before the change it logs). */
  private insertOpWhere(
    op: UserMemoryOpRow,
    scope: string,
    scopeValues: readonly unknown[]
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO user_memory_ops (${OP_COLUMNS})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM user_memory_entries WHERE ${scope})`
      )
      .bind(...this.opValues(op), ...scopeValues);
  }

  /** Log an op that changed nothing (refused, or unchanged). */
  async logOp(op: UserMemoryOpRow): Promise<void> {
    await this.insertOp(op).run();
  }

  /** The batch's ops, oldest first. */
  async opsForBatch(ownerUserId: string, batchId: string): Promise<UserMemoryOpRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${OP_COLUMNS} FROM user_memory_ops
         WHERE owner_user_id = ? AND batch_id = ?
         ORDER BY created_at, id`
      )
      .bind(ownerUserId, batchId)
      .all<UserMemoryOpRow>();
    return result.results;
  }

  async hasBatch(ownerUserId: string, batchId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM user_memory_ops WHERE owner_user_id = ? AND batch_id = ?")
      .bind(ownerUserId, batchId)
      .first<{ found: number }>();
    return row !== null;
  }

  /** When an op last touched `key`, whatever its outcome. */
  async lastOpAt(ownerUserId: string, key: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM user_memory_ops
         WHERE owner_user_id = ? AND container = ? AND key = ?`
      )
      .bind(ownerUserId, this.container, key)
      .first<{ at: number | null }>();
    return row?.at ?? null;
  }

  /**
   * What the user did to memory since `since`: every key they changed, undid, forgot or
   * declined, and the text they took away (undone, forgotten or declined).
   */
  async userChangesSince(
    ownerUserId: string,
    since: number
  ): Promise<{ keys: Set<string>; removed: string[] }> {
    const { results } = await this.db
      .prepare(
        `SELECT key, op, before_content FROM user_memory_ops
         WHERE owner_user_id = ? AND container = ? AND source = 'user_edit'
           AND outcome = 'applied' AND created_at >= ?`
      )
      .bind(ownerUserId, this.container, since)
      .all<{ key: string; op: UserMemoryOpKind; before_content: string | null }>();
    const removed = results
      .filter((row) => ["undo", "forget", "decline"].includes(row.op) && row.before_content)
      .map((row) => row.before_content!);
    return { keys: new Set(results.map((row) => row.key)), removed };
  }

  /**
   * What the agent itself wrote (`mem set` or `append`) in a session since `since`: the
   * text each key ended up with, oldest key first. The after-turn extraction leaves these alone.
   */
  async agentWritesSince(
    ownerUserId: string,
    sessionId: string,
    since: number
  ): Promise<Array<{ key: string; content: string }>> {
    const { results } = await this.db
      .prepare(
        `SELECT key, after_content FROM user_memory_ops
         WHERE owner_user_id = ? AND container = ? AND session_id = ?
           AND source IN ('agent', 'user_said') AND op IN ('set', 'append')
           AND outcome = 'applied' AND after_content IS NOT NULL AND created_at >= ?
         ORDER BY created_at ASC, id ASC`
      )
      .bind(ownerUserId, this.container, sessionId, since)
      .all<{ key: string; after_content: string }>();
    const latest = new Map<string, string>();
    for (const row of results) latest.set(row.key, row.after_content);
    return [...latest].map(([key, content]) => ({ key, content }));
  }

  /** Applied ops since `since`, newest first. */
  async appliedOpsSince(
    ownerUserId: string,
    since: number,
    limit: number
  ): Promise<UserMemoryOpRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${OP_COLUMNS} FROM user_memory_ops
         WHERE owner_user_id = ? AND container = ? AND outcome = 'applied' AND created_at >= ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .bind(ownerUserId, this.container, since, limit)
      .all<UserMemoryOpRow>();
    return result.results;
  }

  // --- Settings -----------------------------------------------------------------

  async isPaused(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT paused FROM user_memory_settings WHERE user_id = ?")
      .bind(userId)
      .first<{ paused: number }>();
    return row?.paused === 1;
  }

  async setPaused(userId: string, paused: boolean, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_memory_settings (user_id, paused, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET paused = excluded.paused,
           updated_at = excluded.updated_at`
      )
      .bind(userId, paused ? 1 : 0, now)
      .run();
  }

  // --- Platform lessons ---------------------------------------------------------

  // --- Retention ----------------------------------------------------------------

  /**
   * Delete, for every owner, the keys whose current version was forgotten
   * or lapsed more than USER_MEMORY_FORGOTTEN_RETENTION_MS ago (every version
   * of them), and ops older than USER_MEMORY_OP_RETENTION_MS.
   */
  async purge(now: number): Promise<{ entries: number; ops: number }> {
    const forgottenBefore = now - USER_MEMORY_FORGOTTEN_RETENTION_MS;
    const expired = `EXISTS (
      SELECT 1 FROM user_memory_entries AS current
      WHERE current.owner_user_id = user_memory_entries.owner_user_id
        AND current.container = user_memory_entries.container
        AND current.key = user_memory_entries.key
        AND current.is_latest = 1
        AND ((current.forgotten_at IS NOT NULL AND current.forgotten_at < ?)
          OR (current.forgotten_at IS NULL AND current.forget_after IS NOT NULL
              AND current.forget_after < ?))
    )`;
    // Counted first: a delete's change count also includes the parent links it nulls.
    const [counted, , ops] = await this.db.batch<{ count: number }>([
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM user_memory_entries WHERE ${expired}`)
        .bind(forgottenBefore, forgottenBefore),
      this.db
        .prepare(`DELETE FROM user_memory_entries WHERE ${expired}`)
        .bind(forgottenBefore, forgottenBefore),
      this.db
        .prepare("DELETE FROM user_memory_ops WHERE created_at < ?")
        .bind(now - USER_MEMORY_OP_RETENTION_MS),
    ]);
    return {
      entries: Number(counted?.results[0]?.count ?? 0),
      ops: ops?.meta.changes ?? 0,
    };
  }
}
