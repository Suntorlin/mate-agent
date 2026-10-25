-- The model tier (flagship / standard / economy) a session runs on, for
-- the session list. NULL for sessions without one. It changes together with
-- `model` when the owner switches tiers; the session's own row is authoritative.

ALTER TABLE sessions ADD COLUMN model_tier TEXT;
