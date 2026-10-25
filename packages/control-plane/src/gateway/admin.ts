/**
 * The LLM gateway's admin API, called for a signed-in workspace admin: every
 * user's LLM spend and budget, one user's sessions, and per-user overrides
 * (a budget of their own, or a block). The gateway keeps the ledger and the
 * overrides; the control plane only checks the admin's permission and asks
 * with a short-lived JWT whose `sub` is the admin and whose `scope: "admin"`
 * is good for the gateway's /llm/admin routes and nothing else.
 */

import { z } from "zod";
import { mintJwt } from "../auth/jwt";
import { withRequestDeadline } from "../sandbox/request-deadline";
import type { GatewayConfig } from "./config";

export const GATEWAY_ADMIN_TOKEN_TTL_SECONDS = 60;
export const GATEWAY_ADMIN_SCOPE = "admin";
const GATEWAY_ADMIN_SESSION_ID = "control-plane-admin";
const GATEWAY_ADMIN_REQUEST_DEADLINE_MS = 10_000;
// Cloudflare in front of the gateway rejects some default client agents.
const USER_AGENT = "agent-engine-control-plane/1 (admin)";

const spendRowSchema = z.object({
  usd: z.number(),
  requests: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  last_at: z.string().optional(),
});

const limitSchema = z
  .object({
    budget_usd: z.number().nullable().optional(),
    blocked: z.boolean().optional(),
    updated_at: z.string(),
    updated_by: z.string(),
  })
  .nullable();

const gatewayUserSchema = z.object({
  sub: z.string(),
  period: z.string(),
  spent_usd: z.number(),
  requests: z.number(),
  budget_usd: z.number(),
  remaining_usd: z.number(),
  custom_budget: z.boolean(),
  blocked: z.boolean(),
  last_at: z.string().nullable(),
  all_time: spendRowSchema,
  limit: limitSchema,
});

const gatewayOverviewSchema = z.object({
  period: z.string(),
  periods: z.array(z.string()),
  period_type: z.enum(["month", "day"]),
  resets_at: z.string(),
  default_user_budget_usd: z.number(),
  global: z.object({
    budget_usd: z.number(),
    spent_usd: z.number().nullable(),
    remaining_usd: z.number().nullable(),
    since: z.string().nullable(),
  }),
  pending_requests: z.number(),
  users: z.array(gatewayUserSchema),
});

const gatewayUserDetailSchema = gatewayUserSchema.extend({
  sessions: z.array(spendRowSchema.extend({ sid: z.string() })),
});

/** What one session's calls cost over a stretch of time (and in all). */
const gatewaySessionSpendSchema = z.object({
  sid: z.string(),
  since: z.number(),
  until: z.number(),
  usd: z.number(),
  requests: z.number(),
  /** Calls in the window whose cost the gateway does not know yet. */
  unsettled: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  total: z
    .object({
      sub: z.string().nullable(),
      usd: z.number(),
      requests: z.number(),
      last_at: z.string().nullable(),
    })
    .nullable(),
});

export type GatewayAdminUser = z.infer<typeof gatewayUserSchema>;
export type GatewayAdminOverview = z.infer<typeof gatewayOverviewSchema>;
export type GatewayAdminUserDetail = z.infer<typeof gatewayUserDetailSchema>;
export type GatewaySessionSpend = z.infer<typeof gatewaySessionSpendSchema>;

export interface GatewayAdminPatch {
  readonly budget_usd?: number | null;
  readonly blocked?: boolean;
}

export class GatewayAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GatewayAdminError";
  }
}

type Gateway = GatewayConfig;

interface AdminCallInput {
  readonly adminUserId: string;
  readonly nowMs: number;
  readonly fetch?: typeof fetch;
  /** How long the call may take; defaults to the admin pages' deadline. */
  readonly deadlineMs?: number;
}

export async function mintGatewayAdminToken(
  secret: string,
  input: { readonly adminUserId: string; readonly nowMs: number }
): Promise<string> {
  const iat = Math.floor(input.nowMs / 1000);
  return mintJwt(
    {
      sub: input.adminUserId,
      sid: GATEWAY_ADMIN_SESSION_ID,
      scope: GATEWAY_ADMIN_SCOPE,
      iat,
      exp: iat + GATEWAY_ADMIN_TOKEN_TTL_SECONDS,
    },
    secret
  );
}

async function callGatewayAdmin<Schema extends z.ZodType>(
  gateway: Gateway,
  path: string,
  schema: Schema,
  input: AdminCallInput & { readonly method?: "GET" | "PATCH"; readonly body?: unknown }
): Promise<z.output<Schema>> {
  const token = await mintGatewayAdminToken(gateway.secret, input);
  const doFetch = input.fetch ?? gateway.fetch ?? fetch;
  const body = await withRequestDeadline(
    "LLM gateway",
    "admin",
    input.deadlineMs ?? GATEWAY_ADMIN_REQUEST_DEADLINE_MS,
    undefined,
    async (signal) => {
      const response = await doFetch(`${gateway.url}/llm/admin/${path}`, {
        method: input.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayAdminError(
          `LLM gateway admin returned ${response.status}`,
          response.status
        );
      }
      return response.json();
    }
  ).catch((cause: unknown) => {
    if (cause instanceof GatewayAdminError) throw cause;
    throw new GatewayAdminError("LLM gateway admin request failed", undefined, { cause });
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new GatewayAdminError("LLM gateway admin response is invalid");
  return parsed.data;
}

function periodQuery(period: string | undefined): string {
  return period ? `?period=${encodeURIComponent(period)}` : "";
}

export function fetchGatewayAdminOverview(
  gateway: Gateway,
  input: AdminCallInput & { readonly period?: string }
): Promise<GatewayAdminOverview> {
  return callGatewayAdmin(
    gateway,
    `overview${periodQuery(input.period)}`,
    gatewayOverviewSchema,
    input
  );
}

export function fetchGatewayAdminUser(
  gateway: Gateway,
  input: AdminCallInput & { readonly userId: string; readonly period?: string }
): Promise<GatewayAdminUserDetail> {
  return callGatewayAdmin(
    gateway,
    `users/${encodeURIComponent(input.userId)}${periodQuery(input.period)}`,
    gatewayUserDetailSchema,
    input
  );
}

/**
 * What the session's calls that finished between `sinceMs` and `untilMs` cost, by the gateway's
 * ledger: the real cost of a turn, which the agent's own estimate is not.
 */
export function fetchGatewaySessionSpend(
  gateway: Gateway,
  input: AdminCallInput & {
    readonly sessionId: string;
    readonly sinceMs: number;
    readonly untilMs: number;
  }
): Promise<GatewaySessionSpend> {
  const window = `since=${Math.trunc(input.sinceMs)}&until=${Math.trunc(input.untilMs)}`;
  return callGatewayAdmin(
    gateway,
    `sessions/${encodeURIComponent(input.sessionId)}?${window}`,
    gatewaySessionSpendSchema,
    input
  );
}

export function updateGatewayAdminUser(
  gateway: Gateway,
  input: AdminCallInput & { readonly userId: string; readonly patch: GatewayAdminPatch }
): Promise<GatewayAdminUser> {
  return callGatewayAdmin(gateway, `users/${encodeURIComponent(input.userId)}`, gatewayUserSchema, {
    ...input,
    method: "PATCH",
    body: input.patch,
  });
}
