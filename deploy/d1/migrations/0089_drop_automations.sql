-- The engine runs only interactive sessions: scheduled and
-- event-triggered automations, their runs and their trigger bindings are gone
-- with the code that served them. Children are dropped before their parent.
DROP TABLE IF EXISTS automation_model_provider_auth;
DROP TABLE IF EXISTS automation_slack_channels;
DROP TABLE IF EXISTS automation_environments;
DROP TABLE IF EXISTS automation_repositories;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automation_invocations;
DROP TABLE IF EXISTS automations;
