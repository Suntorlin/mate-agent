-- User workflows: a saved, parameterized DAG of skill scripts, and their runs.
-- A run freezes the definition it executes, so later edits never change what
-- a past run meant. Status vocabularies mirror shared/types/workflows.ts.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  source_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_workflows_owner ON workflows (owner_user_id, deleted_at, updated_at DESC);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'starting', 'running', 'completed', 'failed', 'canceled')
  ),
  failure_reason TEXT CHECK (
    failure_reason IN ('step_failed', 'boot_failed', 'execution_timeout', 'canceled', 'internal_error')
  ),
  params TEXT NOT NULL,
  definition TEXT NOT NULL,
  steps TEXT NOT NULL,
  executor_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  execution_deadline_at INTEGER,
  -- Unsuccessful terminals carry a reason; every other status carries none.
  CHECK ((failure_reason IS NOT NULL) = (status IN ('failed', 'canceled')))
);

CREATE INDEX idx_workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);

CREATE INDEX idx_workflow_runs_claimable ON workflow_runs (status, created_at)
WHERE
  status IN ('queued', 'starting', 'running');
