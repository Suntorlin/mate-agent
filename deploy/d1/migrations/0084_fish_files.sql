-- User files: a user's asset library (scope 'library', kept across sessions) and the
-- files they bring into one session (scope 'input'; session_id is set when the message carrying
-- them is sent). Bytes live in the media bucket under object_key; a row is 'uploading' while its
-- multipart upload (upload_id) is open and 'ready' once completed.

CREATE TABLE user_files (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('library', 'input')),
  session_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'font', 'lut', 'logo', 'other')),
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  upload_id TEXT,
  part_size_bytes INTEGER NOT NULL,
  brand_role TEXT CHECK (brand_role IN ('font', 'logo', 'lut', 'intro', 'outro', 'other')),
  attached_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (scope = 'library' OR brand_role IS NULL),
  CHECK (scope = 'input' OR session_id IS NULL)
);
CREATE INDEX idx_user_files_owner ON user_files(owner_user_id, scope, created_at DESC);
CREATE INDEX idx_user_files_session ON user_files(session_id, attached_at);
