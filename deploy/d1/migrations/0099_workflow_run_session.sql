-- A dispatched workflow run executes inside a session's sandbox; the run
-- remembers which one so the sandbox's reports can be checked against it.
ALTER TABLE workflow_runs ADD COLUMN session_id TEXT;

CREATE INDEX idx_workflow_runs_session ON workflow_runs (session_id)
WHERE
  session_id IS NOT NULL;
