import {
  skillCoverSchema,
  type SkillArt,
  type SkillContentInput,
  type SkillCover,
  type SkillFile,
  type SkillLocales,
} from "@open-inspect/shared/types/skills";
import { generateId } from "../auth/crypto";
import { buildValidatedSkillRevision } from "../skills/content-addressing";
import { isUniqueConstraintError } from "./errors";
import {
  parseSkillArt,
  parseSkillDisplayName,
  parseSkillLocales,
  skillArtJson,
  SkillConflictError,
  SkillStore,
  type SkillRow,
} from "./skills";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** A skill in its owner's private library. */
export interface PersonalSkill {
  id: string;
  name: string;
  /** What the owner calls it (SKILL.md `metadata.display_name`). */
  displayName: string | null;
  description: string;
  /** Its name and one line in other languages (SKILL.md `metadata`). */
  locales: SkillLocales;
  enabled: boolean;
  cover: SkillCover | null;
  art: SkillArt | null;
  revisionNumber: number;
  updatedAt: number;
}

export interface PersonalSkillWithFiles extends PersonalSkill {
  files: SkillFile[];
}

type PersonalSkillRow = SkillRow & { owner_user_id: string; cover_json: string | null };

function parseCover(value: string | null): SkillCover | null {
  if (!value) return null;
  try {
    const parsed = skillCoverSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Each user's private skills. They are managed skills with an owner, so they
 * share immutable revisions, files and session pinning with shared skills; this
 * store only ever touches rows the given owner holds.
 */
export class PersonalSkillStore {
  private readonly skills: SkillStore;

  constructor(private readonly db: SqlDatabase) {
    this.skills = new SkillStore(db);
  }

  async list(ownerUserId: string): Promise<PersonalSkill[]> {
    const result = await this.db
      .prepare(
        `${this.skills.currentSkillSelect()}
         WHERE s.owner_user_id = ? AND s.deleted_at IS NULL
         ORDER BY s.updated_at DESC, s.name`
      )
      .bind(ownerUserId)
      .all<PersonalSkillRow>();
    return (result.results ?? []).map((row) => this.toPersonal(row));
  }

  async get(id: string, ownerUserId: string): Promise<PersonalSkillWithFiles | null> {
    const row = await this.row(id, ownerUserId);
    if (!row) return null;
    return {
      ...this.toPersonal(row),
      files: await this.skills.filesForRevision(row.current_revision_id),
    };
  }

  async getByName(name: string, ownerUserId: string): Promise<PersonalSkill | null> {
    const row = await this.db
      .prepare(
        `${this.skills.currentSkillSelect()}
         WHERE s.owner_user_id = ? AND lower(s.name) = lower(?) AND s.deleted_at IS NULL`
      )
      .bind(ownerUserId, name)
      .first<PersonalSkillRow>();
    return row ? this.toPersonal(row) : null;
  }

  /** Whether a live shared skill holds this name, which would shadow a personal one. */
  async sharedNameTaken(name: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT id FROM skills
         WHERE owner_user_id IS NULL AND deleted_at IS NULL AND lower(name) = lower(?)`
      )
      .bind(name)
      .first<{ id: string }>();
    return row !== null;
  }

  /**
   * Create the owner's skill, or with `replace` move an existing one of the same
   * name to new content. Identical content keeps the current revision.
   *
   * @param cover - Example output to show; `undefined` keeps an existing one.
   */
  async save(
    ownerUserId: string,
    name: string,
    content: SkillContentInput,
    options: { replace: boolean; cover?: SkillCover | null }
  ): Promise<{ skill: PersonalSkill; created: boolean }> {
    const revision = await buildValidatedSkillRevision(name, content);
    const existing = await this.getByName(name, ownerUserId);
    const now = Date.now();
    if (existing) {
      if (!options.replace) {
        throw new SkillConflictError(`You already have a skill named ${name}`);
      }
      const current = await this.row(existing.id, ownerUserId);
      if (!current) throw new SkillConflictError("Skill changed concurrently");
      const statements: SqlStatement[] = [];
      let revisionId = current.current_revision_id;
      if (revision.revisionSha256 !== current.revision_sha256) {
        revisionId = `skillrev_${generateId()}`;
        statements.push(
          this.skills.revisionInsert(
            revisionId,
            current.id,
            current.revision_number + 1,
            content,
            revision,
            ownerUserId,
            now,
            current.current_revision_id
          ),
          ...this.skills.fileInserts(revisionId, revision.files)
        );
      }
      const updateIndex = statements.length;
      statements.push(
        this.db
          .prepare(
            `UPDATE skills SET current_revision_id = ?, cover_json = ?, enabled = 1,
               updated_by = ?, updated_at = ?
             WHERE id = ? AND owner_user_id = ? AND current_revision_id = ? AND deleted_at IS NULL`
          )
          .bind(
            revisionId,
            options.cover === undefined ? current.cover_json : this.coverJson(options.cover),
            ownerUserId,
            now,
            current.id,
            ownerUserId,
            current.current_revision_id
          ),
        this.skills.bumpGeneration()
      );
      const results = await this.db.batch(statements);
      if ((results[updateIndex]?.meta.changes ?? 0) === 0) {
        throw new SkillConflictError("Skill changed concurrently");
      }
      return { skill: (await this.getByName(name, ownerUserId))!, created: false };
    }

    const id = `skill_${generateId()}`;
    const revisionId = `skillrev_${generateId()}`;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO skills
             (id, name, current_revision_id, enabled, deleted_at, created_by, updated_by,
              created_at, updated_at, owner_user_id, cover_json)
             VALUES (?, ?, NULL, 1, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            name,
            ownerUserId,
            ownerUserId,
            now,
            now,
            ownerUserId,
            this.coverJson(options.cover ?? null)
          ),
        this.skills.revisionInsert(revisionId, id, 1, content, revision, ownerUserId, now),
        ...this.skills.fileInserts(revisionId, revision.files),
        this.db
          .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
          .bind(revisionId, id),
        this.skills.bumpGeneration(),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SkillConflictError(`You already have a skill named ${name}`);
      }
      throw error;
    }
    return { skill: (await this.getByName(name, ownerUserId))!, created: true };
  }

  async setEnabled(id: string, ownerUserId: string, enabled: boolean): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE skills SET enabled = ?, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
        )
        .bind(enabled ? 1 : 0, Date.now(), id, ownerUserId),
      this.skills.bumpGeneration(),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }

  /**
   * Set or clear the owner's cover choice. It belongs to the skill, not to a
   * revision: saving new content keeps it, and it changes nothing a session
   * installs.
   */
  async setArt(id: string, ownerUserId: string, art: SkillArt | null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE skills SET art_json = ?
         WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
      )
      .bind(skillArtJson(art), id, ownerUserId)
      .run();
  }

  /**
   * Set or clear the example output the owner shows with the skill. Like the
   * drawn cover it belongs to the skill, not to a revision; saving the skill
   * again from a session replaces it only when that save brings one.
   */
  async setCover(id: string, ownerUserId: string, cover: SkillCover | null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE skills SET cover_json = ?
         WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
      )
      .bind(this.coverJson(cover), id, ownerUserId)
      .run();
  }

  /**
   * Soft delete: sessions that pinned a revision keep it, and the owner can
   * save a new skill under the same name.
   */
  async delete(id: string, ownerUserId: string): Promise<boolean> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE skills SET deleted_at = ?, enabled = 0, updated_by = ?, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
        )
        .bind(now, ownerUserId, now, id, ownerUserId),
      this.skills.bumpGeneration(),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }

  private async row(id: string, ownerUserId: string): Promise<PersonalSkillRow | null> {
    return this.db
      .prepare(
        `${this.skills.currentSkillSelect()}
         WHERE s.id = ? AND s.owner_user_id = ? AND s.deleted_at IS NULL`
      )
      .bind(id, ownerUserId)
      .first<PersonalSkillRow>();
  }

  private coverJson(cover: SkillCover | null): string | null {
    return cover ? JSON.stringify(skillCoverSchema.parse(cover)) : null;
  }

  private toPersonal(row: PersonalSkillRow): PersonalSkill {
    return {
      id: row.id,
      name: row.name,
      displayName: parseSkillDisplayName(row.metadata_json),
      description: row.description,
      locales: parseSkillLocales(row.metadata_json),
      enabled: row.enabled === 1,
      cover: parseCover(row.cover_json),
      art: parseSkillArt(row.art_json),
      revisionNumber: row.revision_number,
      updatedAt: row.updated_at,
    };
  }
}

/** Per-user on/off switches for built-in and shared skills. A missing row means on. */
export class UserSkillPreferenceStore {
  constructor(private readonly db: SqlDatabase) {}

  async disabledKeys(userId: string): Promise<Set<string>> {
    const result = await this.db
      .prepare("SELECT skill_key FROM user_skill_preferences WHERE user_id = ? AND enabled = 0")
      .bind(userId)
      .all<{ skill_key: string }>();
    return new Set((result.results ?? []).map((row) => row.skill_key));
  }

  async set(userId: string, skillKey: string, enabled: boolean): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_skill_preferences (user_id, skill_key, enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, skill_key) DO UPDATE SET
           enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .bind(userId, skillKey, enabled ? 1 : 0, Date.now())
      .run();
  }
}
