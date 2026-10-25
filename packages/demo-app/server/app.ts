/**
 * The demo backend's HTTP API. Three audiences:
 *
 *   the browser   /api/auth/*, /api/me, /api/conversations/*   (cookie sign-in)
 *   the engine    POST /api/engine/mcp-token                    (bearer APP_ENGINE_TOKEN)
 *                 POST /api/mcp                                 (bearer: a minted MCP token)
 *
 * The browser talks only to this backend. Prompts go through it (that is where credits are
 * checked), the live stream comes from it (see relay.ts), and the preview's files are read
 * through it, signed as the user.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "./config.ts";
import { canStartTurn, settleUser } from "./credits.ts";
import { EngineError, type EngineArtifact, type EngineClient } from "./engine.ts";
import { handleMcpMessage } from "./mcp.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { Relay, type OpenSocket } from "./relay.ts";
import type { Conversation, Store, Turn, User } from "./store.ts";

const COOKIE = "demo_session";
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MCP_TOKEN_TTL_SECONDS = 60 * 60;
const SSE_KEEPALIVE_MS = 20_000;
const TITLE_MAX_CHARS = 48;
const DEFAULT_TITLE = "New conversation";
const PROMPT_MAX_CHARS = 20_000;

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});
const promptSchema = z.object({ content: z.string().trim().min(1).max(PROMPT_MAX_CHARS) });
const mintSchema = z.object({ user_id: z.string().regex(/^[0-9a-f]{16}$/) });

export interface AppDeps {
  config: Config;
  store: Store;
  engine: EngineClient;
  /** Opens the engine WebSocket; tests pass a fake. */
  openSocket?: OpenSocket;
  log?: (message: string, error?: unknown) => void;
}

type Env = { Variables: { user: User } };

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function bearer(c: Context): string | null {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

function publicUser(user: User) {
  return { id: user.id, email: user.email, credits: user.credits };
}

function publicTurn(turn: Turn) {
  return {
    messageId: turn.messageId,
    prompt: turn.prompt,
    reply: turn.reply,
    status: turn.status,
    engineStatus: turn.engineStatus,
    runtime: turn.runtime,
    credits: turn.credits,
    createdAt: turn.createdAt,
  };
}

/** What the preview pane needs to know about an artifact. */
function publicArtifact(artifact: EngineArtifact) {
  const metadata = artifact.metadata ?? {};
  const pick = (key: string) => (typeof metadata[key] === "string" ? metadata[key] : null);
  return {
    id: artifact.id,
    type: artifact.type,
    name: pick("filename") ?? pick("caption") ?? `${artifact.type} ${artifact.id.slice(0, 6)}`,
    caption: pick("caption"),
    mimeType: pick("mimeType"),
    sizeBytes: typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : null,
    createdAt: artifact.createdAt,
  };
}

export function createApp(deps: AppDeps): { app: Hono<Env>; relay: Relay } {
  const { config, store, engine } = deps;
  const log = deps.log ?? (() => {});
  /** Replies of turns that ended before their prompt call returned (fast inline turns). */
  const earlyReplies = new Map<string, string>();

  const settle = (userId: string) => settleUser(store, engine, userId, config.creditsPerUsd, log);
  /** Users whose prompt is between the credit check and its turn row (one start at a time). */
  const starting = new Set<string>();

  const relay = new Relay(
    engine,
    {
      hasRunningTurn: (conversation) =>
        store.turns(conversation.id).some((turn) => turn.status === "running"),
      onTurnEnded: (conversation, messageId, reply) => {
        if (!store.turn(messageId)) {
          earlyReplies.set(messageId, reply);
          return;
        }
        store.saveReply(messageId, reply);
        settle(conversation.userId).catch((error) => log("settling a turn failed", error));
      },
      log,
    },
    deps.openSocket
  );

  const app = new Hono<Env>();

  // A cookie is sent with cross-site form posts from another localhost port too (same site), so
  // a browser request that changes something must come from this origin.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (c.req.method !== "GET" && origin && new URL(origin).host !== c.req.header("Host")) {
      return c.json({ error: "cross_origin" }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof EngineError) {
      log("engine call failed", error);
      return c.json({ error: "engine_error", status: error.status }, 502);
    }
    log("request failed", error);
    return c.json({ error: "internal_error" }, 500);
  });

  // --- accounts -----------------------------------------------------------

  const signIn = (c: Context, user: User) => {
    const token = store.issueToken("web_sessions", user.id, WEB_SESSION_TTL_MS);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: WEB_SESSION_TTL_MS / 1000,
    });
    return c.json({ user: publicUser(user) });
  };

  app.post("/api/auth/signup", async (c) => {
    const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_credentials_format" }, 400);
    if (store.userByEmail(parsed.data.email)) return c.json({ error: "email_taken" }, 409);
    const passwordHash = await hashPassword(parsed.data.password);
    // A second sign-up for the same email may have landed while the password was hashing.
    if (store.userByEmail(parsed.data.email)) return c.json({ error: "email_taken" }, 409);
    return signIn(c, store.createUser(parsed.data.email, passwordHash, config.signupCredits));
  });

  app.post("/api/auth/signin", async (c) => {
    const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_credentials" }, 401);
    const user = store.userByEmail(parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    return signIn(c, user);
  });

  app.post("/api/auth/signout", (c) => {
    const token = getCookie(c, COOKIE);
    if (token) store.revokeToken("web_sessions", token);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // --- the signed-in user's API -------------------------------------------

  const signedIn = new Hono<Env>();
  signedIn.use(async (c, next) => {
    const token = getCookie(c, COOKIE);
    const user = token ? store.userForToken("web_sessions", token) : null;
    if (!user) return c.json({ error: "signed_out" }, 401);
    c.set("user", user);
    await next();
  });

  const owned = (c: Context<Env>): Conversation | null =>
    store.conversation(c.get("user").id, c.req.param("id") ?? "");

  signedIn.get("/me", async (c) => {
    const user = c.get("user");
    await settle(user.id);
    return c.json({ user: publicUser(store.userById(user.id) ?? user) });
  });

  signedIn.get("/conversations", (c) =>
    c.json({ conversations: store.conversations(c.get("user").id) })
  );

  signedIn.post("/conversations", async (c) => {
    const user = c.get("user");
    const sessionId = await engine.createSession(user.id, "Demo Studio", config.model);
    return c.json({ conversation: store.createConversation(user.id, sessionId, DEFAULT_TITLE) });
  });

  signedIn.get("/conversations/:id", (c) => {
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json({ conversation, turns: store.turns(conversation.id).map(publicTurn) });
  });

  signedIn.post("/conversations/:id/prompt", async (c) => {
    const user = c.get("user");
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const parsed = promptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_prompt" }, 400);
    // One turn per user at a time, so a turn can take the balance below zero only once.
    if (starting.has(user.id)) return c.json({ error: "turn_running" }, 409);
    starting.add(user.id);
    let turn: Turn;
    try {
      if (store.conversationsWithRunningTurns(user.id).length > 0) {
        await settle(user.id);
        if (store.conversationsWithRunningTurns(user.id).length > 0) {
          return c.json({ error: "turn_running" }, 409);
        }
      }
      const balance = store.userById(user.id)?.credits ?? 0;
      if (!canStartTurn(balance)) {
        return c.json({ error: "out_of_credits", credits: balance }, 402);
      }
      // Open the stream first, so the backend sees the turn end even if no browser is watching.
      await relay.stream(conversation);
      const messageId = await engine.prompt(
        user.id,
        conversation.engineSessionId,
        parsed.data.content
      );
      turn = store.createTurn(conversation, messageId, parsed.data.content);
    } finally {
      starting.delete(user.id);
    }
    const { messageId } = turn;
    if (conversation.title === DEFAULT_TITLE) {
      store.renameConversation(conversation.id, parsed.data.content.slice(0, TITLE_MAX_CHARS));
    }
    const early = earlyReplies.get(messageId);
    if (early !== undefined) {
      earlyReplies.delete(messageId);
      store.saveReply(messageId, early);
      await settle(user.id);
    }
    return c.json({ turn: publicTurn(store.turn(messageId) ?? turn) });
  });

  signedIn.post("/conversations/:id/stop", async (c) => {
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    await engine.stop(c.get("user").id, conversation.engineSessionId);
    return c.json({ ok: true });
  });

  signedIn.get("/conversations/:id/events", async (c) => {
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const stream = await relay.stream(conversation);
    return streamSSE(c, async (sse) => {
      // Registered before the first await, so a client that leaves at once is still let go.
      const closed = new Promise<void>((resolve) => sse.onAbort(resolve));
      const unlisten = stream.listen((message) => {
        sse.writeSSE({ event: message.type, data: JSON.stringify(message) }).catch(() => {});
      });
      const keepalive = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, SSE_KEEPALIVE_MS);
      try {
        await sse.writeSSE({ event: "ready", data: "{}" });
        await closed;
      } finally {
        clearInterval(keepalive);
        unlisten();
      }
    });
  });

  signedIn.get("/conversations/:id/artifacts", async (c) => {
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const artifacts = await engine.artifacts(c.get("user").id, conversation.engineSessionId);
    return c.json({ artifacts: artifacts.map(publicArtifact) });
  });

  signedIn.get("/conversations/:id/artifacts/:artifactId/content", async (c) => {
    const user = c.get("user");
    const conversation = owned(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const artifactId = c.req.param("artifactId");
    const artifacts = await engine.artifacts(user.id, conversation.engineSessionId);
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return c.json({ error: "not_found" }, 404);
    const upstream = await engine.media(user.id, conversation.engineSessionId, artifactId);
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return c.json({ error: "artifact_unavailable" }, 502);
    }
    const info = publicArtifact(artifact);
    const headers = new Headers({
      "Content-Type":
        artifact.type === "page"
          ? "text/html; charset=utf-8"
          : (upstream.headers.get("Content-Type") ?? "application/octet-stream"),
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      // Whatever the agent wrote runs in an opaque origin: no cookies, no access to this app.
      "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-forms",
      "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="${info.name.replace(/[^\w.-]/g, "_")}"`,
    });
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    return new Response(upstream.body, { status: 200, headers });
  });

  // --- the engine ---------------------------------------------------------

  app.post("/api/engine/mcp-token", async (c) => {
    const token = bearer(c);
    if (!token || !sameSecret(token, config.engineToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parsed = mintSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    if (!store.userById(parsed.data.user_id)) return c.json({ error: "unknown_user" }, 404);
    const accessToken = store.issueToken(
      "mcp_tokens",
      parsed.data.user_id,
      MCP_TOKEN_TTL_SECONDS * 1000
    );
    return c.json({ access_token: accessToken, expires_in: MCP_TOKEN_TTL_SECONDS });
  });

  app.post("/api/mcp", async (c) => {
    const token = bearer(c);
    const user = token ? store.userForToken("mcp_tokens", token) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const reply = handleMcpMessage(store, user, await c.req.json().catch(() => null));
    return reply.body === null
      ? c.body(null, reply.status as 202)
      : c.json(reply.body, reply.status as 200);
  });

  app.get("/api/mcp", (c) => c.body(null, 405));

  // Last: the signed-in API's cookie check covers /api/*, after the engine's routes answered.
  app.route("/api", signedIn);

  return { app, relay };
}
