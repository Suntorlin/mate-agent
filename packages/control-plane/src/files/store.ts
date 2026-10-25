/**
 * Rows of `user_files`. Every read a user drives is keyed by the owner, so a file id alone never
 * reaches a row someone else owns.
 */

import {
  type UserFile,
  type UserFileKind,
  type UserFileScope,
  type UserFileStatus,
} from "@open-inspect/shared/types/user-files";
import type { SqlDatabase } from "../db/sql-database";

export interface UserFileRow {
  id: string;
  owner_user_id: string;
  scope: UserFileScope;
  session_id: string | null;
  name: string;
  kind: UserFileKind;
  mime_type: string | null;
  size_bytes: number;
  object_key: string;
  status: UserFileStatus;
  upload_id: string | null;
  part_size_bytes: number;
  attached_at: number | null;
  created_at: number;
  updated_at: number;
}

export function toUserFile(row: UserFileRow): UserFile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: row.scope,
    status: row.status,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    sessionId: row.session_id,
    attachedAt: row.attached_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, owner_user_id, scope, session_id, name, kind, mime_type, size_bytes, object_key, status, " +
  "upload_id, part_size_bytes, attached_at, created_at, updated_at";

export type UserFilePatch = Partial<Pick<UserFileRow, "name" | "kind">>;

export class UserFileStore {
  constructor(private readonly db: SqlDatabase) {}

  async insert(row: UserFileRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_files (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.owner_user_id,
        row.scope,
        row.session_id,
        row.name,
        row.kind,
        row.mime_type,
        row.size_bytes,
        row.object_key,
        row.status,
        row.upload_id,
        row.part_size_bytes,
        row.attached_at,
        row.created_at,
        row.updated_at
      )
      .run();
  }

  async getOwned(id: string, ownerUserId: string): Promise<UserFileRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM user_files WHERE id = ? AND owner_user_id = ?`)
      .bind(id, ownerUserId)
      .first<UserFileRow>();
  }

  /** A file the session's sandbox may read: one of its inputs, or its owner's library. */
  async getForSession(
    id: string,
    sessionId: string,
    sessionOwnerUserId: string
  ): Promise<UserFileRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files
         WHERE id = ? AND status = 'ready'
           AND ((scope = 'input' AND session_id = ?)
             OR (scope = 'library' AND owner_user_id = ?))`
      )
      .bind(id, sessionId, sessionOwnerUserId)
      .first<UserFileRow>();
  }

  /** An unfinished upload of the same file, which a new upload resumes instead of restarting. */
  async findResumable(
    ownerUserId: string,
    scope: UserFileScope,
    name: string,
    sizeBytes: number,
    notBefore: number
  ): Promise<UserFileRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files
         WHERE owner_user_id = ? AND scope = ? AND name = ? AND size_bytes = ?
           AND status = 'uploading' AND session_id IS NULL AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .bind(ownerUserId, scope, name, sizeBytes, notBefore)
      .first<UserFileRow>();
  }

  async listOwned(ownerUserId: string, scope: UserFileScope): Promise<UserFileRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files WHERE owner_user_id = ? AND scope = ?
         ORDER BY created_at DESC, id`
      )
      .bind(ownerUserId, scope)
      .all<UserFileRow>();
    return result.results;
  }

  async listLibrary(ownerUserId: string): Promise<UserFileRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files
         WHERE owner_user_id = ? AND scope = 'library' AND status = 'ready'
         ORDER BY name, id`
      )
      .bind(ownerUserId)
      .all<UserFileRow>();
    return result.results;
  }

  async listSessionInputs(sessionId: string): Promise<UserFileRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files
         WHERE session_id = ? AND scope = 'input' AND status = 'ready'
         ORDER BY attached_at, id`
      )
      .bind(sessionId)
      .all<UserFileRow>();
    return result.results;
  }

  /** Bytes the owner holds, finished or not, so open uploads count against the quota. */
  async usedBytes(ownerUserId: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM user_files WHERE owner_user_id = ?"
      )
      .bind(ownerUserId)
      .first<{ used: number }>();
    return Number(row?.used ?? 0);
  }

  /**
   * The owner's bytes overall, which the quota counts, and within one scope,
   * which is what a list of that scope shows.
   */
  async usage(ownerUserId: string, scope: string): Promise<{ total: number; scoped: number }> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total,
                COALESCE(SUM(CASE WHEN scope = ? THEN size_bytes ELSE 0 END), 0) AS scoped
         FROM user_files WHERE owner_user_id = ?`
      )
      .bind(scope, ownerUserId)
      .first<{ total: number; scoped: number }>();
    return { total: Number(row?.total ?? 0), scoped: Number(row?.scoped ?? 0) };
  }

  /** Uploads left open, and inputs never sent, since `before`. */
  async listStale(ownerUserId: string, before: number): Promise<UserFileRow[]> {
    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM user_files
         WHERE owner_user_id = ? AND updated_at < ?
           AND (status = 'uploading' OR (scope = 'input' AND session_id IS NULL))`
      )
      .bind(ownerUserId, before)
      .all<UserFileRow>();
    return result.results;
  }

  async touch(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE user_files SET updated_at = ? WHERE id = ?").bind(now, id).run();
  }

  async markReady(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE user_files SET status = 'ready', upload_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'uploading'`
      )
      .bind(now, id)
      .run();
    return result.meta.changes > 0;
  }

  async update(id: string, ownerUserId: string, patch: UserFilePatch, now: number): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      assignments.push("name = ?");
      values.push(patch.name);
    }
    if (patch.kind !== undefined) {
      assignments.push("kind = ?");
      values.push(patch.kind);
    }
    if (assignments.length === 0) return;
    await this.db
      .prepare(
        `UPDATE user_files SET ${assignments.join(", ")}, updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
      .bind(...values, now, id, ownerUserId)
      .run();
  }

  /**
   * Attach the owner's finished, unattached inputs to a session. Returns how
   * many rows are now attached to it, counting ones already attached there.
   */
  async attachInputs(
    ids: readonly string[],
    ownerUserId: string,
    sessionId: string,
    now: number
  ): Promise<number> {
    const statements = ids.map((id) =>
      this.db
        .prepare(
          `UPDATE user_files SET session_id = ?, attached_at = ?, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND scope = 'input' AND status = 'ready'
             AND session_id IS NULL`
        )
        .bind(sessionId, now, now, id, ownerUserId)
    );
    await this.db.batch(statements);
    const placeholders = ids.map(() => "?").join(", ");
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS attached FROM user_files
         WHERE session_id = ? AND owner_user_id = ? AND id IN (${placeholders})`
      )
      .bind(sessionId, ownerUserId, ...ids)
      .first<{ attached: number }>();
    return Number(row?.attached ?? 0);
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM user_files WHERE id = ?").bind(id).run();
  }
}
