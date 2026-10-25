import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, serviceFetch } from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";

async function snapshotOf(stub: DurableObjectStub): Promise<SessionSnapshot["session"]> {
  const response = await stub.fetch("http://internal/internal/snapshot");
  expect(response.status).toBe(200);
  return (await response.json<SessionSnapshot>()).session;
}

function patchPermissionMode(name: string, body: unknown): Promise<Response> {
  return serviceFetch(`https://test.local/sessions/${name}/permission-mode`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("session permission mode", () => {
  beforeEach(cleanD1Tables);

  it("defaults a session created without a mode to never asking", async () => {
    const name = `permission-default-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    expect((await snapshotOf(stub)).permissionMode).toBe("full_auto");
  });

  it("stores the mode a session is created with and returns it when the session is read", async () => {
    const name = `permission-create-${Date.now()}`;
    const { stub } = await initNamedSession(name, { permissionMode: "auto_within_budget" });

    expect((await snapshotOf(stub)).permissionMode).toBe("auto_within_budget");
    const read = await serviceFetch(`https://test.local/sessions/${name}`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      session: { permissionMode: "auto_within_budget" },
    });
  });

  it("carries the mode from the create request into the session", async () => {
    const response = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Storyboard", permissionMode: "confirm_edits" }),
      service: "slack-bot",
      actor: "slack:U0123",
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();

    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    expect((await snapshotOf(stub)).permissionMode).toBe("confirm_edits");
  });

  it("refuses a create request with an unknown mode", async () => {
    const response = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Storyboard", permissionMode: "ask_always" }),
      service: "slack-bot",
      actor: "slack:U0123",
    });

    expect(response.status).toBe(400);
  });

  it("lets the owner change the mode for the rest of the session", async () => {
    const name = `permission-update-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      userId: BROWSER_USER_ID,
      canonicalUserId: BROWSER_USER_ID,
    });

    const response = await patchPermissionMode(name, { permissionMode: "confirm_edits" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ permissionMode: "confirm_edits" });
    expect((await snapshotOf(stub)).permissionMode).toBe("confirm_edits");
    await expect(
      queryDO<{ permission_mode: string }>(stub, "SELECT permission_mode FROM session")
    ).resolves.toEqual([{ permission_mode: "confirm_edits" }]);
  });

  it("lets the app service change the mode for the app user who owns the session, and no other", async () => {
    const owner = { service: "app", actor: "app:uid-owner" } as const;
    const created = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Storyboard", permissionMode: "auto_within_budget" }),
      ...owner,
    });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const patch = (actor: string) =>
      serviceFetch(`https://test.local/sessions/${sessionId}/permission-mode`, {
        method: "PATCH",
        body: JSON.stringify({ permissionMode: "confirm_edits" }),
        service: "app",
        actor,
      });

    const foreign = await patch("app:uid-someone-else");
    expect(foreign.status).toBeGreaterThanOrEqual(403);
    expect((await snapshotOf(stub)).permissionMode).toBe("auto_within_budget");

    const response = await patch(owner.actor);
    expect(response.status).toBe(200);
    expect((await snapshotOf(stub)).permissionMode).toBe("confirm_edits");
  });

  it("refuses a change from someone who does not own the session", async () => {
    const name = `permission-foreign-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      userId: "another-user",
      canonicalUserId: "22222222222222222222222222222222",
    });

    const response = await patchPermissionMode(name, { permissionMode: "auto_within_budget" });

    expect(response.status).toBe(403);
    expect((await snapshotOf(stub)).permissionMode).toBe("full_auto");
  });

  it.each([{ permissionMode: "ask_always" }, { permissionMode: "full_auto", extra: true }, {}])(
    "rejects invalid body %#",
    async (body) => {
      const name = `permission-invalid-${crypto.randomUUID()}`;
      await initNamedSession(name, { userId: BROWSER_USER_ID, canonicalUserId: BROWSER_USER_ID });

      expect((await patchPermissionMode(name, body)).status).toBe(400);
    }
  );
});
