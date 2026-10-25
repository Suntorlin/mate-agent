import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  issueClientWsToken,
  openClientWs,
  queryDO,
  routeRequest,
  seedMessage,
  seedSandboxAuthHash,
  serviceRequestHeaders,
} from "./helpers";

const BASE = "https://test.local";
// Two users who signed in separately; neither administers the workspace.
const ALICE = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BOB = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const SANDBOX_TOKEN = "private-session-sandbox-token";

type Mode = "shadow" | "on";

async function call(
  mode: Mode,
  userId: string,
  path: string,
  options: { method?: string; body?: unknown; env?: Record<string, string> } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return routeRequest(
    new Request(url, {
      method,
      headers: await serviceRequestHeaders(url, {
        method,
        body,
        as: { userId, role: "member" },
      }),
      body,
    }),
    {
      ...env,
      TEAMS_ENFORCEMENT: mode,
      DEFAULT_SESSION_VISIBILITY: "private",
      ...options.env,
    },
    createExecutionContext()
  );
}

async function createSession(mode: Mode, userId: string, title: string) {
  const response = await call(mode, userId, "/sessions", {
    method: "POST",
    body: { title, model: "anthropic/claude-haiku-4-5" },
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  // Lists show a session from its first prompt on; stand in for that prompt.
  await env.DB.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?")
    .bind(sessionId)
    .run();
  return sessionId;
}

/** A page the session's own sandbox uploaded, as the preview skill does. */
async function uploadPage(sessionId: string): Promise<string> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: "sandbox-1" });
  const [participant] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  await seedMessage(stub, {
    id: "msg-page",
    authorId: participant.id,
    content: "Make a storyboard",
    source: "web",
    status: "processing",
    createdAt: Date.now() - 1_000,
    startedAt: Date.now() - 500,
  });
  const form = new FormData();
  form.append("file", new File(["<h1>Storyboard</h1>"], "board.html", { type: "text/html" }));
  form.append("artifactType", "page");
  const response = await SELF.fetch(`${BASE}/sessions/${sessionId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    body: form,
  });
  expect(response.status).toBe(201);
  return (await response.json<{ artifactId: string }>()).artifactId;
}

/**
 * A file the session's sandbox handed over (the preview skill, an export). Direct uploads need a
 * store the sandbox can reach, which the Workers runtime has not, so the artifact is recorded the
 * way the upload's completion records it.
 */
async function seedFile(sessionId: string, filename: string, bytes: string): Promise<string> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const artifactId = crypto.randomUUID().replaceAll("-", "");
  const objectKey = `sessions/${sessionId}/files/${artifactId}.fcpxml`;
  await env.MEDIA_BUCKET.put(objectKey, bytes);
  const metadata = { objectKey, filename, mimeType: "application/xml", sizeBytes: bytes.length };
  await queryDO(
    stub,
    "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?)",
    artifactId,
    objectKey,
    JSON.stringify(metadata),
    Date.now(),
    Date.now()
  );
  return artifactId;
}

async function listedIds(mode: Mode, userId: string, path: string) {
  const response = await call(mode, userId, path);
  expect(response.status).toBe(200);
  const body = await response.json<{ sessions: { id: string }[] }>();
  return body.sessions.map((session) => session.id);
}

async function inboxIds(mode: Mode, userId: string) {
  const response = await call(mode, userId, "/sessions/inbox");
  expect(response.status).toBe(200);
  const body = await response.json<{
    categories: Record<string, { items: { rootSession: { id: string } }[] }>;
  }>();
  return Object.values(body.categories).flatMap((page) =>
    page.items.map((item) => item.rootSession.id)
  );
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

describe.each(["shadow", "on"] as const)("sessions private to their creator (%s)", (mode) => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [ALICE, BOB]) {
      expect((await call(mode, userId, "/me/authorization")).status).toBe(200);
    }
  });

  it("creates sessions private to the person who started them", async () => {
    const sessionId = await createSession(mode, ALICE, "Alice's cut");
    const row = await env.DB.prepare("SELECT user_id, visibility FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ user_id: string; visibility: string }>();
    expect(row).toEqual({ user_id: ALICE, visibility: "private" });
  });

  it("keeps the workspace default for deployments that do not ask for privacy", async () => {
    const plain = await call(mode, ALICE, "/sessions", {
      method: "POST",
      body: { title: "Shared", model: "anthropic/claude-haiku-4-5" },
      env: { DEFAULT_SESSION_VISIBILITY: "" },
    });
    const { sessionId } = await plain.json<{ sessionId: string }>();
    const row = await env.DB.prepare("SELECT visibility FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ visibility: string }>();
    expect(row?.visibility).toBe("workspace");
  });

  it("hides one creator's session from another everywhere, and keeps it working for its owner", async () => {
    const alice = await createSession(mode, ALICE, "Alice's cut");
    const bob = await createSession(mode, BOB, "Bob's cut");
    const artifactId = await uploadPage(alice);

    // Lists: each creator sees only their own, under every filter.
    for (const path of ["/sessions", "/sessions?createdBy=me"]) {
      expect(await listedIds(mode, ALICE, path)).toEqual([alice]);
      expect(await listedIds(mode, BOB, path)).toEqual([bob]);
    }
    expect(await listedIds(mode, BOB, `/sessions?createdBy=${ALICE}`)).toEqual([]);
    expect(await listedIds(mode, BOB, `/sessions?q=${encodeURIComponent("Alice")}`)).toEqual([]);
    expect(await inboxIds(mode, ALICE)).toEqual([alice]);
    expect(await inboxIds(mode, BOB)).toEqual([bob]);

    // Direct URLs: the other creator learns nothing, not even that the session exists.
    const denied: Array<[string, string, unknown?]> = [
      ["GET", `/sessions/${alice}`],
      ["GET", `/sessions/${alice}/events`],
      ["GET", `/sessions/${alice}/artifacts`],
      ["GET", `/sessions/${alice}/messages`],
      ["GET", `/sessions/${alice}/media/${artifactId}`],
      ["POST", `/sessions/${alice}/ws-token`, {}],
      ["POST", `/sessions/${alice}/prompt`, { content: "Make it mine" }],
      ["POST", `/sessions/${alice}/stop`],
      ["PATCH", `/sessions/${alice}/title`, { title: "Taken" }],
      ["POST", `/sessions/${alice}/archive`],
      ["DELETE", `/sessions/${alice}`],
    ];
    for (const [method, path, body] of denied) {
      const response = await call(mode, BOB, path, { method, body });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }

    // A socket token minted for Bob any other way is refused at subscribe.
    const leaked = await issueClientWsToken(alice, { userId: BOB, canonicalUserId: BOB });
    expect(await subscribeCloseCode(alice, leaked.token)).toBe(4010);

    // Alice keeps full use of her session.
    expect((await call(mode, ALICE, `/sessions/${alice}`)).status).toBe(200);
    const media = await call(mode, ALICE, `/sessions/${alice}/media/${artifactId}`);
    expect(media.status).toBe(200);
    expect(await media.text()).toBe("<h1>Storyboard</h1>");
    const tokenResponse = await call(mode, ALICE, `/sessions/${alice}/ws-token`, {
      method: "POST",
      body: {},
    });
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json<{ token: string }>();
    expect(await subscribeCloseCode(alice, token)).toBe("open");
    expect((await call(mode, ALICE, `/sessions/${alice}/stop`, { method: "POST" })).status).toBe(
      200
    );
    const prompt = await call(mode, ALICE, `/sessions/${alice}/prompt`, {
      method: "POST",
      body: { content: "Make the next cut" },
    });
    // Admitted; the test sandbox, which never boots, is what holds the prompt back.
    expect([403, 404]).not.toContain(prompt.status);
    expect((await call(mode, ALICE, `/sessions/${alice}`, { method: "DELETE" })).status).toBe(200);
    // Bob's own session was never touched.
    expect((await call(mode, BOB, `/sessions/${bob}`)).status).toBe(200);
  });
  it("lets only a file's creator download it, under its own name", async () => {
    const alice = await createSession(mode, ALICE, "Alice's cut");
    await createSession(mode, BOB, "Bob's cut");
    const fileId = await seedFile(alice, "北汉山 final.fcpxml", "<fcpxml/>");

    const own = await call(mode, ALICE, `/sessions/${alice}/media/${fileId}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(own.headers.get("Content-Disposition")).toBe(
      `attachment; filename="___ final.fcpxml"; filename*=UTF-8''%E5%8C%97%E6%B1%89%E5%B1%B1%20final.fcpxml`
    );
    expect(new TextDecoder().decode(await own.arrayBuffer())).toBe("<fcpxml/>");

    const other = await call(mode, BOB, `/sessions/${alice}/media/${fileId}`);
    expect(other.status).toBe(404);
    const otherUpload = await call(mode, BOB, `/sessions/${alice}/uploads`, {
      method: "POST",
      body: { artifactType: "file", filename: "x.zip", sizeBytes: 1 },
    });
    expect(otherUpload.status).toBe(404);
  });
});
