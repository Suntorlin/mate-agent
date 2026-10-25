-- What a session card shows without opening the session: its first image or
-- video, and how many images and videos it has produced. Projected from the
-- session's own artifact table with the other per-session metrics.

ALTER TABLE sessions ADD COLUMN cover_artifact_id TEXT;
ALTER TABLE sessions ADD COLUMN cover_artifact_type TEXT;
ALTER TABLE sessions ADD COLUMN media_count INTEGER NOT NULL DEFAULT 0;
