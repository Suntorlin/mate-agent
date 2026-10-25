/**
 * What the local end-to-end scripts share: where Demo Studio is, a client that signs up and calls
 * its API like a browser (one cookie jar each, so several users can run side by side), and the
 * engine-side calls (mint an MCP token, call an MCP tool) that a real turn makes on a user's behalf.
 * No dependencies beyond Node 24.
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// DEMO_PORT, APP_ENGINE_TOKEN and the rest come from the stack's .env.local when it is there.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url)));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

export const DEMO_URL = (
  process.env.DEMO_URL ?? `http://localhost:${process.env.DEMO_PORT ?? 9320}`
).replace(/\/+$/, "");
/** What the engine presents to the product when it asks for an MCP token; absent if not local. */
export const ENGINE_TOKEN = process.env.APP_ENGINE_TOKEN ?? "";
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS ?? 5 * 60 * 1000);
const POLL_INTERVAL_MS = 2000;
/** Credits `generate_image` charges (packages/demo-app/server/mcp.ts IMAGE_CREDITS). */
export const IMAGE_CREDITS = 20;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export const newEmail = (tag = "e2e") => `${tag}-${randomBytes(4).toString("hex")}@example.test`;
export const newPassword = () => randomBytes(12).toString("hex");

/** A signed-in (or about to be) user: its own cookie jar and the calls a browser makes. */
export class DemoClient {
  cookie = "";
  user = null;

  /** The raw response; use `api` for parsed JSON that throws on an error status. */
  async fetch(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${DEMO_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return response;
  }

  async api(path, options) {
    const response = await this.fetch(path, options);
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${options?.method ?? "GET"} ${path} -> ${response.status} ${text}`);
    }
    return json;
  }

  async signUp(email = newEmail(), password = newPassword()) {
    const { user } = await this.api("/api/auth/signup", {
      method: "POST",
      body: { email, password },
    });
    this.user = { ...user, password };
    return this.user;
  }

  credits = async () => (await this.api("/api/me")).user.credits;

  async createConversation() {
    return (await this.api("/api/conversations", { method: "POST", body: {} })).conversation;
  }

  /** Send a prompt and wait for its turn to be settled; returns the settled turn. */
  async runTurn(conversationId, content) {
    const { turn } = await this.api(`/api/conversations/${conversationId}/prompt`, {
      method: "POST",
      body: { content },
    });
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.credits(); // reading the balance settles finished turns
      const { turns } = await this.api(`/api/conversations/${conversationId}`);
      const current = turns.find((candidate) => candidate.messageId === turn.messageId);
      if (current?.status === "settled") return current;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`turn ${turn.messageId} did not settle within ${TURN_TIMEOUT_MS / 1000}s`);
  }

  async artifacts(conversationId) {
    return (await this.api(`/api/conversations/${conversationId}/artifacts`)).artifacts;
  }

  /** The engine's side: a one-hour MCP token for this user, minted the way the engine asks. */
  async mintMcpToken() {
    check(
      ENGINE_TOKEN,
      "APP_ENGINE_TOKEN is not set (no .env.local), so the engine side cannot be played"
    );
    const response = await fetch(`${DEMO_URL}/api/engine/mcp-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ENGINE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: this.user.id }),
    });
    check(response.ok, `mint answered ${response.status}`);
    return (await response.json()).access_token;
  }
}

/** One JSON-RPC message to the product's MCP server; returns the HTTP status and the body. */
export async function mcp(token, message) {
  const response = await fetch(`${DEMO_URL}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Call an MCP tool; returns the tool's parsed result and whether it reported an error. */
export async function callTool(token, name, args = {}) {
  const { status, body } = await mcp(token, {
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  check(status === 200, `tools/call ${name} answered ${status}`);
  const result = body.result;
  const text = result.content?.[0]?.text ?? "";
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    // An error is plain text.
  }
  return { value, isError: Boolean(result.isError) };
}
