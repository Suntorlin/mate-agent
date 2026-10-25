import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";
import { creditsForCost } from "./credits.ts";
import { EngineClient } from "./engine.ts";
import { IMAGE_CREDITS, INSTRUCTIONS } from "./mcp.ts";
import type { SocketLike } from "./relay.ts";
import { Store } from "./store.ts";

const ENGINE_TOKEN = "engine-token-for-tests";

const config: Config = {
  port: 0,
  dataDir: "",
  engineUrl: "http://engine.test",
  engineSecret: "app-secret-for-tests",
  engineToken: ENGINE_TOKEN,
  model: "anthropic/claude-sonnet-4-6",
  signupCredits: 100,
  creditsPerUsd: 1000,
};

interface FakeMessage {
  id: string;
  status: string;
  costUsd: number;
  runtime: string | null;
}

/** The engine's HTTP API as this backend uses it, in memory, recording who called. */
class FakeEngine {
  calls: Array<{ method: string; path: string; actor: string | null; service: string | null }> = [];
  messages = new Map<string, FakeMessage[]>();
  artifacts = new Map<string, unknown[]>();
  private nextId = 1;
  down = false;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.calls.push({
      method,
      path: url.pathname,
      actor: headers.get("X-OpenInspect-Actor"),
      service: headers.get("X-OpenInspect-Service"),
    });
    if (this.down) return new Response("engine down", { status: 503 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && url.pathname === "/sessions") {
      const sessionId = `s${this.nextId++}`;
      this.messages.set(sessionId, []);
      return Response.json({ sessionId });
    }
    const [, sessionId, action] = parts;
    if (method === "POST" && action === "prompt") {
      const messageId = `m${this.nextId++}`;
      this.messages
        .get(sessionId)
        ?.push({ id: messageId, status: "processing", costUsd: 0, runtime: null });
      return Response.json({ messageId, status: "queued" });
    }
    if (method === "POST" && action === "ws-token") return Response.json({ token: "ws" });
    if (method === "GET" && action === "messages") {
      return Response.json({ messages: this.messages.get(sessionId) ?? [], hasMore: false });
    }
    if (method === "GET" && action === "artifacts") {
      return Response.json({ artifacts: this.artifacts.get(sessionId) ?? [] });
    }
    if (method === "GET" && action === "media") {
      return new Response("<h1>hi</h1>", {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  finish(sessionId: string, messageId: string, costUsd: number, runtime = "inline"): void {
    const message = this.messages.get(sessionId)?.find((m) => m.id === messageId);
    if (!message) throw new Error(`no message ${messageId}`);
    Object.assign(message, { status: "completed", costUsd, runtime });
  }
}

class FakeSocket extends EventTarget implements SocketLike {
  sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  deliver(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

let store: Store;
let engine: FakeEngine;
let sockets: FakeSocket[];
let app: ReturnType<typeof createApp>["app"];
let relay: ReturnType<typeof createApp>["relay"];

beforeEach(() => {
  store = new Store(":memory:");
  engine = new FakeEngine();
  sockets = [];
  ({ app, relay } = createApp({
    config,
    store,
    engine: new EngineClient({
      baseUrl: config.engineUrl,
      secret: config.engineSecret,
      fetchFn: engine.fetch,
    }),
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  }));
});

afterEach(() => {
  relay.closeAll();
  store.close();
});

async function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  return app.request(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function signUp(email = "ada@example.com"): Promise<{ cookie: string; userId: string }> {
  const response = await call("/api/auth/signup", {
    body: { email, password: "correct horse" },
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get("Set-Cookie") ?? "").split(";")[0];
  const { user } = (await response.json()) as { user: { id: string } };
  return { cookie, userId: user.id };
}

async function newConversation(cookie: string): Promise<{ id: string; engineSessionId: string }> {
  const response = await call("/api/conversations", { method: "POST", cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { conversation: { id: string; engineSessionId: string } })
    .conversation;
}

async function credits(cookie: string): Promise<number> {
  const response = await call("/api/me", { cookie });
  return ((await response.json()) as { user: { credits: number } }).user.credits;
}

describe("accounts", () => {
  it("signs up with the starting credits and signs in again with the password", async () => {
    const { cookie } = await signUp();
    expect(await credits(cookie)).toBe(100);

    const wrong = await call("/api/auth/signin", {
      body: { email: "ada@example.com", password: "wrong password" },
    });
    expect(wrong.status).toBe(401);
    const right = await call("/api/auth/signin", {
      body: { email: "ADA@example.com", password: "correct horse" },
    });
    expect(right.status).toBe(200);
  });

  it("refuses a taken email, a short password and a missing cookie", async () => {
    await signUp();
    const taken = await call("/api/auth/signup", {
      body: { email: "ada@example.com", password: "another one" },
    });
    expect(taken.status).toBe(409);
    const short = await call("/api/auth/signup", {
      body: { email: "bob@example.com", password: "short" },
    });
    expect(short.status).toBe(400);
    expect((await call("/api/me")).status).toBe(401);
  });

  it("signs out by revoking the cookie's session", async () => {
    const { cookie } = await signUp();
    await call("/api/auth/signout", { method: "POST", cookie });
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });
});

describe("talking to the engine as the app principal", () => {
  it("creates the session and sends the prompt signed as app:<userId>", async () => {
    const { cookie, userId } = await signUp();
    const conversation = await newConversation(cookie);
    const response = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "hello" },
      cookie,
    });
    expect(response.status).toBe(200);

    const engineCalls = engine.calls.filter(
      (c) => c.path !== `/sessions/${conversation.engineSessionId}/ws-token`
    );
    expect(engineCalls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        "POST /sessions",
        `POST /sessions/${conversation.engineSessionId}/prompt`,
      ])
    );
    for (const c of engine.calls) {
      expect(c.service).toBe("app");
      expect(c.actor).toBe(`app:${userId}`);
    }
    sockets[0].dispatchEvent(new Event("open"));
    expect(sockets[0].sent[0]).toEqual({ type: "subscribe", token: "ws", clientId: "demo-app" });
  });

  it("keeps another user out of a conversation", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    const other = await signUp("eve@example.com");
    const response = await call(`/api/conversations/${conversation.id}`, { cookie: other.cookie });
    expect(response.status).toBe(404);
  });
});

describe("credits", () => {
  it("rounds a turn's cost up to whole credits", () => {
    expect(creditsForCost(0, 1000)).toBe(0);
    expect(creditsForCost(0.0001, 1000)).toBe(1);
    expect(creditsForCost(0.0123, 1000)).toBe(13);
    expect(creditsForCost(0.012, 1000)).toBe(12);
  });

  it("charges the engine's reported cost when the turn ends, and keeps the reply", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    const response = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "hello" },
      cookie,
    });
    const { turn } = (await response.json()) as { turn: { messageId: string } };

    engine.finish(conversation.engineSessionId, turn.messageId, 0.0123);
    const socket = sockets[0];
    socket.deliver({
      type: "sandbox_event",
      event: { type: "token", messageId: turn.messageId, content: "Hi there" },
    });
    socket.deliver({
      type: "sandbox_event",
      event: { type: "execution_complete", messageId: turn.messageId, success: true },
    });

    await vi.waitFor(() => expect(store.turn(turn.messageId)?.status).toBe("settled"));
    const settled = store.turn(turn.messageId);
    expect(settled).toMatchObject({ reply: "Hi there", credits: 13, runtime: "inline" });
    expect(await credits(cookie)).toBe(87);
  });

  it("charges a turn whose end the relay missed when the balance is next read", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    const response = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "make a page" },
      cookie,
    });
    const { turn } = (await response.json()) as { turn: { messageId: string } };
    engine.finish(conversation.engineSessionId, turn.messageId, 0.25, "sandbox");

    expect(await credits(cookie)).toBe(-150);
    // Settled once: reading again charges nothing more.
    expect(await credits(cookie)).toBe(-150);
  });

  it("refuses a prompt at zero credits without calling the engine", async () => {
    const { cookie, userId } = await signUp();
    const conversation = await newConversation(cookie);
    const prompt = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "first" },
      cookie,
    });
    const { turn } = (await prompt.json()) as { turn: { messageId: string } };
    engine.finish(conversation.engineSessionId, turn.messageId, 0.1);
    expect(await credits(cookie)).toBe(0);

    const before = engine.calls.length;
    const refused = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "second" },
      cookie,
    });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: "out_of_credits", credits: 0 });
    const promptsAfter = engine.calls
      .slice(before)
      .filter((c) => c.path.endsWith("/prompt") && c.actor === `app:${userId}`);
    expect(promptsAfter).toEqual([]);
  });

  it("still answers /me with the stored balance while the engine is down", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    await call(`/api/conversations/${conversation.id}/prompt`, { body: { content: "a" }, cookie });
    engine.down = true;
    const me = await call("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await credits(cookie)).toBe(100);
  });

  it("runs one turn per user at a time, across conversations", async () => {
    const { cookie } = await signUp();
    const first = await newConversation(cookie);
    const second = await newConversation(cookie);
    const [a, b] = await Promise.all([
      call(`/api/conversations/${first.id}/prompt`, { body: { content: "a" }, cookie }),
      call(`/api/conversations/${second.id}/prompt`, { body: { content: "b" }, cookie }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("refuses a second prompt while the first turn is still running", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    await call(`/api/conversations/${conversation.id}/prompt`, { body: { content: "a" }, cookie });
    const second = await call(`/api/conversations/${conversation.id}/prompt`, {
      body: { content: "b" },
      cookie,
    });
    expect(second.status).toBe(409);
  });
});

describe("the browser boundary", () => {
  it("refuses a state-changing request from another origin", async () => {
    const response = await app.request("/api/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Host: "localhost:9320",
      },
      body: JSON.stringify({ email: "x@example.com", password: "long enough" }),
    });
    expect(response.status).toBe(403);
  });

  it("opens one engine socket for concurrent subscribers", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    const stored = store.conversations(store.userByEmail("ada@example.com")!.id)[0];
    expect(stored.id).toBe(conversation.id);
    await Promise.all([relay.stream(stored), relay.stream(stored), relay.stream(stored)]);
    expect(sockets).toHaveLength(1);
  });
});

describe("MCP token minting", () => {
  it("mints a token only for the engine's bearer and a known user", async () => {
    const { userId } = await signUp();
    const anonymous = await call("/api/engine/mcp-token", { body: { user_id: userId } });
    expect(anonymous.status).toBe(401);
    const wrong = await call("/api/engine/mcp-token", {
      body: { user_id: userId },
      bearer: "not-the-token",
    });
    expect(wrong.status).toBe(401);
    const unknown = await call("/api/engine/mcp-token", {
      body: { user_id: "0123456789abcdef" },
      bearer: ENGINE_TOKEN,
    });
    expect(unknown.status).toBe(404);

    const minted = await call("/api/engine/mcp-token", {
      body: { user_id: userId },
      bearer: ENGINE_TOKEN,
    });
    expect(minted.status).toBe(200);
    expect(await minted.json()).toEqual({
      access_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      expires_in: 3600,
    });
  });
});

describe("the MCP server", () => {
  async function mcpToken(userId: string): Promise<string> {
    const minted = await call("/api/engine/mcp-token", {
      body: { user_id: userId },
      bearer: ENGINE_TOKEN,
    });
    return ((await minted.json()) as { access_token: string }).access_token;
  }

  async function rpc(token: string, method: string, params?: unknown, id: number | null = 1) {
    return call("/api/mcp", {
      body: {
        jsonrpc: "2.0",
        method,
        ...(id === null ? {} : { id }),
        ...(params ? { params } : {}),
      },
      bearer: token,
    });
  }

  it("refuses calls without a minted token", async () => {
    expect((await rpc("nope", "tools/list")).status).toBe(401);
  });

  it("gives the persona in initialize and lists the tools", async () => {
    const { userId } = await signUp();
    const token = await mcpToken(userId);
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18" });
    expect(await init.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18", instructions: INSTRUCTIONS },
    });
    expect((await rpc(token, "notifications/initialized", undefined, null)).status).toBe(202);
    const list = (await (await rpc(token, "tools/list")).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual([
      "get_credit_balance",
      "save_note",
      "list_notes",
      "generate_image",
    ]);
  });

  it("runs the tools on the token's user only", async () => {
    const ada = await signUp();
    const eve = await signUp("eve@example.com");
    const adaToken = await mcpToken(ada.userId);
    const eveToken = await mcpToken(eve.userId);

    await rpc(adaToken, "tools/call", { name: "save_note", arguments: { text: "buy milk" } });
    const adaNotes = (await (
      await rpc(adaToken, "tools/call", { name: "list_notes", arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(adaNotes.result.content[0].text).notes).toEqual([
      expect.objectContaining({ text: "buy milk" }),
    ]);
    const eveNotes = (await (
      await rpc(eveToken, "tools/call", { name: "list_notes", arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(eveNotes.result.content[0].text).notes).toEqual([]);

    const balance = (await (
      await rpc(adaToken, "tools/call", { name: "get_credit_balance", arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(balance.result.content[0].text)).toEqual({ credits: 100 });

    const bad = (await (
      await rpc(adaToken, "tools/call", { name: "save_note", arguments: { text: "" } })
    ).json()) as { result: { isError?: boolean } };
    expect(bad.result.isError).toBe(true);
  });

  it("charges a generated image to the user's credits, and refuses one they cannot afford", async () => {
    const { userId } = await signUp();
    const token = await mcpToken(userId);
    const generate = async () =>
      (await (
        await rpc(token, "tools/call", {
          name: "generate_image",
          arguments: { prompt: "a fox <in> the snow" },
        })
      ).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };

    const first = await generate();
    expect(first.result.isError).toBeUndefined();
    const image = JSON.parse(first.result.content[0].text);
    expect(image).toMatchObject({ creditsCharged: IMAGE_CREDITS, credits: 100 - IMAGE_CREDITS });
    expect(image.svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(image.svg).toContain("a fox &lt;in&gt; the snow");

    for (let spent = 2 * IMAGE_CREDITS; spent <= 100; spent += IMAGE_CREDITS) await generate();
    const refused = await generate();
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toMatch(/not enough credits/);
    expect(store.userById(userId)?.credits).toBe(100 % IMAGE_CREDITS);
  });
});

describe("the preview", () => {
  it("serves a page artifact as sandboxed HTML", async () => {
    const { cookie } = await signUp();
    const conversation = await newConversation(cookie);
    engine.artifacts.set(conversation.engineSessionId, [
      {
        id: "a1",
        type: "page",
        url: "sessions/x/a1.html",
        metadata: { filename: "hello.html", mimeType: "text/html", sizeBytes: 11 },
        createdAt: 1,
      },
    ]);
    const list = await call(`/api/conversations/${conversation.id}/artifacts`, { cookie });
    expect(await list.json()).toEqual({
      artifacts: [expect.objectContaining({ id: "a1", type: "page", name: "hello.html" })],
    });

    const content = await call(`/api/conversations/${conversation.id}/artifacts/a1/content`, {
      cookie,
    });
    expect(content.status).toBe(200);
    expect(content.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(content.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await content.text()).toBe("<h1>hi</h1>");

    const missing = await call(`/api/conversations/${conversation.id}/artifacts/zz/content`, {
      cookie,
    });
    expect(missing.status).toBe(404);
  });
});
