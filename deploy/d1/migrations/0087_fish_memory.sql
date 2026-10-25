-- User memory (docs/USER_MEMORY.md): what the agent remembers about a user across sessions.
--
-- user_memory_entries holds every version of every entry. A change writes a new row that
-- `updates` or `extends` the previous one (parent_id) and moves is_latest to it, so history is
-- kept and a stale writer cannot bring back a value that was changed or forgotten. Forgetting
-- is soft (forgotten_at); a dated fact lapses at forget_after. container is the visibility
-- boundary, written as 'owner' for now (the owner's own memory)
-- and later 'user:<id>' or 'project:<id>'.

CREATE TABLE user_memory_entries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  key TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('preference', 'lesson', 'project', 'recent', 'profile')),
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user_edit', 'user_said', 'agent', 'extractor', 'import')),
  status TEXT NOT NULL CHECK (status IN ('active', 'pending')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  is_latest INTEGER NOT NULL CHECK (is_latest IN (0, 1)),
  relation TEXT CHECK (relation IN ('updates', 'extends', 'derives')),
  parent_id TEXT REFERENCES user_memory_entries(id) ON DELETE SET NULL,
  is_inference INTEGER NOT NULL DEFAULT 0 CHECK (is_inference IN (0, 1)),
  forget_after INTEGER,
  forgotten_at INTEGER,
  forget_reason TEXT,
  session_id TEXT,
  batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
-- One current version per key.
CREATE UNIQUE INDEX idx_user_memory_entries_latest
  ON user_memory_entries(owner_user_id, container, key) WHERE is_latest = 1;
CREATE INDEX idx_user_memory_entries_owner
  ON user_memory_entries(owner_user_id, is_latest, layer, updated_at DESC);
CREATE INDEX idx_user_memory_entries_batch ON user_memory_entries(batch_id);

-- Every attempted change, applied or refused (locked, full, paused, invalid), for audit, undo
-- and evaluation. A batch is one request: one turn's agent writes, one extraction, one edit.
CREATE TABLE user_memory_ops (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  entry_id TEXT,
  key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN (
    'set', 'append', 'forget', 'lock', 'unlock', 'approve', 'decline', 'restore', 'undo'
  )),
  before_content TEXT,
  after_content TEXT,
  source TEXT NOT NULL CHECK (source IN ('user_edit', 'user_said', 'agent', 'extractor', 'import')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'applied', 'unchanged', 'locked', 'full', 'paused', 'invalid', 'missing'
  )),
  detail TEXT,
  session_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_memory_ops_owner ON user_memory_ops(owner_user_id, created_at DESC);
CREATE INDEX idx_user_memory_ops_batch ON user_memory_ops(batch_id);

-- Memory switched off (or back on) by the user.
CREATE TABLE user_memory_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at INTEGER NOT NULL
);
