import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { EnvironmentStore, type EnvironmentRow } from "../../src/db/environments";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

it("persists explicit team and workspace ownership through the stores", async () => {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_explicit', 'explicit', 'Explicit', 1, 1)"
  ).run();
  const session = new SessionIndexStore(env.DB);
  const sessionInput: SessionEntry = {
    id: "explicit-session",
    title: null,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    ownerTeamId: "team_explicit",
    visibility: "team",
    createdAt: 1,
    updatedAt: 1,
  };
  await session.create(sessionInput);
  await session.create({
    ...sessionInput,
    id: "workspace-session",
    ownerTeamId: null,
    visibility: "workspace",
  });
  expect((await session.get("explicit-session"))?.ownerTeamId).toBe("team_explicit");
  expect((await session.get("explicit-session"))?.visibility).toBe("team");
  expect((await session.get("workspace-session"))?.ownerTeamId).toBeNull();

  const environments = new EnvironmentStore(env.DB);
  const environmentInput: EnvironmentRow = {
    id: "env_explicit",
    name: "Explicit",
    description: null,
    prebuild_enabled: 0,
    channel_associations: null,
    created_at: 1,
    updated_at: 1,
    owner_team_id: "team_explicit",
  };
  await environments.create(environmentInput, []);
  await environments.create({ ...environmentInput, id: "env_workspace", owner_team_id: null }, []);
  expect((await environments.getById("env_explicit"))?.owner_team_id).toBe("team_explicit");
  expect((await environments.getById("env_workspace"))?.owner_team_id).toBeNull();
  for (const [table, id] of [
    ["sessions", "explicit-session"],
    ["environments", "env_explicit"],
  ]) {
    expect(
      await env.DB.prepare(`SELECT owner_team_id FROM ${table} WHERE id = ?`).bind(id).first()
    ).toEqual({ owner_team_id: "team_explicit" });
  }
  for (const [table, id] of [
    ["sessions", "workspace-session"],
    ["environments", "env_workspace"],
  ]) {
    expect(
      await env.DB.prepare(`SELECT owner_team_id FROM ${table} WHERE id = ?`).bind(id).first()
    ).toEqual({ owner_team_id: null });
  }
});

it("reads legacy NULL ownership as workspace ownership", async () => {
  await env.DB.prepare(
    "INSERT INTO sessions (id, created_at, updated_at) VALUES ('null-session', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO environments (id, name, created_at, updated_at) VALUES ('env_null', 'Old', 1, 1)"
  ).run();
  expect((await new SessionIndexStore(env.DB).get("null-session"))?.ownerTeamId).toBeNull();
  expect((await new SessionIndexStore(env.DB).get("null-session"))?.visibility).toBe("workspace");
  expect((await new EnvironmentStore(env.DB).getById("env_null"))?.owner_team_id).toBeNull();
});
