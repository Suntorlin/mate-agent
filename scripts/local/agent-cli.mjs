#!/usr/bin/env node
/**
 * Talk to the local engine from a terminal: create a session (or reuse one), send a prompt and
 * print the agent's reply as it streams, until the turn completes.
 *
 *   node scripts/local/agent-cli.mjs "Write hello.txt with today's date"
 *   node scripts/local/agent-cli.mjs --session <id> "and now read it back"
 *
 * Reads .env.local through the environment (run it via scripts/local/load-env.sh, or export the
 * keys): it signs as the local service principal with SERVICE_AUTH_SECRET_SLACK_BOT, the same
 * path the compose smoke uses, until the engine has a principal of its own for apps.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { WebSocket } from "ws";

const ENGINE_URL = process.env.ENGINE_URL ?? process.env.WORKER_URL ?? "http://localhost:8797";
const SERVICE = "slack-bot";
const SECRET = process.env.SERVICE_AUTH_SECRET_SLACK_BOT ?? "";
const ACTOR = process.env.AGENT_CLI_ACTOR ?? "slack:U-LOCAL-CLI";
const ACTOR_EMAIL = process.env.AGENT_CLI_EMAIL ?? "local-cli@agent-engine.test";
const TURN_TIMEOUT_MS = Number(process.env.AGENT_CLI_TIMEOUT_MS ?? 15 * 60 * 1000);

function parseArgs(argv) {
  const args = { session: null, model: null, prompt: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") args.session = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else args.prompt.push(argv[i]);
  }
  return { ...args, prompt: args.prompt.join(" ") };
}

async function call(path, { method = "GET", body } = {}) {
  const url = `${ENGINE_URL}${path}`;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers = await buildServiceAuthHeaders({
    service: SERVICE,
    secret: SECRET,
    method,
    url,
    body: serialized,
    actor: ACTOR,
  });
  const response = await fetch(url, {
    method,
    body: serialized,
    headers: { ...headers, ...(serialized ? { "Content-Type": "application/json" } : {}) },
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return parsed;
}

function subscribe(sessionId, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${ENGINE_URL.replace(/^http/, "ws")}/sessions/${sessionId}/ws`);
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "subscribe", token, clientId: "agent-cli" }))
    );
    socket.on("message", function onFirst(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type === "subscribed") {
        socket.off("message", onFirst);
        resolve(socket);
      }
    });
    socket.on("error", reject);
  });
}

/** The turn's text so far: a `token` event carries all of it, not just the new part. */
let printed = "";

/** Print one event of the turn; resolve the turn on execution_complete. */
function render(event, messageId, done) {
  if (event.messageId && event.messageId !== messageId) return;
  switch (event.type) {
    case "token": {
      const content = event.content ?? "";
      process.stdout.write(content.startsWith(printed) ? content.slice(printed.length) : content);
      printed = content;
      break;
    }
    case "tool_call":
      process.stderr.write(`\n[tool] ${event.tool ?? event.name ?? "?"} ${event.status ?? ""}\n`);
      break;
    case "error":
      process.stderr.write(`\n[error] ${event.error ?? JSON.stringify(event)}\n`);
      break;
    case "execution_complete":
      done(event);
      break;
    default:
      if (process.env.AGENT_CLI_VERBOSE) process.stderr.write(`\n[${event.type}]\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SECRET) throw new Error("SERVICE_AUTH_SECRET_SLACK_BOT is not set (source .env.local)");
  if (!args.prompt) throw new Error("usage: agent-cli.mjs [--session id] [--model m] <prompt>");

  const sessionId =
    args.session ??
    (
      await call("/sessions", {
        method: "POST",
        body: {
          name: "local cli",
          actorEmail: ACTOR_EMAIL,
          actorDisplayName: "Local CLI",
          ...(args.model ? { model: args.model } : {}),
        },
      })
    ).sessionId;
  process.stderr.write(`session ${sessionId}\n`);

  const { token } = await call(`/sessions/${sessionId}/ws-token`, { method: "POST", body: {} });
  const socket = await subscribe(sessionId, token);
  const { messageId } = await call(`/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: { content: args.prompt },
  });
  process.stderr.write(`message ${messageId}\n`);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn timed out")), TURN_TIMEOUT_MS);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "sandbox_event") {
        render(message.event, messageId, (event) => {
          clearTimeout(timer);
          resolve(event);
        });
      } else if (process.env.AGENT_CLI_VERBOSE) {
        process.stderr.write(`\n{${message.type}}\n`);
      }
    });
  });
  socket.close();
  process.stderr.write(`\nturn ${result.success ? "completed" : "failed"}\n`);
  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
