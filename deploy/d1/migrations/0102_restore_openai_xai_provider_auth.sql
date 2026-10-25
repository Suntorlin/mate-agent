-- OpenAI and xAI come back (the OpenCode harness runs them), and the control plane again
-- requires one session_model_provider_auth row per subscription provider (openai, xai,
-- anthropic). 0100 seeded new sessions with the Anthropic row only and deleted the OpenAI and
-- xAI rows; this restores both as 0064 and 0076 had them.

-- 1. New sessions get all three rows again. The control plane upserts over them at create
--    with the resolved selections.
DROP TRIGGER IF EXISTS sessions_seed_legacy_provider_auth;
CREATE TRIGGER sessions_seed_legacy_provider_auth
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'openai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'xai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'anthropic', 'api_key', 'legacy_migration', NEW.created_at);
END;

-- 2. Existing sessions get back the OpenAI and xAI rows 0100 deleted, seeded as 0064 seeded
--    them, so the completeness check accepts them on resume.
INSERT INTO session_model_provider_auth
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT sessions.id, 'openai', 'legacy_scoped_oauth', NULL, 'legacy_migration', NULL,
       sessions.created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM session_model_provider_auth existing
  WHERE existing.session_id = sessions.id AND existing.provider = 'openai'
);

INSERT INTO session_model_provider_auth
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT sessions.id, 'xai', 'legacy_scoped_oauth', NULL, 'legacy_migration', NULL,
       sessions.created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM session_model_provider_auth existing
  WHERE existing.session_id = sessions.id AND existing.provider = 'xai'
);
