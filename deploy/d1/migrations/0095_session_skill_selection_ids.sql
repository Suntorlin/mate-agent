-- Session skill manifests learn an explicit selection: mode 'ids' pins the
-- sessions to exactly the named skills, recorded in selected_skill_ids (a
-- JSON array). SQLite cannot extend a CHECK in place, so rebuild the table.
-- session_skill_revisions references session_skill_manifests(session_id), so
-- back it up without the foreign keys before dropping the parent and recreate
-- it afterwards (same pattern as 0029).

DROP TABLE IF EXISTS session_skill_revisions_backup;
DROP TABLE IF EXISTS session_skill_manifests_new;

CREATE TABLE session_skill_revisions_backup (
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  skill_id            TEXT NOT NULL,
  revision_id         TEXT NOT NULL,
  skill_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  revision_number     INTEGER NOT NULL,
  revision_sha256     TEXT NOT NULL,
  total_bytes         INTEGER NOT NULL,
  assignment_sources  TEXT NOT NULL
);

INSERT INTO session_skill_revisions_backup (
  session_id, position, skill_id, revision_id, skill_name, description,
  revision_number, revision_sha256, total_bytes, assignment_sources
)
SELECT session_id, position, skill_id, revision_id, skill_name, description,
       revision_number, revision_sha256, total_bytes, assignment_sources
FROM session_skill_revisions;

DROP TABLE session_skill_revisions;

CREATE TABLE session_skill_manifests_new (
  session_id              TEXT PRIMARY KEY,
  selection_mode          TEXT NOT NULL CHECK (selection_mode IN ('all', 'none', 'profile', 'ids')),
  profile_id              TEXT,
  profile_name            TEXT,
  -- JSON array of the skill ids an 'ids' selection named; NULL otherwise.
  selected_skill_ids      TEXT,
  resolver_version        INTEGER NOT NULL,
  manifest_sha256         TEXT NOT NULL,
  resolved_at             INTEGER NOT NULL,
  disabled_bundled_skills TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK (
    (selection_mode = 'profile' AND profile_id IS NOT NULL AND profile_name IS NOT NULL
      AND selected_skill_ids IS NULL)
    OR (selection_mode = 'ids' AND selected_skill_ids IS NOT NULL
      AND profile_id IS NULL AND profile_name IS NULL)
    OR (selection_mode IN ('all', 'none') AND profile_id IS NULL AND profile_name IS NULL
      AND selected_skill_ids IS NULL)
  )
);

INSERT INTO session_skill_manifests_new (
  session_id, selection_mode, profile_id, profile_name, resolver_version,
  manifest_sha256, resolved_at, disabled_bundled_skills
)
SELECT session_id, selection_mode, profile_id, profile_name, resolver_version,
       manifest_sha256, resolved_at, disabled_bundled_skills
FROM session_skill_manifests;

DROP TABLE session_skill_manifests;
ALTER TABLE session_skill_manifests_new RENAME TO session_skill_manifests;

CREATE TABLE session_skill_revisions (
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  skill_id            TEXT NOT NULL,
  revision_id         TEXT NOT NULL,
  skill_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  revision_number     INTEGER NOT NULL,
  revision_sha256     TEXT NOT NULL,
  total_bytes         INTEGER NOT NULL,
  assignment_sources  TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id) REFERENCES session_skill_manifests(session_id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, skill_id) REFERENCES skill_revisions(id, skill_id) ON DELETE RESTRICT
);

INSERT INTO session_skill_revisions (
  session_id, position, skill_id, revision_id, skill_name, description,
  revision_number, revision_sha256, total_bytes, assignment_sources
)
SELECT session_id, position, skill_id, revision_id, skill_name, description,
       revision_number, revision_sha256, total_bytes, assignment_sources
FROM session_skill_revisions_backup;

DROP TABLE session_skill_revisions_backup;
