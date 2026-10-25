/**
 * User files: large uploads, the library and session inputs. See `files/service.ts` for the
 * model.
 *
 * Owner routes (`/files/...`) act on the signed-in user's own files only; a
 * file id that is someone else's answers 404 like one that does not exist.
 *
 * Session routes for people (`/sessions/:id/inputs`) need the same
 * session access as sending a prompt (attach) or reading it (list).
 *
 * Sandbox routes (`/sessions/:id/files...`, SANDBOX_AUTH_TOKEN) see the
 * session's inputs and its owner's library, and may add to that library.
 */

import { readBodyCapped } from "@open-inspect/shared/http-body";
import {
  attachSessionInputsRequestSchema,
  createUserFileUploadRequestSchema,
  userFileIdSchema,
  userFileScopeSchema,
  signUserFileUploadPartsRequestSchema,
  updateUserFileRequestSchema,
} from "@open-inspect/shared/types/user-files";
import { Hono } from "hono";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import {
  DEFAULT_USER_FILES_QUOTA_BYTES,
  UserFileError,
  UserFileService,
  type UserFileCaller,
} from "../files/service";
import { UserFileStore, type UserFileRow } from "../files/store";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { parseByteRangeHeader } from "./requests/byte-range";
import {
  createPartialStoredObjectResponse,
  createRangeNotSatisfiableResponse,
  createStoredObjectResponse,
} from "./responses/stored-object-response";
import {
  actingUserId,
  appUserSelf,
  error,
  json,
  NO_AUTHORIZATION,
  requireSession,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
  type UserOrServiceRouteContext,
} from "./shared";

const logger = createLogger("router:files");

const GIB = 1024 * 1024 * 1024;

/** `USER_FILES_QUOTA_GB`, or DEFAULT_USER_FILES_QUOTA_BYTES. */
export function userFilesQuotaBytes(env: Pick<Env, "USER_FILES_QUOTA_GB">): number {
  const raw = env.USER_FILES_QUOTA_GB;
  const gigabytes = raw ? Number(raw) : NaN;
  return Number.isFinite(gigabytes) && gigabytes > 0
    ? Math.floor(gigabytes * GIB)
    : DEFAULT_USER_FILES_QUOTA_BYTES;
}

function service(env: Env, ctx: RequestContext): UserFileService {
  return new UserFileService({
    store: new UserFileStore(ctx.db),
    objects: env.MEDIA_BUCKET,
    transfers: env.MEDIA_TRANSFERS,
    quotaBytes: userFilesQuotaBytes(env),
    log: logger.child({ request_id: ctx.request_id, trace_id: ctx.trace_id }),
    generateId: () => generateId(),
  });
}

/** Run `body`, answering a UserFileError with its status and message. */
async function handled(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (cause) {
    if (cause instanceof UserFileError) return error(cause.message, cause.status);
    throw cause;
  }
}

function validFileId(fileId: string): boolean {
  return userFileIdSchema.safeParse(fileId).success;
}

/** The largest relayed part body: one part plus nothing. */
const RELAY_PART_MAX_BYTES = 64 * 1024 * 1024;

/** Stream a stored file, honouring one byte range. */
async function streamFile(env: Env, row: UserFileRow, request: Request): Promise<Response> {
  const contentType = row.mime_type || "application/octet-stream";
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const head = await env.MEDIA_BUCKET.head(row.object_key);
    if (!head) return error("File not found", 404);
    const range = parseByteRangeHeader(rangeHeader, head.size);
    if (!range) return createRangeNotSatisfiableResponse(head.size);
    const object = await env.MEDIA_BUCKET.get(row.object_key, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) return error("File not found", 404);
    return createPartialStoredObjectResponse(object.body, head, contentType, range);
  }
  const object = await env.MEDIA_BUCKET.get(row.object_key);
  if (!object) return error("File not found", 404);
  return createStoredObjectResponse(object.body, object, contentType);
}

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

async function handleCreateUpload(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, createUserFileUploadRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () =>
    json(await service(env, ctx).createUpload(actingUserId(ctx), body), 201)
  );
}

async function handleListFiles(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const scope = userFileScopeSchema.safeParse(
    new URL(request.url).searchParams.get("scope") ?? "library"
  );
  if (!scope.success) return error("scope must be library or input", 400);
  return json(await service(env, ctx).list(actingUserId(ctx), scope.data));
}

async function handleUploadStatus(
  _request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return handled(async () =>
    json(await service(env, ctx).uploadStatus(actingUserId(ctx), params.fileId))
  );
}

async function handleSignParts(
  request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  const body = await parseBody(request, signUserFileUploadPartsRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () =>
    json(
      await service(env, ctx).signParts(
        { kind: "user", userId: actingUserId(ctx) },
        params.fileId,
        body.partNumbers
      )
    )
  );
}

async function handleComplete(
  _request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return handled(async () =>
    json({
      file: await service(env, ctx).complete(
        { kind: "user", userId: actingUserId(ctx) },
        params.fileId
      ),
    })
  );
}

async function handleUpdateFile(
  request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  const body = await parseBody(request, updateUserFileRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () =>
    json({ file: await service(env, ctx).update(actingUserId(ctx), params.fileId, body) })
  );
}

async function handleDeleteFile(
  _request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return handled(async () => {
    await service(env, ctx).delete(actingUserId(ctx), params.fileId);
    return json({ deleted: true });
  });
}

/** `{ url }`: a short-lived signed URL to view (or, with `?download=1`, save) the file. */
async function handleFileUrl(
  request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return handled(async () => {
    const files = service(env, ctx);
    const row = await files.getReadableRow(
      { kind: "user", userId: actingUserId(ctx) },
      params.fileId
    );
    return json({ url: await files.signForOwner(row, download) });
  });
}

/** The file's bytes through the control plane, for stores without signed URLs. */
async function handleFileContent(
  request: Request,
  env: Env,
  params: { fileId: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return handled(async () => {
    const row = await service(env, ctx).getReadableRow(
      { kind: "user", userId: actingUserId(ctx) },
      params.fileId
    );
    return streamFile(env, row, request);
  });
}

async function handleAttachInputs(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const body = await parseBody(request, attachSessionInputsRequestSchema);
  if (body instanceof Response) return body;
  return handled(async () => {
    const files = await service(env, ctx).attachInputs(actingUserId(ctx), params.id, body.fileIds);
    logger.info("user_files.inputs_attached", {
      event: "user_files.inputs_attached",
      session_id: params.id,
      file_count: files.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ files });
  });
}

async function handleListInputs(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json({ files: await service(env, ctx).listSessionInputs(params.id) });
}

// ---------------------------------------------------------------------------
// Sandbox routes
// ---------------------------------------------------------------------------

async function sessionOwner(ctx: SandboxRouteContext, sessionId: string): Promise<string | null> {
  return (await new SessionIndexStore(ctx.db).get(sessionId))?.userId ?? null;
}

/** Run a sandbox handler as its session's owner; 404 when the session has none. */
async function asSandbox(
  ctx: SandboxRouteContext,
  sessionId: string,
  body: (caller: Extract<UserFileCaller, { kind: "sandbox" }>) => Promise<Response>
): Promise<Response> {
  const ownerUserId = await sessionOwner(ctx, sessionId);
  if (!ownerUserId) return error("Session not found", 404);
  return handled(() => body({ kind: "sandbox", sessionId, ownerUserId }));
}

async function handleSandboxIndex(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  return asSandbox(ctx, params.id, async (caller) =>
    json(await service(env, ctx).sandboxIndex(caller.sessionId, caller.ownerUserId))
  );
}

async function handleSandboxDownload(
  _request: Request,
  env: Env,
  params: { id: string; fileId: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return asSandbox(ctx, params.id, async (caller) => {
    const { row: _row, ...download } = await service(env, ctx).sandboxDownload(
      caller.sessionId,
      caller.ownerUserId,
      params.fileId
    );
    return json(download);
  });
}

async function handleSandboxContent(
  request: Request,
  env: Env,
  params: { id: string; fileId: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return asSandbox(ctx, params.id, async (caller) =>
    streamFile(env, await service(env, ctx).getReadableRow(caller, params.fileId), request)
  );
}

async function handleSandboxCreateUpload(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const body = await parseBody(request, createUserFileUploadRequestSchema);
  if (body instanceof Response) return body;
  if (body.scope !== "library") return error("Sandboxes save files to the library", 400);
  return asSandbox(ctx, params.id, async (caller) =>
    json(await service(env, ctx).createUpload(caller.ownerUserId, body), 201)
  );
}

async function handleSandboxSignParts(
  request: Request,
  env: Env,
  params: { id: string; fileId: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  const body = await parseBody(request, signUserFileUploadPartsRequestSchema);
  if (body instanceof Response) return body;
  return asSandbox(ctx, params.id, async (caller) =>
    json(await service(env, ctx).signParts(caller, params.fileId, body.partNumbers))
  );
}

async function handleSandboxRelayPart(
  request: Request,
  env: Env,
  params: { id: string; fileId: string; partNumber: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  const partNumber = Number(params.partNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1) return error("Invalid part number", 400);
  const bytes = await readBodyCapped(request.body, RELAY_PART_MAX_BYTES);
  if (!bytes) return error("Part is too large", 413);
  return asSandbox(ctx, params.id, async (caller) => {
    await service(env, ctx).relayPart(caller, params.fileId, partNumber, bytes);
    return json({ partNumber });
  });
}

async function handleSandboxComplete(
  _request: Request,
  env: Env,
  params: { id: string; fileId: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!validFileId(params.fileId)) return error("File not found", 404);
  return asSandbox(ctx, params.id, async (caller) =>
    json({ file: await service(env, ctx).complete(caller, params.fileId) })
  );
}

export const userFileRoutes = new Hono<ControlPlaneHonoEnv>();

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

userFileRoutes.get("/files", admit(OWNER_READ), (c) => dispatch(c, handleListFiles));
userFileRoutes.post("/files/uploads", admit(OWNER_WRITE), (c) => dispatch(c, handleCreateUpload));
userFileRoutes.get("/files/:fileId/upload", admit(OWNER_READ), (c) =>
  dispatch(c, handleUploadStatus)
);
userFileRoutes.post("/files/:fileId/upload/parts", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleSignParts)
);
userFileRoutes.post("/files/:fileId/upload/complete", admit(OWNER_WRITE), (c) =>
  dispatch(c, handleComplete)
);
userFileRoutes.get("/files/:fileId/url", admit(OWNER_READ), (c) => dispatch(c, handleFileUrl));
userFileRoutes.get("/files/:fileId/content", admit(OWNER_READ), (c) =>
  dispatch(c, handleFileContent)
);
userFileRoutes.patch("/files/:fileId", admit(OWNER_WRITE), (c) => dispatch(c, handleUpdateFile));
userFileRoutes.delete("/files/:fileId", admit(OWNER_WRITE), (c) => dispatch(c, handleDeleteFile));

userFileRoutes.post(
  "/sessions/:id/inputs",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("collaborate"),
    cacheControl: "no-store",
  }),
  (c) => dispatch(c, handleAttachInputs)
);
userFileRoutes.get(
  "/sessions/:id/inputs",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("read"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleListInputs)
);

userFileRoutes.get("/sessions/:id/files", admit(SANDBOX), (c) => dispatch(c, handleSandboxIndex));
userFileRoutes.post("/sessions/:id/files/uploads", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxCreateUpload)
);
userFileRoutes.get("/sessions/:id/files/:fileId/download", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxDownload)
);
userFileRoutes.get("/sessions/:id/files/:fileId/content", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxContent)
);
userFileRoutes.post("/sessions/:id/files/:fileId/upload/parts", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxSignParts)
);
userFileRoutes.put("/sessions/:id/files/:fileId/upload/parts/:partNumber", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxRelayPart)
);
userFileRoutes.post("/sessions/:id/files/:fileId/upload/complete", admit(SANDBOX), (c) =>
  dispatch(c, handleSandboxComplete)
);
