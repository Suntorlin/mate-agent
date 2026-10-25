/**
 * The product built on the engine: its tools, served as an MCP server, act for
 * the product's own user, whom the product's backend relays to the engine as `app:<id>`.
 *
 * The engine holds a bearer on the product (APP_ENGINE_TOKEN) and asks it, at APP_TOKEN_URL, for a
 * short-lived MCP token for one user; the token is cached until shortly before it expires. Both
 * runtimes use the product's MCP server (APP_MCP_URL): the inline runtime as an MCP client, and
 * the sandbox's agent through its MCP configuration. Either way a call to one of its tools is
 * recorded as `mcp__<APP_MCP_NAME>__<tool>`, so a client reads both runtimes' calls alike.
 */

import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { z } from "zod";
import type { SqlDatabase } from "../db/sql-database";
import { SessionIndexStore } from "../db/session-index";
import type { InlineTool } from "../inline/runtime";
import type { EnvConfig } from "../types";
import { McpClient } from "./mcp-client";

export const APP_ACTOR_PREFIX = "app:";
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
/** A cached token is reused only with at least this much life left. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60 * 1000;

/** The product's MCP server name when APP_MCP_NAME is unset. */
export const DEFAULT_APP_MCP_NAME = "app";
/** The id that marks the product's entry among a session's MCP servers, whatever its name. */
export const APP_MCP_SERVER_ID = "app";
/**
 * The engine session a call to the product's tools comes from, so the product can file what a tool
 * makes under it. A sandbox's MCP proxy sends the same header (sandbox_runtime/mcp_proxy.py).
 */
export const APP_SESSION_HEADER = "X-Agent-Session";
/** Claude Code joins the name into `mcp__<name>__<tool>`, so it holds no underscore. */
const APP_MCP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

export interface AppConfig {
  mcpUrl: string;
  tokenUrl: string;
  engineToken: string;
  /** The name the agent knows the product's MCP server by. */
  mcpName: string;
}

export function readAppConfig(
  env: Pick<EnvConfig, "APP_MCP_URL" | "APP_TOKEN_URL" | "APP_ENGINE_TOKEN" | "APP_MCP_NAME">
): AppConfig | null {
  const mcpUrl = env.APP_MCP_URL?.trim();
  const tokenUrl = env.APP_TOKEN_URL?.trim();
  const engineToken = env.APP_ENGINE_TOKEN?.trim();
  if (!mcpUrl || !tokenUrl || !engineToken) return null;
  const mcpName = env.APP_MCP_NAME?.trim() || DEFAULT_APP_MCP_NAME;
  if (!APP_MCP_NAME_PATTERN.test(mcpName)) {
    throw new Error(
      `APP_MCP_NAME ${JSON.stringify(mcpName)} is not a server name: use lowercase letters, ` +
        "digits and hyphens, starting with a letter, at most 31 characters"
    );
  }
  return { mcpUrl, tokenUrl, engineToken, mcpName };
}

/** How a call to one of the product's tools is recorded, in either runtime. */
export function appToolEventName(config: AppConfig, tool: string): string {
  return `mcp__${config.mcpName}__${tool}`;
}

/** The product's user id behind a participant (`app:<id>`), or null for anyone else. */
export function appUserId(participantUserId: string | null | undefined): string | null {
  return participantUserId?.startsWith(APP_ACTOR_PREFIX)
    ? participantUserId.slice(APP_ACTOR_PREFIX.length) || null
    : null;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Tests only. */
export function clearAppTokenCache(): void {
  tokenCache.clear();
}

export async function mintAppToken(
  config: AppConfig,
  userId: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<{ token: string; expiresAt: number }> {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt - now() > TOKEN_REUSE_MARGIN_MS) return cached;
  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.engineToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ user_id: userId }),
    redirect: "manual",
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`the product refused an MCP token (${response.status})`);
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("the product returned an unexpected token body");
  const minted = {
    token: parsed.data.access_token,
    expiresAt: now() + parsed.data.expires_in * 1000,
  };
  tokenCache.set(userId, minted);
  return minted;
}

/** The product's tools for one turn of the inline runtime, with its MCP `instructions` (its persona). */
export async function appInlineTools(
  config: AppConfig,
  userId: string,
  fetchFn: typeof fetch = fetch,
  sessionId?: string | null
): Promise<{ tools: InlineTool[]; instructions?: string }> {
  const { token } = await mintAppToken(config, userId, fetchFn);
  const client = new McpClient(
    config.mcpUrl,
    token,
    fetchFn,
    sessionId ? { [APP_SESSION_HEADER]: sessionId } : {}
  );
  const tools = await client.listTools();
  const mapped = tools.map(
    (tool): InlineTool => ({
      definition: {
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema,
      },
      eventName: appToolEventName(config, tool.name),
      execute: (input) => client.callTool(tool.name, input),
    })
  );
  return { tools: mapped, instructions: client.instructions };
}

/** The product's MCP server as a sandbox's agent reaches it. */
export async function appSandboxMcpServer(
  config: AppConfig,
  userId: string,
  fetchFn: typeof fetch = fetch
): Promise<McpServerConfig> {
  const { token } = await mintAppToken(config, userId, fetchFn);
  return {
    // The sandbox finds the product's server by this id to keep its token fresh.
    id: APP_MCP_SERVER_ID,
    name: config.mcpName,
    type: "remote",
    url: config.mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
    enabled: true,
  };
}

/** The product's user who owns a session (the session index's owner, by `app` identity), or null. */
export async function sessionAppUser(db: SqlDatabase, sessionId: string): Promise<string | null> {
  const ownerId = (await new SessionIndexStore(db).get(sessionId))?.userId;
  if (!ownerId) return null;
  const row = await db
    .prepare(
      `SELECT provider_user_id FROM user_identities WHERE provider = 'app' AND user_id = ? LIMIT 1`
    )
    .bind(ownerId)
    .first<{ provider_user_id: string }>();
  return row?.provider_user_id ?? null;
}
