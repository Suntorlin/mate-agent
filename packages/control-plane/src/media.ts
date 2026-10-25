import type { VideoArtifactMetadata } from "@open-inspect/shared/types/artifacts";
import {
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  type SessionAttachmentMimeType,
} from "@open-inspect/shared/types/session-attachments";

export { SESSION_ATTACHMENT_IMAGE_MAX_BYTES };

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const SCREENSHOT_MAX_BYTES = 10 * MiB;
export const SCREENSHOT_UPLOAD_LIMIT_PER_SESSION = 100;
/**
 * Videos are previews: H.264 MP4 the browser plays in place. Up to VIDEO_INLINE_MAX_BYTES they may
 * be posted through the host as a multipart form; anything larger goes straight to the object store
 * (a direct upload) up to VIDEO_MAX_BYTES. Deliverables in any other codec, or longer and larger
 * than this, are file artifacts.
 */
export const VIDEO_INLINE_MAX_BYTES = 100 * MiB;
export const VIDEO_MAX_BYTES = 1 * GiB;
export const VIDEO_MAX_DURATION_MS = 10 * 60_000;
export const VIDEO_UPLOAD_LIMIT_PER_SESSION = 200;
const VIDEO_TIMESTAMP_TOLERANCE_MS = 1_000;
/**
 * Files are deliverables of any type (documents, archives, editing-app project files, masters in
 * any codec). They only ever travel directly between the sandbox or browser and the object store.
 */
export const FILE_MAX_BYTES = 4 * GiB;
export const FILE_UPLOAD_LIMIT_PER_SESSION = 200;
export const FILE_FALLBACK_CONTENT_TYPE = "application/octet-stream";
/**
 * Direct uploads go up in parts of this size. 64 MiB keeps a 4 GiB file at 64 parts and each part
 * under the 100 MB request-body ceiling of proxies such as Cloudflare in front of the store.
 */
export const DIRECT_UPLOAD_PART_BYTES = 64 * MiB;
/** How long the sandbox has to send each part of a direct upload. */
export const DIRECT_UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;
/** How long a signed download link handed to the browser stays valid. */
export const DIRECT_DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
export const PAGE_MAX_BYTES = 10 * MiB;
export const PAGE_UPLOAD_LIMIT_PER_SESSION = 50;
export const PAGE_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Agent-made pages run their own scripts, so they are served as their own opaque origin: the CSP
 * sandbox (without allow-same-origin) applies even when the page is opened directly, keeping it
 * away from the viewer's cookies and the app around it. Self-contained pages may still pull fonts,
 * scripts and media over HTTPS, open links in a new tab, and save files they make (data: and blob:
 * links with `download`).
 */
export const PAGE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
    "style-src 'unsafe-inline' https: data:",
    "img-src https: data: blob:",
    "media-src https: data: blob:",
    "font-src https: data:",
    "connect-src https: data: blob:",
    "frame-src https:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Allows multipart boundaries and headers while rejecting oversized requests
// before request.formData() buffers them when Content-Length is available.
export const SESSION_ATTACHMENT_MAX_REQUEST_BYTES = SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 128 * 1024;
export const SESSION_ATTACHMENT_LIMIT_PER_SESSION = 100;
export const SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION = 500 * 1024 * 1024;
// Attachments never referenced by a message after this long are pruned (R2
// object + record) the next time the session records an attachment.
export const SESSION_ATTACHMENT_UNREFERENCED_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS = 5 * 60 * 1000;

const SCREENSHOT_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

const VIDEO_EXTENSIONS = {
  "video/mp4": "mp4",
} as const;

export type SupportedScreenshotMimeType = keyof typeof SCREENSHOT_EXTENSIONS;
export type SupportedVideoMimeType = keyof typeof VIDEO_EXTENSIONS;

export interface ScreenshotFileType {
  mimeType: SupportedScreenshotMimeType;
  extension: (typeof SCREENSHOT_EXTENSIONS)[SupportedScreenshotMimeType];
}

export interface VideoFileType {
  mimeType: SupportedVideoMimeType;
  extension: (typeof VIDEO_EXTENSIONS)[SupportedVideoMimeType];
}

export interface MultipartFileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MultipartFieldValue = string | MultipartFileLike;
export type VideoUploadMetadata = Omit<
  VideoArtifactMetadata,
  "objectKey" | "mimeType" | "sizeBytes"
>;

export interface MultipartFieldsLike {
  get(name: string): MultipartFieldValue | null;
}

export function isSupportedScreenshotMimeType(value: string): value is SupportedScreenshotMimeType {
  return value in SCREENSHOT_EXTENSIONS;
}

export function isSupportedVideoMimeType(value: string): value is SupportedVideoMimeType {
  return value in VIDEO_EXTENSIONS;
}

export function detectScreenshotFileType(bytes: Uint8Array): ScreenshotFileType | null {
  if (bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: "png" };
  }

  if (bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  if (
    bytes.length >= 12 &&
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasPrefix(bytes.slice(8, 12), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }

  return null;
}

export function detectVideoFileType(bytes: Uint8Array): VideoFileType | null {
  if (
    bytes.length >= 12 &&
    hasPrefix(bytes.slice(4, 8), [0x66, 0x74, 0x79, 0x70]) &&
    isMp4CompatibleBrand(bytes.slice(8, 12))
  ) {
    return { mimeType: "video/mp4", extension: "mp4" };
  }

  return null;
}

/** A page upload is UTF-8 text; anything binary (or carrying NUL bytes) is refused. */
export function isPageFile(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export type SessionAttachmentFileType = {
  mimeType: SessionAttachmentMimeType;
  extension: string;
};

const SESSION_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set(
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES
);

export function isSupportedSessionAttachmentMimeType(
  value: string
): value is SessionAttachmentMimeType {
  return SESSION_ATTACHMENT_MIME_TYPES.has(value);
}

export function sessionAttachmentRequestExceedsLimit(request: Request): boolean {
  const raw = request.headers.get("Content-Length");
  if (!raw || !/^\d+$/.test(raw)) return false;
  return Number(raw) > SESSION_ATTACHMENT_MAX_REQUEST_BYTES;
}

/**
 * Detect user-attached prompt images by magic bytes. This is intentionally
 * separate from the agent screenshot/recording detectors: session attachments do
 * not support videos in the initial attachment release.
 */
export function detectSessionAttachmentFileType(
  bytes: Uint8Array
): SessionAttachmentFileType | null {
  const image = detectScreenshotFileType(bytes);
  if (image) {
    return { mimeType: image.mimeType, extension: image.extension };
  }

  // GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mimeType: "image/gif", extension: "gif" };
  }

  return null;
}

export function buildSessionAttachmentObjectKey(sessionId: string, attachmentId: string): string {
  return `sessions/${sessionId}/attachments/${attachmentId}`;
}

export function buildMediaObjectKey(
  sessionId: string,
  artifactId: string,
  extension: string
): string {
  return `sessions/${sessionId}/media/${artifactId}.${extension}`;
}

export function isMultipartFile(value: MultipartFieldValue | null): value is MultipartFileLike {
  return (
    value !== null &&
    typeof value !== "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number" &&
    typeof value.type === "string"
  );
}

export function parseOptionalBoolean(value: MultipartFieldValue | null): boolean | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Boolean fields must be strings");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("Boolean fields must be 'true' or 'false'");
}

type Dimensions = { width: number; height: number };
type DimensionsMode = "integer" | "round";

export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: true; mode: DimensionsMode }
): Dimensions;
export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: false; mode: DimensionsMode }
): Dimensions | undefined;
export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: boolean; mode: DimensionsMode }
): Dimensions | undefined {
  if (value === null) {
    if (opts.required) throw new Error(`${opts.name} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${opts.name} must be a JSON string`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${opts.name} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${opts.name} must be an object`);
  }

  const candidate = parsed as { width?: unknown; height?: unknown };
  const width = coerceDimension(candidate.width, opts.mode);
  const height = coerceDimension(candidate.height, opts.mode);
  if (width === null || height === null) {
    const detail =
      opts.mode === "integer" ? "positive integer width and height" : "positive width and height";
    throw new Error(`${opts.name} must include ${detail}`);
  }

  return { width, height };
}

function coerceDimension(value: unknown, mode: DimensionsMode): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (mode === "integer") return Number.isInteger(value) ? value : null;
  // Reject values that round to 0 — Math.round(0.4) === 0 would silently produce a zero dimension.
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

export function parseVideoUploadMetadata(
  fields: MultipartFieldsLike,
  createdAt = Date.now()
): VideoUploadMetadata {
  const caption = parseRequiredString(fields.get("caption"), "caption");
  const durationMs = parsePositiveInteger(fields.get("durationMs"), {
    name: "durationMs",
    max: VIDEO_MAX_DURATION_MS,
  });
  const recordingStartedAt = parsePositiveInteger(fields.get("recordingStartedAt"), {
    name: "recordingStartedAt",
  });
  const recordingEndedAt = parsePositiveInteger(fields.get("recordingEndedAt"), {
    name: "recordingEndedAt",
  });
  if (recordingEndedAt < recordingStartedAt) {
    throw new Error("recordingEndedAt must be greater than or equal to recordingStartedAt");
  }
  const elapsedMs = recordingEndedAt - recordingStartedAt;
  if (elapsedMs > VIDEO_MAX_DURATION_MS + VIDEO_TIMESTAMP_TOLERANCE_MS) {
    throw new Error(`recording timestamps must span ${VIDEO_MAX_DURATION_MS}ms or less`);
  }
  if (durationMs > elapsedMs + VIDEO_TIMESTAMP_TOLERANCE_MS) {
    throw new Error("durationMs must not exceed the recording timestamp span");
  }

  const dimensions = parseDimensions(fields.get("dimensions"), {
    name: "dimensions",
    required: true,
    mode: "integer",
  });
  const truncated = parseRequiredBoolean(fields.get("truncated"), "truncated");
  const sourceUrl = parseOptionalUrl(fields.get("sourceUrl"), "sourceUrl");
  const endUrl = parseOptionalUrl(fields.get("endUrl"), "endUrl");
  const hasAudio = parseOptionalBoolean(fields.get("hasAudio"));

  return {
    caption,
    durationMs,
    createdAt,
    recordingStartedAt,
    recordingEndedAt,
    dimensions,
    truncated,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(endUrl ? { endUrl } : {}),
    ...(hasAudio === undefined ? {} : { hasAudio }),
    captureSurface: "browser",
    source: "agent",
  };
}

export function buildFileObjectKey(
  sessionId: string,
  artifactId: string,
  filename: string
): string {
  const extension = fileExtension(filename);
  return `sessions/${sessionId}/files/${artifactId}${extension ? `.${extension}` : ""}`;
}

const FILENAME_MAX_LENGTH = 180;

/**
 * The name a file downloads under: the last path segment, without control characters, path
 * separators or characters filesystems refuse, and at most FILENAME_MAX_LENGTH characters with
 * its extension kept. Returns null when nothing usable is left.
 */
export function sanitizeFilename(value: string): string | null {
  const base = value.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  name = name.replace(/^\.+/, "").trim();
  if (!name) return null;
  if (name.length > FILENAME_MAX_LENGTH) {
    const extension = fileExtension(name);
    const keep = FILENAME_MAX_LENGTH - (extension ? extension.length + 1 : 0);
    name = extension ? `${name.slice(0, keep)}.${extension}` : name.slice(0, FILENAME_MAX_LENGTH);
  }
  return name;
}

/** The lowercase extension when it is a short alphanumeric one (`fcpxml`, `mov`), else "". */
export function fileExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/**
 * `Content-Disposition` that always downloads, under the original name: an ASCII `filename` for
 * old clients and the exact UTF-8 name in `filename*` (RFC 6266 / RFC 8187).
 */
export function attachmentContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A declared content type when it is a plain `type/subtype`, else the generic binary type. */
export function normalizeFileContentType(value: unknown): string {
  if (typeof value !== "string") return FILE_FALLBACK_CONTENT_TYPE;
  const mime = value.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : FILE_FALLBACK_CONTENT_TYPE;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isMp4CompatibleBrand(brand: Uint8Array): boolean {
  if (brand.length < 4) return false;
  const value = String.fromCharCode(...brand);
  return (
    value === "isom" ||
    value === "iso2" ||
    value === "mp41" ||
    value === "mp42" ||
    value === "avc1" ||
    value === "M4V "
  );
}

function parseRequiredString(value: MultipartFieldValue | null, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

// Strict integer-only parsing — rejects decimals, exponents, and unsafe sizes.
function parsePositiveInteger(
  value: MultipartFieldValue | null,
  opts: { name: string; max?: number }
): number {
  const text = parseRequiredString(value, opts.name);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${opts.name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${opts.name} must be a safe integer`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`${opts.name} must be ${opts.max} or less`);
  }
  return parsed;
}

function parseRequiredBoolean(value: MultipartFieldValue | null, name: string): boolean {
  const parsed = parseOptionalBoolean(value);
  if (parsed === undefined) {
    throw new Error(`${name} is required`);
  }
  return parsed;
}

function parseOptionalUrl(value: MultipartFieldValue | null, name: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  return trimmed;
}
