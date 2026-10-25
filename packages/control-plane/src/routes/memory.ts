/**
 * User memory routes (docs/USER_MEMORY.md). See `memory/service.ts` for the rules.
 *
 * Owner routes (`/memory/...`) act on the signed-in user's own memory only, directly or through
 * the product's backend acting for them; an entry or batch that is someone else's answers 404
 * like one that does not exist.
 *
 * Sandbox routes (`/sessions/:id/memory...`, SANDBOX_AUTH_TOKEN) act on
 * the memory of the session's owner. Writes and context reads also tell the
 * session's viewers (`memory_updated`, `memory_loaded`).
 */

import {
  createUserMemoryEntryRequestSchema,
  userMemoryForgetPreviewRequestSchema,
  userMemoryForgetRequestSchema,
  userMemoryOpsRequestSchema,
  userMemorySettingsSchema,
  USER_MEMORY_LIMITS,
  updateUserMemoryEntryRequestSchema,
  type UserMemoryLoadedMessage,
  type UserMemoryUpdatedMessage,
} from "@open-inspect/shared/types/user-memory";
import { Hono } from "hono";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import { broadcastUserMemoryEvent } from "../memory/events";
import { UserMemoryError, UserMemoryService } from "../memory/service";
import { UserMemoryStore } from "../memory/store";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  actingUserId,
  appUserSelf,
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
  type UserOrServiceRouteContext,
} from "./shared";

const logger = createLogger("router:user-memory");

/** Entry ids are generated hex; anything else cannot name an entry. */
const ENTRY_ID = /^[A-Za-z0-9-]{1,128}$/;
/** Batch ids: `<kind>:<id>`, an extraction's being `extract:<message id>`. */
const BATCH_ID = /^[A-Za-z0-9:_-]{1,200}$/;
/** Recall searches with the user's message; only its start is used. */
const RECALL_QUERY_MAX_CHARS = 2_000;

function memory(ctx: RequestContext): UserMemoryService {
  return new UserMemoryService({
    store: new UserMemoryStore(ctx.db),
    generateId: () => generateId(),
  });
}

/** Run `body`, answering a UserMemoryError with its status and message. */
async function handled(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (cause) {
    if (cause instanceof UserMemoryError) return error(cause.message, cause.status);
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

async function handleList(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json(await memory(ctx).list(actingUserId(ctx)));
}

async function handleCreate(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, createUserMemoryEntryRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () => {
    const { entry, created } = await memory(ctx).create(actingUserId(ctx), body);
    return json({ entry }, created ? 201 : 200);
  });
}

async function handleUpdate(
  request: Request,
  _env: Env,
  params: { entryId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!ENTRY_ID.test(params.entryId)) return error("Memory entry not found", 404);
  const body = await parseBody(request, updateUserMemoryEntryRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () =>
    json({ entry: await memory(ctx).update(actingUserId(ctx), params.entryId, body) })
  );
}

async function handleForgetEntry(
  _request: Request,
  _env: Env,
  params: { entryId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!ENTRY_ID.test(params.entryId)) return error("Memory entry not found", 404);
  return handled(async () =>
    json({ count: await memory(ctx).forget(actingUserId(ctx), params.entryId) })
  );
}

async function handleApprove(
  _request: Request,
  _env: Env,
  params: { entryId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!ENTRY_ID.test(params.entryId)) return error("Memory entry not found", 404);
  return handled(async () =>
    json({ entry: await memory(ctx).approve(actingUserId(ctx), params.entryId) })
  );
}

async function handleDecline(
  _request: Request,
  _env: Env,
  params: { entryId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!ENTRY_ID.test(params.entryId)) return error("Memory entry not found", 404);
  return handled(async () =>
    json({ entry: await memory(ctx).decline(actingUserId(ctx), params.entryId) })
  );
}

async function handleUndo(
  _request: Request,
  _env: Env,
  params: { batchId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!BATCH_ID.test(params.batchId)) return error("Nothing to undo", 404);
  return handled(async () =>
    json({ count: await memory(ctx).undo(actingUserId(ctx), params.batchId) })
  );
}

async function handleForgetPreview(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, userMemoryForgetPreviewRequestSchema);
  if (body instanceof Response) return body;
  return json({ candidates: await memory(ctx).forgetPreview(actingUserId(ctx), body.query) });
}

async function handleForget(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, userMemoryForgetRequestSchema);
  if (body instanceof Response) return body;
  return json({
    count: await memory(ctx).forgetIds(actingUserId(ctx), body.ids, body.reason),
  });
}

async function handleClear(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json({ count: await memory(ctx).clear(actingUserId(ctx)) });
}

async function handleExport(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json(await memory(ctx).export(actingUserId(ctx)));
}

async function handleSettings(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, userMemorySettingsSchema);
  if (body instanceof Response) return body;
  return json(await memory(ctx).setPaused(actingUserId(ctx), body.paused));
}

// ---------------------------------------------------------------------------
// Sandbox routes
// ---------------------------------------------------------------------------

/** Run a sandbox handler for its session's owner; 404 when the session has none. */
async function asSessionOwner(
  ctx: SandboxRouteContext,
  sessionId: string,
  body: (ownerUserId: string) => Promise<Response>
): Promise<Response> {
  const ownerUserId = (await new SessionIndexStore(ctx.db).get(sessionId))?.userId ?? null;
  if (!ownerUserId) return error("Session not found", 404);
  return handled(() => body(ownerUserId));
}

/** Tell the session's viewers, after the response; a failure is logged, never the caller's. */
function tellSession(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  message: UserMemoryUpdatedMessage | UserMemoryLoadedMessage
): void {
  ctx.executionCtx.submit(
    () =>
      broadcastUserMemoryEvent(createSessionRuntimeClient(env, ctx), sessionId, message).catch(
        (cause: unknown) => {
          logger.warn("user_memory.broadcast_failed", {
            event: "user_memory.broadcast_failed",
            session_id: sessionId,
            message_type: message.type,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            error: cause instanceof Error ? cause : String(cause),
          });
        }
      ),
    { name: "user_memory.broadcast", context: { session_id: sessionId, type: message.type } }
  );
}

async function handleSandboxContext(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  return asSessionOwner(ctx, params.id, async (ownerUserId) => {
    const context = await memory(ctx).context(ownerUserId);
    tellSession(env, ctx, params.id, {
      type: "memory_loaded",
      counts: context.counts,
      paused: context.paused,
    });
    logger.info("user_memory.context_loaded", {
      event: "user_memory.context_loaded",
      session_id: params.id,
      entries: context.entryIds.length,
      paused: context.paused,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json(context);
  });
}

function recallLimit(raw: string | null): number {
  const limit = raw === null ? NaN : Number(raw);
  return Number.isInteger(limit) && limit >= 1
    ? Math.min(limit, USER_MEMORY_LIMITS.recallResults)
    : USER_MEMORY_LIMITS.recallResults;
}

async function handleSandboxSearch(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const search = new URL(request.url).searchParams;
  const query = (search.get("q") ?? "").trim().slice(0, RECALL_QUERY_MAX_CHARS);
  const exclude = new Set(
    (search.get("exclude") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
  return asSessionOwner(ctx, params.id, async (ownerUserId) =>
    json({
      results: query
        ? await memory(ctx).search(ownerUserId, query, {
            limit: recallLimit(search.get("limit")),
            exclude,
          })
        : [],
    })
  );
}

async function handleSandboxList(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  return asSessionOwner(ctx, params.id, async (ownerUserId) =>
    json(await memory(ctx).list(ownerUserId))
  );
}

async function handleSandboxOps(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const body = await parseBody(request, userMemoryOpsRequestSchema);
  if (body instanceof Response) return body;
  return asSessionOwner(ctx, params.id, async (ownerUserId) => {
    const writer = { kind: "agent", sessionId: params.id } as const;
    const applied = await memory(ctx).applyOps(ownerUserId, body.ops, writer);
    const update = UserMemoryService.updatedMessage(applied, writer);
    if (update) tellSession(env, ctx, params.id, update);
    logger.info("user_memory.ops", {
      event: "user_memory.ops",
      session_id: params.id,
      batch_id: applied.batchId,
      ops: body.ops.length,
      applied: applied.changes.length,
      outcomes: applied.results.map((result) => result.outcome).join(","),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ batchId: applied.batchId, results: applied.results });
  });
}

export const userMemoryRoutes = new Hono<ControlPlaneHonoEnv>();

const OWNER_READ = {
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf(),
  cacheControl: "private, no-store",
} as const;
const OWNER_WRITE = {
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf({ auditAllowed: true }),
  cacheControl: "no-store",
} as const;
const SANDBOX = {
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "no-store",
} as const;

userMemoryRoutes.get("/memory", admit(OWNER_READ), (c) => dispatch(c, handleList));
userMemoryRoutes.post("/memory/entries", admit(OWNER_WRITE), (c) => dispatch(c, handleCreate));
userMemoryRoutes.patch("/memory/entries/:entryId", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleUpdate)
);
userMemoryRoutes.delete("/memory/entries/:entryId", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleForgetEntry)
);
userMemoryRoutes.post("/memory/entries/:entryId/approve", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleApprove)
);
userMemoryRoutes.post("/memory/entries/:entryId/decline", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleDecline)
);
userMemoryRoutes.post("/memory/batches/:batchId/undo", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleUndo)
);
userMemoryRoutes.post("/memory/forget-preview", admit(OWNER_READ), (c) =>
  dispatch(c, handleForgetPreview)
);
userMemoryRoutes.post("/memory/forget", admit(OWNER_WRITE), (c) => dispatch(c, handleForget));
userMemoryRoutes.post("/memory/clear", admit(OWNER_WRITE), (c) => dispatch(c, handleClear));
userMemoryRoutes.get("/memory/export", admit(OWNER_READ), (c) => dispatch(c, handleExport));
userMemoryRoutes.put("/memory/settings", admit(OWNER_WRITE), (c) => dispatch(c, handleSettings));

userMemoryRoutes.get("/sessions/:id/memory/context", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxContext)
);
userMemoryRoutes.get("/sessions/:id/memory/search", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxSearch)
);
userMemoryRoutes.get("/sessions/:id/memory", admit(SANDBOX), (c) => dispatch(c, handleSandboxList));
userMemoryRoutes.post("/sessions/:id/memory/ops", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxOps)
);
