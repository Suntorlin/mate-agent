import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { createLogger } from "../logger";
import { isMediaArtifactType } from "@open-inspect/shared/types/artifacts";
import {
  attachmentContentDisposition,
  DIRECT_DOWNLOAD_URL_TTL_SECONDS,
  FILE_FALLBACK_CONTENT_TYPE,
  isSupportedScreenshotMimeType,
  isSupportedVideoMimeType,
  PAGE_CONTENT_TYPE,
  PAGE_RESPONSE_HEADERS,
  sanitizeFilename,
} from "../media";
import type { NormalizedArtifactResponse } from "../session/artifacts";
import type { ObjectStorageMetadata } from "../storage/object-storage";
import type { Env } from "../types";
import { parseByteRangeHeader, type ByteRange } from "./requests/byte-range";
import {
  createPartialStoredObjectResponse,
  createRangeNotSatisfiableResponse,
  createStoredObjectResponse,
} from "./responses/stored-object-response";
import { getSessionArtifactFromRuntime } from "./session-media-artifacts";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requireSession } from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";
const logger = createLogger("router:session-media");

function getMediaMimeType(
  artifact: NormalizedArtifactResponse
): "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | null {
  const mimeType = artifact.metadata?.mimeType;
  if (typeof mimeType !== "string") return null;
  if (isSupportedScreenshotMimeType(mimeType) || isSupportedVideoMimeType(mimeType)) {
    return mimeType;
  }
  return null;
}

function getStoredContentType(metadata: ObjectStorageMetadata): string | null {
  const headers = new Headers();
  metadata.writeHttpMetadata(headers);
  return headers.get("Content-Type");
}

function resolveMediaContentType(
  artifact: NormalizedArtifactResponse,
  metadata: ObjectStorageMetadata
): string | null {
  const storedContentType = getStoredContentType(metadata);
  if (
    storedContentType &&
    (isSupportedScreenshotMimeType(storedContentType) ||
      isSupportedVideoMimeType(storedContentType))
  ) {
    return storedContentType;
  }
  return getMediaMimeType(artifact);
}

export async function handleMediaGet(
  request: Request,
  env: Env,
  params: { id: string; artifactId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const artifactId = params.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  const storage = env.MEDIA_BUCKET;
  if (!/^[A-Za-z0-9-]+$/.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || !isMediaArtifactType(artifact.type) || !artifact.url) {
    return error("Media artifact not found", 404);
  }
  const disposition =
    artifact.type === "file" ? attachmentContentDisposition(fileArtifactName(artifact)) : null;
  // A file goes straight from the store to the browser, under its own name.
  if (disposition && env.MEDIA_DIRECT) {
    const location = await env.MEDIA_DIRECT.signGet(artifact.url, {
      expiresInSeconds: DIRECT_DOWNLOAD_URL_TTL_SECONDS,
      contentDisposition: disposition,
      contentType: FILE_FALLBACK_CONTENT_TYPE,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: location, "Cache-Control": "private, no-store" },
    });
  }

  const rangeHeader = request.headers.get("Range");
  let body: ReadableStream;
  let metadata: ObjectStorageMetadata;
  let range: ByteRange | null = null;

  if (rangeHeader) {
    const head = await storage.head(artifact.url);
    if (!head) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    range = parseByteRangeHeader(rangeHeader, head.size);
    if (!range) return createRangeNotSatisfiableResponse(head.size);

    const object = await storage.get(artifact.url, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    body = object.body;
    metadata = head;
  } else {
    const object = await storage.get(artifact.url);
    if (!object) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    body = object.body;
    metadata = object;
  }

  const contentType =
    artifact.type === "page"
      ? PAGE_CONTENT_TYPE
      : artifact.type === "file"
        ? FILE_FALLBACK_CONTENT_TYPE
        : resolveMediaContentType(artifact, metadata);
  if (!contentType) {
    logger.error("media.stream.invalid_metadata", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact is invalid", 500);
  }

  const response = range
    ? createPartialStoredObjectResponse(body, metadata, contentType, range)
    : createStoredObjectResponse(body, metadata, contentType);
  if (artifact.type === "page") {
    for (const [name, value] of Object.entries(PAGE_RESPONSE_HEADERS)) {
      response.headers.set(name, value);
    }
  }
  if (disposition) {
    response.headers.set("Content-Disposition", disposition);
    response.headers.set("X-Content-Type-Options", "nosniff");
  }
  return response;
}

/** The name a file artifact downloads under. */
function fileArtifactName(artifact: NormalizedArtifactResponse): string {
  const filename = artifact.metadata?.filename;
  return (typeof filename === "string" && sanitizeFilename(filename)) || "download";
}

export const sessionMediaStreamRoutes = new Hono<ControlPlaneHonoEnv>();

sessionMediaStreamRoutes.get(
  "/sessions/:id/media/:artifactId",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("read", {
      actorlessGrants: [{ service: "slack-bot" }],
    }),
  }),
  (c) => dispatchSession(c, handleMediaGet)
);
