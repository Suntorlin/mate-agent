import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  openClientWs,
  queryDO,
  routeRequest,
  seedTeam,
  serviceRequestHeaders,
} from "./helpers";

const BASE = "https://test.local";
// Two users signed in to the product; its backend (the app service) relays each as the actor.
const ALICE = "app:uid-alice";
const BOB = "app:uid-bob";

type Mode = "off" | "shadow" | "on";

interface CallOptions {
  method?: string;
  body?: unknown;
}

/** A request signed the way the app service signs it, on a deployment that shares sessions. */
async function call(
  mode: Mode,
  actor: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = await serviceRequestHeaders(url, {
    method,
    body,
    service: "app",
    actor,
  });
  return routeRequest(
    new Request(url, { method, headers, body }),
    { ...env, TEAMS_ENFORCEMENT: mode, DEFAULT_SESSION_VISIBILITY: "workspace" },
    createExecutionContext()
  );
}

async function createSession(mode: Mode, actor: string): Promise<string> {
  const response = await call(mode, actor, "/sessions", {
    method: "POST",
    // A caller cannot ask for a shared session either.
    body: { title: "Cut", model: "anthropic/claude-haiku-4-5", visibility: "workspace" },
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  // Lists show a session from its first prompt on; stand in for that prompt.
  await env.DB.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?")
    .bind(sessionId)
    .run();
  return sessionId;
}

/** A file the session's sandbox handed over, recorded the way the upload's completion records it. */
async function seedFile(sessionId: string): Promise<string> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const artifactId = crypto.randomUUID().replaceAll("-", "");
  const objectKey = `sessions/${sessionId}/files/${artifactId}.fcpxml`;
  await env.MEDIA_BUCKET.put(objectKey, "<fcpxml/>");
  await queryDO(
    stub,
    "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?)",
    artifactId,
    objectKey,
    JSON.stringify({
      objectKey,
      filename: "cut.fcpxml",
      mimeType: "application/xml",
      sizeBytes: 9,
    }),
    Date.now(),
    Date.now()
  );
  return artifactId;
}

async function listed(mode: Mode, actor: string, query = ""): Promise<string[]> {
  const response = await call(mode, actor, `/sessions${query}`);
  expect(response.status).toBe(200);
  return (await response.json<{ sessions: { id: string }[] }>()).sessions.map((item) => item.id);
}

async function visibilityOf(sessionId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT visibility FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ visibility: string }>();
  return row?.visibility;
}

async function wsToken(mode: Mode, actor: string, sessionId: string): Promise<string> {
  const response = await call(mode, actor, `/sessions/${sessionId}/ws-token`, {
    method: "POST",
    body: {},
  });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}

async function subscribeCloseCode(sessionId: string, token: string): Promise<number | "open"> {
  const { ws } = await openClientWs(sessionId);
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code))
  );
  const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
  ws.send(JSON.stringify({ type: "subscribe", token, clientId: crypto.randomUUID() }));
  const outcome = await Promise.race([
    closed,
    subscribed.then((messages) =>
      messages.some((message) => message.type === "subscribed") ? ("open" as const) : -1
    ),
  ]);
  if (outcome === "open") ws.close();
  return outcome;
}

/** Every route that reads or changes one session's data on behalf of a person. */
function sessionRoutes(sessionId: string, artifactId: string): [string, CallOptions][] {
  const at = (suffix: string) => `/sessions/${sessionId}${suffix}`;
  return [
    // The session, its timeline and who is in it.
    [at(""), {}],
    [at("/events"), {}],
    [at("/messages"), {}],
    [at("/participants"), {}],
    [at("/participant-profiles"), {}],
    [at("/children"), {}],
    // The live stream.
    [at("/ws-token"), { method: "POST", body: {} }],
    // What it produced, and the files fed to it.
    [at("/artifacts"), {}],
    [at(`/media/${artifactId}`), {}],
    [at("/inputs"), {}],
    [at("/inputs"), { method: "POST", body: { fileIds: [] } }],
    [at("/attachments"), { method: "POST", body: {} }],
    [at("/attachments/attachment-1"), {}],
    // Its permission mode and budget.
    [at("/permission-mode"), { method: "PATCH", body: { permissionMode: "full_auto" } }],
    [at("/budget"), { method: "PATCH", body: { maxCostUsd: 2 } }],
    // Steering and lifecycle.
    [at("/prompt"), { method: "POST", body: { content: "Shorter" } }],
    [at("/stop"), { method: "POST", body: {} }],
    [at("/title"), { method: "PATCH", body: { title: "Mine now" } }],
    [at("/archive"), { method: "POST", body: {} }],
    [at("/unarchive"), { method: "POST", body: {} }],
    [at("/diff/retry"), { method: "POST", body: {} }],
    [at("/pull-requests/refresh"), { method: "POST", body: {} }],
  ];
}

/** Session routes the app service is given for nobody, the creator included. */
function closedRoutes(sessionId: string): [string, CallOptions][] {
  return [
    [`/sessions/${sessionId}/export`, {}],
    [`/sessions/${sessionId}`, { method: "DELETE" }],
  ];
}

describe.each(["off", "shadow", "on"] as const)(
  "an app user's sessions are theirs alone (%s)",
  (mode) => {
    beforeEach(cleanD1Tables);

    it("creates them private whatever the deployment or the request asks for", async () => {
      const sessionId = await createSession(mode, ALICE);
      expect(await visibilityOf(sessionId)).toBe("private");
    });

    it.each(["private", "workspace", "team"] as const)(
      "refuses another app user every route of a session stored as %s",
      async (visibility) => {
        const sessionId = await createSession(mode, ALICE);
        const bobSession = await createSession(mode, BOB);
        const artifactId = await seedFile(sessionId);
        // Bob's standing in the workspace opens nothing either: make him its Owner, a
        // collaborator on the session and, for a team session, that team's lead.
        const bob = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
          .bind(bobSession)
          .first<{ user_id: string }>();
        const team =
          visibility === "team"
            ? await seedTeam({ slug: "studio", name: "Studio", joinPolicy: "open" })
            : null;
        await env.DB.batch([
          env.DB.prepare("UPDATE sessions SET visibility = ?, owner_team_id = ? WHERE id = ?").bind(
            visibility,
            team?.id ?? null,
            sessionId
          ),
          env.DB.prepare(
            "UPDATE user_role_assignments SET role_id = (SELECT id FROM roles WHERE key = 'owner') WHERE user_id = ?"
          ).bind(bob!.user_id),
          env.DB.prepare(
            "INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)"
          ).bind(sessionId, bob!.user_id, bob!.user_id, Date.now()),
          ...(team
            ? [
                env.DB.prepare(
                  "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, 'lead', ?)"
                ).bind(team.id, bob!.user_id, Date.now()),
              ]
            : []),
        ]);

        const refused: Record<string, number> = {};
        for (const [path, options] of sessionRoutes(sessionId, artifactId)) {
          const response = await call(mode, BOB, path, options);
          if (response.status !== 404) {
            refused[`${options.method ?? "GET"} ${path}`] = response.status;
          }
          await response.body?.cancel();
        }
        expect(refused).toEqual({});
        for (const actor of [ALICE, BOB]) {
          for (const [path, options] of closedRoutes(sessionId)) {
            const response = await call(mode, actor, path, options);
            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toMatchObject({
              code: "service_capability_required",
            });
          }
        }

        expect(await listed(mode, BOB)).toEqual([bobSession]);
        expect(await listed(mode, BOB, "?scope=all")).toEqual([bobSession]);
        expect(await listed(mode, BOB, `?visibility=${visibility}`)).not.toContain(sessionId);
        expect(await listed(mode, BOB, "?q=Cut")).toEqual([bobSession]);
        expect(await listed(mode, ALICE)).toEqual([sessionId]);

        // Alice still reaches her own session, and nothing Bob tried took effect.
        const read = await call(mode, ALICE, `/sessions/${sessionId}`);
        expect(read.status).toBe(200);
        await expect(read.json()).resolves.toMatchObject({
          session: { id: sessionId, title: "Cut" },
        });
        const media = await call(mode, ALICE, `/sessions/${sessionId}/media/${artifactId}`);
        expect(media.status).toBe(200);
        await media.body?.cancel();
        expect((await call(mode, ALICE, `/sessions/${sessionId}/artifacts`)).status).toBe(200);
        expect((await call(mode, ALICE, `/sessions/${sessionId}/inputs`)).status).toBe(200);
        expect(
          (
            await call(mode, ALICE, `/sessions/${sessionId}/budget`, {
              method: "PATCH",
              body: { maxCostUsd: 2 },
            })
          ).status
        ).toBe(200);
      }
    );

    it("holds a live stream to the session's creator, checked against the stored owner", async () => {
      const sessionId = await createSession(mode, ALICE);
      const bobSession = await createSession(mode, BOB);
      await env.DB.prepare("UPDATE sessions SET visibility = 'workspace'").run();
      expect(
        (await call(mode, BOB, `/sessions/${sessionId}/ws-token`, { method: "POST", body: {} }))
          .status
      ).toBe(404);

      expect(await subscribeCloseCode(sessionId, await wsToken(mode, ALICE, sessionId))).toBe(
        "open"
      );

      // A token Bob holds for his own session stops working the moment the session is not his.
      const bobToken = await wsToken(mode, BOB, bobSession);
      await env.DB.prepare(
        "UPDATE sessions SET user_id = (SELECT user_id FROM sessions WHERE id = ?) WHERE id = ?"
      )
        .bind(sessionId, bobSession)
        .run();
      expect(await subscribeCloseCode(bobSession, bobToken)).toBe(4010);
    });
  }
);
