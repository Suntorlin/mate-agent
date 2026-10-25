#!/usr/bin/env node

import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN;

if (!BRIDGE_TOKEN) {
  console.error("SANDBOX_AUTH_TOKEN not set");
  process.exit(1);
}

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

async function bridgeFetch(urlPath, options = {}) {
  const sessionId = getSessionId();
  if (!sessionId) {
    throw new Error("Session ID not found in SESSION_CONFIG environment variable");
  }
  const url = `${BRIDGE_URL}/sessions/${sessionId}${urlPath}`;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${BRIDGE_TOKEN}`);
  const isFormDataBody = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormDataBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...options, headers });
}

async function extractError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text;
  } catch {
    return text;
  }
}

/** Videos up to this size are posted through the control plane; larger ones go straight to storage. */
const VIDEO_INLINE_MAX_BYTES = 100 * 1024 * 1024;
/** Parts of a direct upload sent at once. */
const DIRECT_UPLOAD_CONCURRENCY = 4;
const DIRECT_UPLOAD_ATTEMPTS = 3;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const resolvedFilePath = path.resolve(parsed.filePath);
  const fileStats = await stat(resolvedFilePath);
  if (!fileStats.isFile()) {
    throw new Error("upload-media.js requires a path to a file");
  }
  if (fileStats.size === 0) {
    throw new Error("upload-media.js cannot upload an empty file");
  }

  if (parsed.artifactType === "file") {
    const result = await uploadDirect(resolvedFilePath, fileStats.size, {
      artifactType: "file",
      filename: parsed.name ?? path.basename(resolvedFilePath),
      contentType: parsed.contentType ?? getMimeType(resolvedFilePath) ?? undefined,
      caption: parsed.caption,
      kind: parsed.kind,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const mimeType = getMimeType(resolvedFilePath);

  if (!mimeType) {
    throw new Error(
      "upload-media.js only previews .png, .jpg, .jpeg, .webp, .mp4, and .html files; " +
        "send any other file with --artifact-type file"
    );
  }

  const artifactType = parsed.artifactType ?? "screenshot";
  if (mimeType === "video/mp4" && artifactType !== "video") {
    throw new Error("MP4 files must be uploaded with --artifact-type video");
  }
  if (mimeType === "text/html" && artifactType !== "page") {
    throw new Error("HTML files must be uploaded with --artifact-type page");
  }
  if (artifactType === "page" && mimeType !== "text/html") {
    throw new Error("--artifact-type page requires an .html file");
  }
  if (artifactType === "video") {
    validateVideoOptions(parsed);
  }

  if (artifactType === "video" && fileStats.size > VIDEO_INLINE_MAX_BYTES) {
    const result = await uploadDirect(resolvedFilePath, fileStats.size, {
      artifactType: "video",
      filename: path.basename(resolvedFilePath),
      video: {
        caption: parsed.caption,
        durationMs: parsed.durationMs,
        recordingStartedAt: parsed.recordingStartedAt,
        recordingEndedAt: parsed.recordingEndedAt,
        dimensions: parsed.dimensions,
        truncated: parsed.truncated,
        hasAudio: parsed.hasAudio ?? "false",
        ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
        ...(parsed.endUrl ? { endUrl: parsed.endUrl } : {}),
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fileBytes = await readFile(resolvedFilePath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBytes], { type: mimeType }),
    path.basename(resolvedFilePath)
  );
  formData.append("artifactType", artifactType);

  if (artifactType === "video") {
    formData.append("caption", parsed.caption);
    formData.append("durationMs", parsed.durationMs);
    formData.append("recordingStartedAt", parsed.recordingStartedAt);
    formData.append("recordingEndedAt", parsed.recordingEndedAt);
    formData.append("dimensions", parsed.dimensions);
    formData.append("truncated", parsed.truncated);
    formData.append("hasAudio", parsed.hasAudio ?? "false");
    if (parsed.sourceUrl) formData.append("sourceUrl", parsed.sourceUrl);
    if (parsed.endUrl) formData.append("endUrl", parsed.endUrl);
  } else if (artifactType === "page") {
    if (parsed.caption) formData.append("caption", parsed.caption);
  } else {
    if (parsed.caption) formData.append("caption", parsed.caption);
    if (parsed.sourceUrl) formData.append("sourceUrl", parsed.sourceUrl);
    if (parsed.fullPage) formData.append("fullPage", "true");
    if (parsed.annotated) formData.append("annotated", "true");
    if (parsed.viewport) formData.append("viewport", parsed.viewport);
  }

  const response = await bridgeFetch("/media", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await extractError(response));
  }

  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Send a file straight to storage: the control plane opens a multipart upload and signs one URL
 * per part, the parts are PUT from disk (never held in memory whole), and the control plane closes
 * the upload and records the artifact.
 */
async function uploadDirect(filePath, sizeBytes, fields) {
  const { video, caption, kind, ...start } = fields;
  const startResponse = await bridgeFetch("/uploads", {
    method: "POST",
    body: JSON.stringify({ ...start, sizeBytes }),
  });
  if (!startResponse.ok) {
    throw new Error(await extractError(startResponse));
  }
  const upload = await startResponse.json();
  const body = {
    artifactType: start.artifactType,
    uploadId: upload.uploadId,
    filename: upload.filename,
    ...(start.contentType ? { contentType: start.contentType } : {}),
    ...(caption ? { caption } : {}),
    ...(kind ? { kind } : {}),
    ...(video ? { video } : {}),
  };

  let parts;
  try {
    const file = await openAsBlob(filePath);
    parts = await mapWithConcurrency(upload.parts, DIRECT_UPLOAD_CONCURRENCY, async (part) => {
      const begin = (part.partNumber - 1) * upload.partSizeBytes;
      const slice = file.slice(begin, Math.min(begin + upload.partSizeBytes, sizeBytes));
      return { partNumber: part.partNumber, etag: await putPart(part.url, slice) };
    });
  } catch (error) {
    await bridgeFetch(`/uploads/${upload.artifactId}/abort`, {
      method: "POST",
      body: JSON.stringify({
        artifactType: start.artifactType,
        uploadId: upload.uploadId,
        filename: upload.filename,
      }),
    }).catch(() => {});
    throw error;
  }

  const completeResponse = await bridgeFetch(`/uploads/${upload.artifactId}/complete`, {
    method: "POST",
    body: JSON.stringify({ ...body, parts }),
  });
  if (!completeResponse.ok) {
    throw new Error(await extractError(completeResponse));
  }
  return completeResponse.json();
}

async function putPart(url, slice) {
  let lastError;
  for (let attempt = 1; attempt <= DIRECT_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { method: "PUT", body: slice });
      if (!response.ok) {
        throw new Error(`storage answered ${response.status}: ${await response.text()}`);
      }
      const etag = response.headers.get("etag");
      if (!etag) throw new Error("storage answered without an ETag");
      return etag;
    } catch (error) {
      lastError = error;
      if (attempt < DIRECT_UPLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw new Error(
    `Upload failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseArgs(args) {
  if (args.length === 0 || args.includes("--help")) {
    printUsageAndExit(0);
  }

  const filePath = args[0];
  const options = {
    filePath,
    artifactType: undefined,
    caption: undefined,
    sourceUrl: undefined,
    endUrl: undefined,
    fullPage: false,
    annotated: false,
    viewport: undefined,
    durationMs: undefined,
    recordingStartedAt: undefined,
    recordingEndedAt: undefined,
    dimensions: undefined,
    truncated: undefined,
    hasAudio: undefined,
    kind: undefined,
    name: undefined,
    contentType: undefined,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--artifact-type":
        options.artifactType = parseArtifactType(requireValue(args, ++index, "--artifact-type"));
        break;
      case "--caption":
        options.caption = requireValue(args, ++index, "--caption");
        break;
      case "--source-url":
        options.sourceUrl = requireValue(args, ++index, "--source-url");
        break;
      case "--end-url":
        options.endUrl = requireValue(args, ++index, "--end-url");
        break;
      case "--full-page":
        options.fullPage = true;
        break;
      case "--annotated":
        options.annotated = true;
        break;
      case "--viewport":
        options.viewport = requireValue(args, ++index, "--viewport");
        break;
      case "--duration-ms":
        options.durationMs = requireValue(args, ++index, "--duration-ms");
        break;
      case "--recording-started-at":
        options.recordingStartedAt = requireValue(args, ++index, "--recording-started-at");
        break;
      case "--recording-ended-at":
        options.recordingEndedAt = requireValue(args, ++index, "--recording-ended-at");
        break;
      case "--dimensions":
        options.dimensions = requireValue(args, ++index, "--dimensions");
        break;
      case "--truncated":
        options.truncated = requireValue(args, ++index, "--truncated");
        break;
      case "--has-audio":
        options.hasAudio = requireValue(args, ++index, "--has-audio");
        break;
      case "--kind":
        options.kind = parseKind(requireValue(args, ++index, "--kind"));
        break;
      case "--name":
        options.name = requireValue(args, ++index, "--name");
        break;
      case "--content-type":
        options.contentType = requireValue(args, ++index, "--content-type");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseArtifactType(value) {
  if (value === "screenshot" || value === "video" || value === "page" || value === "file") {
    return value;
  }
  throw new Error("--artifact-type must be screenshot, video, page, or file");
}

function parseKind(value) {
  if (value === "file" || value === "project") {
    return value;
  }
  throw new Error("--kind must be file or project");
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function validateVideoOptions(options) {
  requireVideoValue(options.caption, "--caption");
  requireVideoValue(options.durationMs, "--duration-ms");
  requireVideoValue(options.recordingStartedAt, "--recording-started-at");
  requireVideoValue(options.recordingEndedAt, "--recording-ended-at");
  requireVideoValue(options.dimensions, "--dimensions");
  requireVideoValue(options.truncated, "--truncated");
}

function requireVideoValue(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} requires a value for video uploads`);
  }
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return null;
  }
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  upload-media <file-path> [--caption "..."] [--source-url "..."] [--full-page] [--annotated] [--viewport '{"width":1280,"height":720}']
  upload-media <recording.mp4> --artifact-type video --caption "..." --duration-ms <ms> --recording-started-at <epoch-ms> --recording-ended-at <epoch-ms> --dimensions '{"width":1280,"height":720}' --truncated false
  upload-media <page.html> --artifact-type page [--caption "..."]
  upload-media <any-file> --artifact-type file [--caption "..."] [--name "Download name.ext"] [--kind project]

Files (any type, up to 4 GiB) and videos over 100 MB go straight to storage in parts.
`;
  if (exitCode === 0) {
    console.log(usage.trim());
  } else {
    console.error(usage.trim());
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
