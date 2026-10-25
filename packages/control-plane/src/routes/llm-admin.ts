/**
 * Workspace admins' view of LLM spend, read from the LLM gateway:
 *
 * - `GET /admin/llm-usage[?period=YYYY-MM]` — every user with spend this
 *   period or an override, and the service-wide figures;
 * - `GET /admin/llm-usage/users/:id[?period=]` — one user and their sessions;
 * - `PATCH /admin/llm-usage/users/:id` `{ budgetUsd?: number | null, blocked?: boolean }`
 *   — a budget of their own (`null` restores the default) or a block.
 *
 * The gateway keeps the ledger and the overrides; this adds what only the
 * control plane knows: users' names and emails, and session titles. Users the
 * gateway has seen but this workspace has not (another deployment sharing the
 * gateway) are listed with `inWorkspace: false`.
 *
 * 404 when no LLM gateway is configured; 502 when the gateway cannot answer.
 */

import { Hono } from "hono";
import { z } from "zod";
import { UserStore, type User } from "../db/user-store";
import { readGatewayConfig, type GatewayConfig } from "../gateway/config";
import {
  GatewayAdminError,
  fetchGatewayAdminOverview,
  fetchGatewayAdminUser,
  updateGatewayAdminUser,
  type GatewayAdminUser,
} from "../gateway/admin";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const logger = createLogger("router:llm-admin");

/** A user without a real address carries a placeholder under the reserved `.invalid` TLD. */
const PLACEHOLDER_EMAIL_SUFFIX = ".invalid";
const GATEWAY_USER_ID = /^[A-Za-z0-9@._-]{1,128}$/;
const PERIOD = /^\d{4}-\d{2}(-\d{2})?$/;
const MAX_SESSIONS = 50;

const updateUserSchema = z
  .object({
    budgetUsd: z.number().finite().min(0).max(100_000).nullable().optional(),
    blocked: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.budgetUsd !== undefined || body.blocked !== undefined, {
    message: "Send budgetUsd or blocked",
  });

type Gateway = GatewayConfig;

function gatewayOrResponse(env: Env, ctx: UserRouteContext): Gateway | Response {
  let gateway;
  try {
    gateway = readGatewayConfig(env);
  } catch (cause) {
    logger.error("llm_admin.misconfigured", {
      event: "llm_admin.misconfigured",
      request_id: ctx.request_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Usage is unavailable", 502);
  }
  return gateway ?? error("Usage is not available on this deployment", 404);
}

function gatewayFailure(cause: unknown, ctx: UserRouteContext): Response {
  if (cause instanceof GatewayAdminError && cause.status === 400) {
    return error("Invalid request", 400);
  }
  logger.warn("llm_admin.unavailable", {
    event: "llm_admin.unavailable",
    request_id: ctx.request_id,
    error: cause instanceof Error ? cause : String(cause),
  });
  return error("Usage is unavailable", 502);
}

function realEmail(user: User | undefined): string | null {
  const email = user?.email ?? null;
  return email && !email.endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? email : null;
}

function periodParam(request: Request): string | undefined | Response {
  const period = new URL(request.url).searchParams.get("period") ?? undefined;
  return period === undefined || PERIOD.test(period) ? period : error("Invalid period", 400);
}

async function usersById(
  ctx: UserRouteContext,
  ids: readonly string[]
): Promise<Map<string, User>> {
  const users = await new UserStore(ctx.db).getUsersByIds(ids);
  return new Map(users.map((user) => [user.id, user]));
}

async function sessionTitles(
  ctx: UserRouteContext,
  ids: readonly string[]
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const result = await ctx.db
    .prepare(`SELECT id, title FROM sessions WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids)
    .all<{ id: string; title: string | null }>();
  return new Map((result.results ?? []).map((row) => [row.id, row.title]));
}

function toUser(row: GatewayAdminUser, user: User | undefined) {
  return {
    id: row.sub,
    name: user?.displayName ?? null,
    email: realEmail(user),
    inWorkspace: user !== undefined,
    spentUsd: row.spent_usd,
    requests: row.requests,
    budgetUsd: row.budget_usd,
    remainingUsd: row.remaining_usd,
    customBudget: row.custom_budget,
    blocked: row.blocked,
    lastActiveAt: row.last_at,
  };
}

async function handleOverview(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const gateway = gatewayOrResponse(env, ctx);
  if (gateway instanceof Response) return gateway;
  const period = periodParam(request);
  if (period instanceof Response) return period;
  try {
    const overview = await fetchGatewayAdminOverview(gateway, {
      adminUserId: ctx.principal.userId,
      nowMs: Date.now(),
      period,
    });
    const users = await usersById(
      ctx,
      overview.users.map((row) => row.sub)
    );
    return json({
      period: overview.period,
      periods: overview.periods,
      periodType: overview.period_type,
      resetsAt: overview.resets_at,
      defaultUserBudgetUsd: overview.default_user_budget_usd,
      service: {
        budgetUsd: overview.global.budget_usd,
        spentUsd: overview.global.spent_usd,
        remainingUsd: overview.global.remaining_usd,
        since: overview.global.since,
      },
      pendingRequests: overview.pending_requests,
      users: overview.users.map((row) => toUser(row, users.get(row.sub))),
    });
  } catch (cause) {
    return gatewayFailure(cause, ctx);
  }
}

async function handleUser(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!GATEWAY_USER_ID.test(params.id)) return error("Invalid user ID", 400);
  const gateway = gatewayOrResponse(env, ctx);
  if (gateway instanceof Response) return gateway;
  const period = periodParam(request);
  if (period instanceof Response) return period;
  try {
    const detail = await fetchGatewayAdminUser(gateway, {
      adminUserId: ctx.principal.userId,
      nowMs: Date.now(),
      userId: params.id,
      period,
    });
    const updatedBy = detail.limit?.updated_by;
    const users = await usersById(ctx, updatedBy ? [detail.sub, updatedBy] : [detail.sub]);
    const rows = detail.sessions.slice(0, MAX_SESSIONS);
    const titles = await sessionTitles(
      ctx,
      rows.map((row) => row.sid)
    );
    const sessions = rows.map((row) => ({
      id: row.sid,
      title: titles.get(row.sid) ?? null,
      spentUsd: row.usd,
      requests: row.requests,
      lastActiveAt: row.last_at ?? null,
    }));
    const admin = updatedBy ? users.get(updatedBy) : undefined;
    return json({
      ...toUser(detail, users.get(detail.sub)),
      allTime: { spentUsd: detail.all_time.usd, requests: detail.all_time.requests },
      lastChange: detail.limit
        ? {
            at: detail.limit.updated_at,
            by: admin?.displayName ?? realEmail(admin) ?? detail.limit.updated_by,
          }
        : null,
      sessions,
    });
  } catch (cause) {
    return gatewayFailure(cause, ctx);
  }
}

async function handleUpdateUser(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!GATEWAY_USER_ID.test(params.id)) return error("Invalid user ID", 400);
  const body = await parseBody(request, updateUserSchema);
  if (body instanceof Response) return body;
  const gateway = gatewayOrResponse(env, ctx);
  if (gateway instanceof Response) return gateway;
  try {
    const row = await updateGatewayAdminUser(gateway, {
      adminUserId: ctx.principal.userId,
      nowMs: Date.now(),
      userId: params.id,
      patch: {
        ...(body.budgetUsd !== undefined ? { budget_usd: body.budgetUsd } : {}),
        ...(body.blocked !== undefined ? { blocked: body.blocked } : {}),
      },
    });
    logger.info("llm_admin.user_updated", {
      event: "llm_admin.user_updated",
      request_id: ctx.request_id,
      admin_user_id: ctx.principal.userId,
      target_user_id: params.id,
      budget_usd: body.budgetUsd,
      blocked: body.blocked,
    });
    const users = await usersById(ctx, [row.sub]);
    return json(toUser(row, users.get(row.sub)));
  } catch (cause) {
    return gatewayFailure(cause, ctx);
  }
}

const READ = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: "private, no-store",
  authorization: requirePermission("workspace.members.read"),
});
const MANAGE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: "private, no-store",
  authorization: requirePermission("workspace.members.manage"),
});

export const llmAdminRoutes = new Hono<ControlPlaneHonoEnv>();

llmAdminRoutes.get("/admin/llm-usage", READ, (c) => dispatch(c, handleOverview));
llmAdminRoutes.get("/admin/llm-usage/users/:id", READ, (c) => dispatch(c, handleUser));
llmAdminRoutes.patch("/admin/llm-usage/users/:id", MANAGE, (c) => dispatch(c, handleUpdateUser));
