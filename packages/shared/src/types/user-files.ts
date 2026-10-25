/**
 * User files: what a user brings into a session (inputs) and keeps across sessions (their
 * library).
 *
 * Bytes never pass through the control plane on the browser path: an upload
 * is an object-store multipart upload whose part URLs the control plane
 * presigns, and the browser PUTs each part straight to the store. The control
 * plane only creates, signs, lists and completes. Sandboxes read the same
 * objects through short-lived signed URLs (or, where the store is not reachable
 * from a sandbox, through the control plane).
 */

import { z } from "zod";

/** What a file is for, as the user tags it. One tag per file. */
export const USER_FILE_KINDS = ["video", "audio", "image", "font", "lut", "logo", "other"] as const;
export const userFileKindSchema = z.enum(USER_FILE_KINDS);
export type UserFileKind = z.infer<typeof userFileKindSchema>;

/**
 * `library`: kept across sessions in the owner's library. `input`: brought into
 * one session; unattached until the message that carries it is sent.
 */
export const USER_FILE_SCOPES = ["library", "input"] as const;
export const userFileScopeSchema = z.enum(USER_FILE_SCOPES);
export type UserFileScope = z.infer<typeof userFileScopeSchema>;

export const USER_FILE_STATUSES = ["uploading", "ready"] as const;
export const userFileStatusSchema = z.enum(USER_FILE_STATUSES);
export type UserFileStatus = z.infer<typeof userFileStatusSchema>;

/** Largest single file. Multipart uploads go well past this; it bounds a sandbox download. */
export const USER_FILE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** Each part a client PUTs. 320 parts for the largest file; one retry costs at most this. */
export const USER_FILE_PART_BYTES = 16 * 1024 * 1024;
/** Part URLs one sign request may ask for. */
export const USER_FILE_MAX_SIGNED_PARTS = 100;
/** Files one message may bring into a session. */
export const USER_FILES_MAX_PER_MESSAGE = 20;
export const USER_FILE_NAME_MAX_CHARS = 200;

export const userFileIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/);

/** How many parts a file of `sizeBytes` is uploaded in. */
export function userFilePartCount(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / USER_FILE_PART_BYTES));
}

/**
 * A file name that is safe as one path segment under /workspace: no
 * separators, control characters or leading dots, at most
 * USER_FILE_NAME_MAX_CHARS characters, the extension kept when shortening.
 * Returns "" when nothing usable is left.
 */
export function sanitizeUserFileName(raw: string): string {
  let name = raw
    .normalize("NFC")
    .replace(/[\\/]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (name.length > USER_FILE_NAME_MAX_CHARS) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, USER_FILE_NAME_MAX_CHARS - extension.length).trimEnd() + extension;
  }
  return name;
}

const KIND_BY_EXTENSION: Readonly<Record<string, UserFileKind>> = {
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mxf: "video",
  mts: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  opus: "audio",
  aif: "audio",
  aiff: "audio",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  tif: "image",
  tiff: "image",
  bmp: "image",
  psd: "image",
  svg: "image",
  ttf: "font",
  otf: "font",
  ttc: "font",
  woff: "font",
  woff2: "font",
  cube: "lut",
  "3dl": "lut",
};

export function userFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The kind a new file starts with, from its name and type; the user can retag it. */
export function inferUserFileKind(name: string, mimeType?: string | null): UserFileKind {
  const fromExtension = KIND_BY_EXTENSION[userFileExtension(name)];
  const kind =
    fromExtension ??
    (mimeType?.startsWith("video/")
      ? "video"
      : mimeType?.startsWith("audio/")
        ? "audio"
        : mimeType?.startsWith("image/")
          ? "image"
          : mimeType?.startsWith("font/")
            ? "font"
            : "other");
  if (kind === "image" && /logo/i.test(name)) return "logo";
  return kind;
}

const fileNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .transform(sanitizeUserFileName)
  .refine((name) => name.length > 0, { message: "Name is empty" });

export const userFileSchema = z.object({
  id: userFileIdSchema,
  name: z.string(),
  kind: userFileKindSchema,
  scope: userFileScopeSchema,
  status: userFileStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  sessionId: z.string().nullable(),
  attachedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type UserFile = z.infer<typeof userFileSchema>;

export const createUserFileUploadRequestSchema = z.strictObject({
  name: fileNameSchema,
  sizeBytes: z.number().int().positive().max(USER_FILE_MAX_BYTES),
  mimeType: z.string().max(255).optional(),
  scope: userFileScopeSchema,
  kind: userFileKindSchema.optional(),
});
export type CreateUserFileUploadRequest = z.input<typeof createUserFileUploadRequestSchema>;

export const userFileUploadPlanSchema = z.object({
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  /** Parts the store already holds; a resumed upload skips them. */
  uploadedParts: z.array(z.number().int().positive()),
});
export type UserFileUploadPlan = z.infer<typeof userFileUploadPlanSchema>;

export const userFileUploadResponseSchema = z.object({
  file: userFileSchema,
  upload: userFileUploadPlanSchema,
});
export type UserFileUploadResponse = z.infer<typeof userFileUploadResponseSchema>;

export const signUserFileUploadPartsRequestSchema = z.strictObject({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(USER_FILE_MAX_SIGNED_PARTS),
});

/**
 * `direct`: PUT the part to `url` as is (no extra headers). `relay`: the store
 * is not reachable from the caller; PUT the part to the control plane's part
 * route with the caller's own credentials.
 */
export const userFileTransferModeSchema = z.enum(["direct", "relay"]);
export type UserFileTransferMode = z.infer<typeof userFileTransferModeSchema>;

export const signUserFileUploadPartsResponseSchema = z.object({
  transfer: userFileTransferModeSchema,
  parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string().nullable() })),
  expiresAt: z.number(),
});
export type SignUserFileUploadPartsResponse = z.infer<typeof signUserFileUploadPartsResponseSchema>;

export const userFileResponseSchema = z.object({ file: userFileSchema });

/**
 * `usedBytes` is everything the owner stores, which the quota (`limitBytes`)
 * counts: library files and the files sent with messages. `scopeBytes` is the
 * listed scope's share, which is what a page of that list shows.
 */
export const userFileUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  // Optional so a page newer than its control plane still loads.
  scopeBytes: z.number().int().nonnegative().optional(),
  limitBytes: z.number().int().positive(),
});
export type UserFileUsage = z.infer<typeof userFileUsageSchema>;

export const userFileListResponseSchema = z.object({
  files: z.array(userFileSchema),
  usage: userFileUsageSchema,
});
export type UserFileListResponse = z.infer<typeof userFileListResponseSchema>;

export const updateUserFileRequestSchema = z
  .strictObject({
    name: fileNameSchema.optional(),
    kind: userFileKindSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdateUserFileRequest = z.input<typeof updateUserFileRequestSchema>;

export const attachSessionInputsRequestSchema = z.strictObject({
  fileIds: z.array(userFileIdSchema).min(1).max(USER_FILES_MAX_PER_MESSAGE),
});

/** One file as a sandbox sees it. */
export const sandboxUserFileSchema = z.object({
  id: userFileIdSchema,
  name: z.string(),
  kind: userFileKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  attachedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export type SandboxUserFile = z.infer<typeof sandboxUserFileSchema>;

/** `GET /sessions/:id/files`: everything a session's sandbox may read. */
export const sandboxUserFileIndexSchema = z.object({
  inputs: z.array(sandboxUserFileSchema),
  library: z.array(sandboxUserFileSchema),
});
export type SandboxUserFileIndex = z.infer<typeof sandboxUserFileIndexSchema>;

export const userFileDownloadResponseSchema = z.object({
  transfer: userFileTransferModeSchema,
  /** The signed URL for `direct`; null for `relay` (read the content route instead). */
  url: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  expiresAt: z.number(),
});
export type UserFileDownloadResponse = z.infer<typeof userFileDownloadResponseSchema>;
