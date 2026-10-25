-- Team management went with the routes that served it: channel bindings,
-- repository grants and team secrets have no reader or writer left. Teams and
-- memberships stay, since session visibility still reads them.
DROP TABLE IF EXISTS team_secrets;
DROP TABLE IF EXISTS team_channel_bindings;
DROP TABLE IF EXISTS team_repository_grants;
