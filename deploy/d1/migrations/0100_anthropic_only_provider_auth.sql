-- Sessions run on the Claude harness alone: a new session is seeded with the Anthropic row only,
-- and the OpenAI and xAI rows earlier sessions were given go.
DROP TRIGGER IF EXISTS sessions_seed_legacy_provider_auth;
CREATE TRIGGER sessions_seed_legacy_provider_auth
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'anthropic', 'api_key', 'legacy_migration', NEW.created_at);
END;

DELETE FROM session_model_provider_auth WHERE provider <> 'anthropic';
