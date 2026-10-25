/**
 * The sandbox keeps a copy of its project files in the media store (see
 * `storage/workspace-copies.ts`). It archives them itself and sends the
 * archive straight to the store in signed parts; the host only opens and
 * closes the upload and prunes old copies.
 *
 *   POST /sessions/:id/workspace-copies            → key, upload id, signed part URLs
 *   POST /sessions/:id/workspace-copies/complete   → closes the upload, keeps the newest copies
 *
 * Only the session's own sandbox may call them.
 */

import { Hono } from "hono";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import { DIRECT_UPLOAD_PART_BYTES, DIRECT_UPLOAD_URL_TTL_SECONDS } from "../media";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  buildWorkspaceCopyKey,
  isWorkspaceCopyKey,
  pruneWorkspaceCopies,
  WORKSPACE_COPY_EXTENSIONS,
  WORKSPACE_COPY_MAX_BYTES,
} from "../storage/workspace-copies";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:workspace-copies");

const startSchema = z.object({
  sizeBytes: z.number().int().positive(),
  extension: z.enum(WORKSPACE_COPY_EXTENSIONS),
});

const completeSchema = z.object({
  key: z.string().min(1).max(512),
  uploadId: z.string().min(1).max(2048),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1).max(256),
      })
    )
    .min(1)
    .max(10_000),
});

export async function handleStartWorkspaceCopy(
  request: Request,
  env: Env,
  params: { id: string },
  _ctx: SandboxRouteContext
): Promise<Response> {
  const direct = env.MEDIA_DIRECT;
  if (!direct) return error("Workspace copies are not available on this deployment", 501);
  const body = await parseBody(request, startSchema);
  if (body instanceof Response) return body;
  if (body.sizeBytes > WORKSPACE_COPY_MAX_BYTES) {
    return error(`A workspace copy must be ${WORKSPACE_COPY_MAX_BYTES} bytes or smaller`, 413);
  }

  const key = buildWorkspaceCopyKey(params.id, generateId(), body.extension, Date.now());
  const contentType = body.extension === "tar.zst" ? "application/zstd" : "application/gzip";
  const uploadId = await direct.createMultipartUpload(key, { contentType });
  const partCount = Math.max(1, Math.ceil(body.sizeBytes / DIRECT_UPLOAD_PART_BYTES));
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, index) => ({
      partNumber: index + 1,
      url: await direct.signUploadPart(key, uploadId, index + 1, DIRECT_UPLOAD_URL_TTL_SECONDS),
    }))
  );
  return json({ key, uploadId, partSizeBytes: DIRECT_UPLOAD_PART_BYTES, parts }, 201);
}

export async function handleCompleteWorkspaceCopy(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const direct = env.MEDIA_DIRECT;
  if (!direct) return error("Workspace copies are not available on this deployment", 501);
  const body = await parseBody(request, completeSchema);
  if (body instanceof Response) return body;
  if (!isWorkspaceCopyKey(params.id, body.key)) return error("Unknown workspace copy", 400);

  try {
    await direct.completeMultipartUpload(body.key, body.uploadId, body.parts);
  } catch (completeError) {
    logger.warn("workspace_copy.complete_failed", {
      session_id: params.id,
      key: body.key,
      error: completeError instanceof Error ? completeError : String(completeError),
    });
    return error("The workspace copy could not be completed", 409);
  }

  const stored = await env.MEDIA_BUCKET.head(body.key);
  if (!stored) return error("The workspace copy could not be completed", 409);
  if (stored.size > WORKSPACE_COPY_MAX_BYTES) {
    await env.MEDIA_BUCKET.delete(body.key);
    return error(`A workspace copy must be ${WORKSPACE_COPY_MAX_BYTES} bytes or smaller`, 413);
  }

  const pruned = await pruneWorkspaceCopies(
    direct,
    (key) => env.MEDIA_BUCKET.delete(key),
    params.id
  );
  logger.info("workspace_copy.saved", {
    event: "workspace_copy.saved",
    session_id: params.id,
    sandbox_id: ctx.principal.sandboxId ?? null,
    key: body.key,
    size_bytes: stored.size,
    pruned: pruned.length,
  });
  return json({ key: body.key, sizeBytes: stored.size }, 201);
}

export const sessionWorkspaceCopyRoutes = new Hono<ControlPlaneHonoEnv>();

const sandboxOnly = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  cacheControl: "no-store",
  authorization: NO_AUTHORIZATION,
});

sessionWorkspaceCopyRoutes.post("/sessions/:id/workspace-copies", sandboxOnly, (c) =>
  dispatch(c, handleStartWorkspaceCopy)
);
sessionWorkspaceCopyRoutes.post("/sessions/:id/workspace-copies/complete", sandboxOnly, (c) =>
  dispatch(c, handleCompleteWorkspaceCopy)
);
