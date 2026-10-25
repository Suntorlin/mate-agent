-- Personal skills: a user's own private skills, plus per-user on/off choices
-- for the skills everyone gets.
--
-- A personal skill is an ordinary managed skill with an owner. It reuses the
-- immutable revision and file tables, so sessions pin it and sandboxes install
-- it exactly like a shared skill. `owner_user_id` NULL keeps today's meaning:
-- an installation-wide skill managed by administrators.

ALTER TABLE skills ADD COLUMN owner_user_id TEXT;
-- Example output shown with the skill: JSON {"sessionId","artifactId","kind"}.
ALTER TABLE skills ADD COLUMN cover_json TEXT;

-- Shared names stay unique across the installation, deleted rows included, as
-- before. Personal names are unique per owner among live skills, so deleting a
-- personal skill frees its name for the owner to save again.
DROP INDEX idx_skills_name;
CREATE UNIQUE INDEX idx_skills_name ON skills (lower(name)) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX idx_skills_owner_name
  ON skills (owner_user_id, lower(name))
  WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;

-- Per-user switches for skills the user does not own: `builtin:<name>` for a
-- skill baked into the sandbox image, or a shared skill's id. A missing row
-- means enabled.
CREATE TABLE user_skill_preferences (
  user_id    TEXT NOT NULL,
  skill_key  TEXT NOT NULL,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skill_key)
);

-- Built-in skills the session owner switched off, pinned with the session so
-- a restored sandbox installs the same set. JSON array of skill names.
ALTER TABLE session_skill_manifests
  ADD COLUMN disabled_bundled_skills TEXT NOT NULL DEFAULT '[]';
