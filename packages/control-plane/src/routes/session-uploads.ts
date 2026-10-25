/**
 * Direct uploads: the sandbox sends a file artifact (any type, up to
 * FILE_MAX_BYTES) or a large video preview straight to the media store in
 * parts it PUTs to signed URLs, and the host only opens, closes and records
 * the upload. Nothing here buffers the file.
 *
 *   POST /sessions/:id/uploads                          → artifact id, upload id, signed part URLs
 *   POST /sessions/:id/uploads/:artifactId/complete     → closes the upload, records the artifact
 *   POST /sessions/:id/uploads/:artifactId/abort        → drops the parts sent so far
 *
 * The object key is derived from the session, the artifact id the host
 * issued and the file's extension, so a sandbox can only write under its own
 * session, and completing names the same key starting did.
 */

import { Hono } from "hono";
import { z } from "zod";
import type {
  FileArtifactMetadata,
  VideoArtifactMetadata,
} from "@open-inspect/shared/types/artifacts";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  buildFileObjectKey,
  buildMediaObjectKey,
  detectVideoFileType,
  DIRECT_UPLOAD_PART_BYTES,
  DIRECT_UPLOAD_URL_TTL_SECONDS,
  FILE_MAX_BYTES,
  FILE_UPLOAD_LIMIT_PER_SESSION,
  normalizeFileContentType,
  parseVideoUploadMetadata,
  sanitizeFilename,
  VIDEO_MAX_BYTES,
  VIDEO_UPLOAD_LIMIT_PER_SESSION,
} from "../media";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { DirectObjectTransfer } from "../storage/direct-transfer";
import type { ObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { parseBody } from "./body";
import { listSessionArtifactsFromRuntime, persistMediaArtifact } from "./session-media-artifacts";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import { error, GITHUB_SANDBOX_FALLBACK_ROUTE, json, requireSession } from "./shared";

const logger = createLogger("router:session-uploads");

/** S3 caps a multipart upload at 10,000 parts. */
const MAX_PARTS = 10_000;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9-]+$/;

const uploadTypeSchema = z.enum(["file", "video"]);

const startUploadSchema = z.object({
  artifactType: uploadTypeSchema,
  filename: z.string().min(1).max(1024),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().max(255).optional(),
});

const completeUploadSchema = z.object({
  artifactType: uploadTypeSchema,
  uploadId: z.string().min(1).max(2048),
  filename: z.string().min(1).max(1024),
  contentType: z.string().max(255).optional(),
  caption: z.string().max(500).optional(),
  kind: z.enum(["file", "project"]).optional(),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(MAX_PARTS),
        etag: z.string().min(1).max(256),
      })
    )
    .min(1)
    .max(MAX_PARTS),
  /** Video previews only: the fields the multipart video route takes, as strings or numbers. */
  video: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const abortUploadSchema = z.object({
  artifactType: uploadTypeSchema,
  uploadId: z.string().min(1).max(2048),
  filename: z.string().min(1).max(1024),
});

type UploadType = z.infer<typeof uploadTypeSchema>;

const LIMITS: Record<UploadType, { maxBytes: number; perSession: number; noun: string }> = {
  file: { maxBytes: FILE_MAX_BYTES, perSession: FILE_UPLOAD_LIMIT_PER_SESSION, noun: "file" },
  video: { maxBytes: VIDEO_MAX_BYTES, perSession: VIDEO_UPLOAD_LIMIT_PER_SESSION, noun: "video" },
};

function directTransfer(env: Env): DirectObjectTransfer | Response {
  return env.MEDIA_DIRECT ?? error("Direct uploads are not available on this deployment", 501);
}

/** The key an upload writes to; the same inputs on start, complete and abort give the same key. */
function uploadObjectKey(
  sessionId: string,
  artifactId: string,
  artifactType: UploadType,
  filename: string
): string {
  return artifactType === "video"
    ? buildMediaObjectKey(sessionId, artifactId, "mp4")
    : buildFileObjectKey(sessionId, artifactId, filename);
}

async function checkSessionLimit(
  sessionId: string,
  artifactType: UploadType,
  ctx: SessionRouteContext
): Promise<Response | null> {
  const artifacts = await listSessionArtifactsFromRuntime(sessionId, ctx);
  if (artifacts instanceof Response) return artifacts;
  const { perSession, noun } = LIMITS[artifactType];
  const count = artifacts.filter((artifact) => artifact.type === artifactType).length;
  return count >= perSession
    ? error(`Session ${noun} limit of ${perSession} uploads exceeded`, 429)
    : null;
}

export async function handleStartUpload(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const direct = directTransfer(env);
  if (direct instanceof Response) return direct;

  const body = await parseBody(request, startUploadSchema);
  if (body instanceof Response) return body;

  const filename = sanitizeFilename(body.filename);
  if (!filename) return error("filename must name a file", 400);
  const { maxBytes, noun } = LIMITS[body.artifactType];
  if (body.sizeBytes > maxBytes) {
    return error(`A ${noun} upload must be ${maxBytes} bytes or smaller`, 400);
  }
  if (body.artifactType === "video" && !/\.mp4$/i.test(filename)) {
    return error("Video previews must be .mp4 files; send other videos as files", 400);
  }

  const limited = await checkSessionLimit(params.id, body.artifactType, ctx);
  if (limited) return limited;

  const artifactId = generateId();
  const objectKey = uploadObjectKey(params.id, artifactId, body.artifactType, filename);
  const contentType =
    body.artifactType === "video" ? "video/mp4" : normalizeFileContentType(body.contentType);
  const partCount = Math.max(1, Math.ceil(body.sizeBytes / DIRECT_UPLOAD_PART_BYTES));
  const uploadId = await direct.createMultipartUpload(objectKey, { contentType });
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, index) => ({
      partNumber: index + 1,
      url: await direct.signUploadPart(
        objectKey,
        uploadId,
        index + 1,
        DIRECT_UPLOAD_URL_TTL_SECONDS
      ),
    }))
  );

  return json(
    {
      artifactId,
      objectKey,
      uploadId,
      filename,
      partSizeBytes: DIRECT_UPLOAD_PART_BYTES,
      parts,
      expiresAt: Date.now() + DIRECT_UPLOAD_URL_TTL_SECONDS * 1000,
    },
    201
  );
}

/** String fields for the shared video metadata parser, from a JSON object. */
function videoFields(values: Record<string, string | number | boolean> | undefined) {
  return {
    get(name: string): string | null {
      const value = values?.[name];
      if (value === undefined) return null;
      return typeof value === "string" ? value : value === null ? null : String(value);
    },
  };
}

async function hasMp4Signature(storage: ObjectStorage, objectKey: string): Promise<boolean> {
  const head = await storage.get(objectKey, { range: { offset: 0, length: 12 } });
  if (!head) return false;
  const bytes = new Uint8Array(await new Response(head.body).arrayBuffer());
  return detectVideoFileType(bytes) !== null;
}

export async function handleCompleteUpload(
  request: Request,
  env: Env,
  params: { id: string; artifactId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const direct = directTransfer(env);
  if (direct instanceof Response) return direct;
  if (!ARTIFACT_ID_PATTERN.test(params.artifactId)) return error("Invalid artifact ID", 400);

  const body = await parseBody(request, completeUploadSchema);
  if (body instanceof Response) return body;
  const filename = sanitizeFilename(body.filename);
  if (!filename) return error("filename must name a file", 400);

  let videoMetadata: ReturnType<typeof parseVideoUploadMetadata> | null = null;
  if (body.artifactType === "video") {
    try {
      videoMetadata = parseVideoUploadMetadata(videoFields(body.video));
    } catch (fieldError) {
      return error(
        fieldError instanceof Error ? fieldError.message : "Invalid video metadata",
        400
      );
    }
  }

  const storage = env.MEDIA_BUCKET;
  const objectKey = uploadObjectKey(params.id, params.artifactId, body.artifactType, filename);
  const discard = async () => {
    try {
      await storage.delete(objectKey);
    } catch (cleanupError) {
      logger.error("upload.cleanup_failed", {
        session_id: params.id,
        artifact_id: params.artifactId,
        object_key: objectKey,
        error: cleanupError instanceof Error ? cleanupError : String(cleanupError),
      });
    }
  };

  try {
    await direct.completeMultipartUpload(objectKey, body.uploadId, body.parts);
  } catch (completeError) {
    logger.warn("upload.complete_failed", {
      session_id: params.id,
      artifact_id: params.artifactId,
      object_key: objectKey,
      error: completeError instanceof Error ? completeError : String(completeError),
    });
    return error("The upload could not be completed; send every part and try again", 409);
  }

  const stored = await storage.head(objectKey);
  if (!stored) return error("The upload could not be completed", 409);
  const { maxBytes, noun } = LIMITS[body.artifactType];
  if (stored.size > maxBytes) {
    await discard();
    return error(`A ${noun} upload must be ${maxBytes} bytes or smaller`, 400);
  }

  const limited = await checkSessionLimit(params.id, body.artifactType, ctx);
  if (limited) {
    await discard();
    return limited;
  }

  if (videoMetadata) {
    if (!(await hasMp4Signature(storage, objectKey))) {
      await discard();
      return error("Uploaded file is not a supported video format", 400);
    }
    const metadata: VideoArtifactMetadata = {
      ...videoMetadata,
      objectKey,
      mimeType: "video/mp4",
      sizeBytes: stored.size,
    };
    const persistError = await persistMediaArtifact({
      sessionId: params.id,
      artifactId: params.artifactId,
      artifactType: "video",
      objectKey,
      metadata,
      storage,
      ctx,
      parseFallback: "Failed to persist video artifact",
    });
    return persistError ?? json({ artifactId: params.artifactId, objectKey }, 201);
  }

  const caption = body.caption?.trim();
  const metadata: FileArtifactMetadata = {
    objectKey,
    filename,
    mimeType: normalizeFileContentType(body.contentType),
    sizeBytes: stored.size,
    ...(caption ? { caption } : {}),
    ...(body.kind === "project" ? { kind: "project" as const } : {}),
  };
  const persistError = await persistMediaArtifact({
    sessionId: params.id,
    artifactId: params.artifactId,
    artifactType: "file",
    objectKey,
    metadata,
    storage,
    ctx,
    parseFallback: "Failed to persist file artifact",
  });
  return persistError ?? json({ artifactId: params.artifactId, objectKey, filename }, 201);
}

export async function handleAbortUpload(
  request: Request,
  env: Env,
  params: { id: string; artifactId: string }
): Promise<Response> {
  const direct = directTransfer(env);
  if (direct instanceof Response) return direct;
  if (!ARTIFACT_ID_PATTERN.test(params.artifactId)) return error("Invalid artifact ID", 400);
  const body = await parseBody(request, abortUploadSchema);
  if (body instanceof Response) return body;
  const filename = sanitizeFilename(body.filename);
  if (!filename) return error("filename must name a file", 400);
  const objectKey = uploadObjectKey(params.id, params.artifactId, body.artifactType, filename);
  await direct.abortMultipartUpload(objectKey, body.uploadId);
  return json({ status: "aborted" });
}

export const sessionUploadRoutes = new Hono<ControlPlaneHonoEnv>();

const sandboxUpload = admit({
  ...GITHUB_SANDBOX_FALLBACK_ROUTE,
  authorization: requireSession("collaborate"),
});

sessionUploadRoutes.post("/sessions/:id/uploads", sandboxUpload, (c) =>
  dispatchSession(c, handleStartUpload)
);
sessionUploadRoutes.post("/sessions/:id/uploads/:artifactId/complete", sandboxUpload, (c) =>
  dispatchSession(c, handleCompleteUpload)
);
sessionUploadRoutes.post("/sessions/:id/uploads/:artifactId/abort", sandboxUpload, (c) =>
  dispatchSession(c, (request, env, params) => handleAbortUpload(request, env, params))
);
