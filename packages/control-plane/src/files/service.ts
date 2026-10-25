/**
 * User files: uploads, the library and session inputs, over `UserFileStore` rows and
 * `LargeObjectTransfers` objects.
 *
 * An upload is created once and resumed by asking again: creating an upload
 * whose owner, scope, name and size match an unfinished one returns that one
 * with the parts the store already holds, so a client that lost its
 * connection, or its tab, sends only the parts that are missing. Completion
 * asks the store which parts it holds rather than trusting the client's list,
 * so a browser never has to read part ETags (which needs CORS to expose them).
 */

import {
  USER_FILE_PART_BYTES,
  inferUserFileKind,
  type CreateUserFileUploadRequest,
  type UserFileDownloadResponse,
  type UserFile,
  type UserFileUsage,
  type UserFileScope,
  type SandboxUserFile,
  type SandboxUserFileIndex,
  type UserFileUploadPlan,
  type UserFileUploadResponse,
  type SignUserFileUploadPartsResponse,
  type UpdateUserFileRequest,
} from "@open-inspect/shared/types/user-files";
import type { Logger } from "../logger";
import type { LargeObjectTransfers } from "../storage/large-object-transfers";
import type { ObjectStorage } from "../storage/object-storage";
import type { UserFileStore } from "./store";
import { toUserFile, type UserFilePatch, type UserFileRow } from "./store";

/** How long a signed part URL lasts: long enough for a slow link to send one part. */
export const USER_FILE_UPLOAD_PART_URL_TTL_MS = 60 * 60 * 1000;
/** How long a signed download URL lasts. A started download outlives it. */
export const USER_FILE_DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;
/** An unfinished upload can be resumed this long after its last activity. */
export const USER_FILE_UPLOAD_RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Default bytes one user may keep (library and inputs together). */
export const DEFAULT_USER_FILES_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;

export type UserFileErrorReason =
  | "not_found"
  | "quota_exceeded"
  | "incomplete"
  | "invalid"
  | "unavailable";

const STATUS_BY_REASON: Record<UserFileErrorReason, number> = {
  not_found: 404,
  quota_exceeded: 413,
  incomplete: 409,
  invalid: 400,
  unavailable: 501,
};

export class UserFileError extends Error {
  readonly status: number;
  constructor(
    readonly reason: UserFileErrorReason,
    message: string
  ) {
    super(message);
    this.name = "UserFileError";
    this.status = STATUS_BY_REASON[reason];
  }
}

/** Who is asking: a person (for their own files) or a session's sandbox. */
export type UserFileCaller =
  | { kind: "user"; userId: string }
  | { kind: "sandbox"; sessionId: string; ownerUserId: string };

export interface UserFileServiceDeps {
  store: UserFileStore;
  objects: ObjectStorage;
  transfers: LargeObjectTransfers | undefined;
  quotaBytes: number;
  log: Logger;
  now?: () => number;
  generateId: () => string;
}

export function buildUserFileObjectKey(ownerUserId: string, fileId: string): string {
  return `users/${ownerUserId}/files/${fileId}`;
}

export class UserFileService {
  private readonly store: UserFileStore;
  private readonly now: () => number;

  constructor(private readonly deps: UserFileServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  private requireTransfers(): LargeObjectTransfers {
    if (!this.deps.transfers) {
      throw new UserFileError("unavailable", "File uploads are not available on this deployment");
    }
    return this.deps.transfers;
  }

  async createUpload(
    ownerUserId: string,
    request: CreateUserFileUploadRequest & { name: string }
  ): Promise<UserFileUploadResponse> {
    const transfers = this.requireTransfers();
    const now = this.now();
    await this.pruneStale(ownerUserId, now);

    const resumable = await this.store.findResumable(
      ownerUserId,
      request.scope,
      request.name,
      request.sizeBytes,
      now - USER_FILE_UPLOAD_RESUME_WINDOW_MS
    );
    if (resumable?.upload_id) {
      await this.store.touch(resumable.id, now);
      return {
        file: toUserFile({ ...resumable, updated_at: now }),
        upload: await this.plan(resumable),
      };
    }

    const used = await this.store.usedBytes(ownerUserId);
    if (used + request.sizeBytes > this.deps.quotaBytes) {
      throw new UserFileError("quota_exceeded", "There is no room left for this file");
    }

    const id = this.deps.generateId();
    const objectKey = buildUserFileObjectKey(ownerUserId, id);
    const mimeType = request.mimeType || null;
    const uploadId = await transfers.createMultipartUpload(objectKey, mimeType ?? undefined);
    const row: UserFileRow = {
      id,
      owner_user_id: ownerUserId,
      scope: request.scope,
      session_id: null,
      name: request.name,
      kind: request.kind ?? inferUserFileKind(request.name, mimeType),
      mime_type: mimeType,
      size_bytes: request.sizeBytes,
      object_key: objectKey,
      status: "uploading",
      upload_id: uploadId,
      part_size_bytes: USER_FILE_PART_BYTES,
      attached_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.store.insert(row);
    this.deps.log.info("user_files.upload_created", {
      event: "user_files.upload_created",
      file_id: id,
      scope: row.scope,
      kind: row.kind,
      size_bytes: row.size_bytes,
    });
    return {
      file: toUserFile(row),
      upload: {
        partSizeBytes: row.part_size_bytes,
        partCount: partCountOf(row),
        uploadedParts: [],
      },
    };
  }

  async uploadStatus(ownerUserId: string, fileId: string): Promise<UserFileUploadResponse> {
    const row = await this.requireUploading(ownerUserId, fileId);
    return { file: toUserFile(row), upload: await this.plan(row) };
  }

  /**
   * Signed URLs for the named parts. A sandbox that cannot reach the store
   * gets `relay` instead and PUTs each part to the control plane.
   */
  async signParts(
    caller: UserFileCaller,
    fileId: string,
    partNumbers: readonly number[]
  ): Promise<SignUserFileUploadPartsResponse> {
    const transfers = this.requireTransfers();
    const row = await this.requireUploading(ownerOf(caller), fileId);
    const partCount = partCountOf(row);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new UserFileError("invalid", `This file has ${partCount} parts`);
    }
    const now = this.now();
    await this.store.touch(row.id, now);
    const expiresAt = now + USER_FILE_UPLOAD_PART_URL_TTL_MS;
    if (caller.kind === "sandbox" && !transfers.sandboxDirect) {
      return {
        transfer: "relay",
        parts: partNumbers.map((partNumber) => ({ partNumber, url: null })),
        expiresAt,
      };
    }
    const uploadId = row.upload_id!;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await transfers.signUploadPart(
          row.object_key,
          uploadId,
          partNumber,
          USER_FILE_UPLOAD_PART_URL_TTL_MS
        ),
      }))
    );
    return { transfer: "direct", parts, expiresAt };
  }

  /** Store one part sent through the control plane (sandboxes without direct access). */
  async relayPart(
    caller: UserFileCaller,
    fileId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<void> {
    const transfers = this.requireTransfers();
    const row = await this.requireUploading(ownerOf(caller), fileId);
    const partCount = partCountOf(row);
    if (partNumber < 1 || partNumber > partCount) {
      throw new UserFileError("invalid", `This file has ${partCount} parts`);
    }
    if (body.byteLength !== expectedPartBytes(row, partNumber)) {
      throw new UserFileError("invalid", `Part ${partNumber} has the wrong size`);
    }
    await transfers.uploadPart(row.object_key, row.upload_id!, partNumber, body);
    await this.store.touch(row.id, this.now());
  }

  async complete(caller: UserFileCaller, fileId: string): Promise<UserFile> {
    const transfers = this.requireTransfers();
    const owner = ownerOf(caller);
    const existing = await this.store.getOwned(fileId, owner);
    if (!existing) throw new UserFileError("not_found", "File not found");
    // Completing twice is a client retry after a lost response, not an error.
    if (existing.status === "ready") return toUserFile(existing);
    const row = await this.requireUploading(owner, fileId);

    const parts = await transfers.listParts(row.object_key, row.upload_id!);
    const partCount = partCountOf(row);
    const held = new Map(parts.map((part) => [part.partNumber, part] as const));
    const missing: number[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const part = held.get(partNumber);
      if (!part || part.sizeBytes !== expectedPartBytes(row, partNumber)) missing.push(partNumber);
    }
    if (missing.length > 0) {
      throw new UserFileError(
        "incomplete",
        `Parts ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""} are missing`
      );
    }
    await transfers.completeMultipartUpload(
      row.object_key,
      row.upload_id!,
      parts.filter((part) => part.partNumber <= partCount)
    );
    const now = this.now();
    await this.store.markReady(row.id, now);
    this.deps.log.info("user_files.upload_completed", {
      event: "user_files.upload_completed",
      file_id: row.id,
      scope: row.scope,
      size_bytes: row.size_bytes,
      via: caller.kind,
    });
    return toUserFile({ ...row, status: "ready", upload_id: null, updated_at: now });
  }

  async list(
    ownerUserId: string,
    scope: UserFileScope
  ): Promise<{ files: UserFile[]; usage: UserFileUsage }> {
    const [rows, used] = await Promise.all([
      this.store.listOwned(ownerUserId, scope),
      this.store.usage(ownerUserId, scope),
    ]);
    return {
      files: rows.map(toUserFile),
      usage: { usedBytes: used.total, scopeBytes: used.scoped, limitBytes: this.deps.quotaBytes },
    };
  }

  async update(
    ownerUserId: string,
    fileId: string,
    request: UpdateUserFileRequest & { name?: string }
  ): Promise<UserFile> {
    const row = await this.store.getOwned(fileId, ownerUserId);
    if (!row) throw new UserFileError("not_found", "File not found");
    const patch: UserFilePatch = {};
    if (request.name !== undefined) patch.name = request.name;
    if (request.kind !== undefined) patch.kind = request.kind;
    const now = this.now();
    await this.store.update(row.id, ownerUserId, patch, now);
    return toUserFile({ ...row, ...patch, updated_at: now });
  }

  async delete(ownerUserId: string, fileId: string): Promise<void> {
    const row = await this.store.getOwned(fileId, ownerUserId);
    if (!row) throw new UserFileError("not_found", "File not found");
    await this.discard(row);
  }

  /**
   * Attach the caller's finished inputs to a session, ahead of the message
   * that carries them, so the sandbox holds them before that turn starts.
   */
  async attachInputs(
    ownerUserId: string,
    sessionId: string,
    fileIds: readonly string[]
  ): Promise<UserFile[]> {
    const unique = [...new Set(fileIds)];
    const attached = await this.store.attachInputs(unique, ownerUserId, sessionId, this.now());
    if (attached !== unique.length) {
      throw new UserFileError("invalid", "Some files are still uploading or no longer exist");
    }
    const inputs = await this.store.listSessionInputs(sessionId);
    return inputs.filter((row) => unique.includes(row.id)).map(toUserFile);
  }

  async listSessionInputs(sessionId: string): Promise<UserFile[]> {
    return (await this.store.listSessionInputs(sessionId)).map(toUserFile);
  }

  /** What the sandbox may read: the session's inputs and the owner's library. */
  async sandboxIndex(sessionId: string, ownerUserId: string): Promise<SandboxUserFileIndex> {
    const [inputs, library] = await Promise.all([
      this.store.listSessionInputs(sessionId),
      this.store.listLibrary(ownerUserId),
    ]);
    return { inputs: inputs.map(toSandboxFile), library: library.map(toSandboxFile) };
  }

  /** Where a sandbox reads a file from: a signed URL, or the relay route. */
  async sandboxDownload(
    sessionId: string,
    ownerUserId: string,
    fileId: string
  ): Promise<UserFileDownloadResponse & { row: UserFileRow }> {
    const row = await this.store.getForSession(fileId, sessionId, ownerUserId);
    if (!row) throw new UserFileError("not_found", "File not found");
    const expiresAt = this.now() + USER_FILE_DOWNLOAD_URL_TTL_MS;
    const transfers = this.deps.transfers;
    if (!transfers?.sandboxDirect) {
      return { transfer: "relay", url: null, sizeBytes: row.size_bytes, expiresAt, row };
    }
    const url = await transfers.signDownload(row.object_key, {
      expiresInMs: USER_FILE_DOWNLOAD_URL_TTL_MS,
    });
    return { transfer: "direct", url, sizeBytes: row.size_bytes, expiresAt, row };
  }

  async getReadableRow(caller: UserFileCaller, fileId: string): Promise<UserFileRow> {
    const row =
      caller.kind === "user"
        ? await this.store.getOwned(fileId, caller.userId)
        : await this.store.getForSession(fileId, caller.sessionId, caller.ownerUserId);
    if (!row || row.status !== "ready") throw new UserFileError("not_found", "File not found");
    return row;
  }

  /** A signed URL the owner's browser can view or save the file from, or null without one. */
  async signForOwner(row: UserFileRow, download: boolean): Promise<string | null> {
    if (!this.deps.transfers) return null;
    return this.deps.transfers.signDownload(row.object_key, {
      expiresInMs: USER_FILE_DOWNLOAD_URL_TTL_MS,
      downloadName: download ? row.name : undefined,
      contentType: row.mime_type ?? undefined,
    });
  }

  private async requireUploading(ownerUserId: string, fileId: string): Promise<UserFileRow> {
    const row = await this.store.getOwned(fileId, ownerUserId);
    if (!row) throw new UserFileError("not_found", "File not found");
    if (row.status !== "uploading" || !row.upload_id) {
      throw new UserFileError("invalid", "This file has already been uploaded");
    }
    return row;
  }

  private async plan(row: UserFileRow): Promise<UserFileUploadPlan> {
    const transfers = this.requireTransfers();
    const parts = await transfers.listParts(row.object_key, row.upload_id!);
    return {
      partSizeBytes: row.part_size_bytes,
      partCount: partCountOf(row),
      uploadedParts: parts
        .filter((part) => part.sizeBytes === expectedPartBytes(row, part.partNumber))
        .map((part) => part.partNumber),
    };
  }

  private async discard(row: UserFileRow): Promise<void> {
    if (row.status === "uploading" && row.upload_id) {
      await this.requireTransfers().abortMultipartUpload(row.object_key, row.upload_id);
    } else {
      await this.deps.objects.delete(row.object_key);
    }
    await this.store.delete(row.id);
  }

  /** Drop the owner's abandoned uploads and never-sent inputs; best effort. */
  private async pruneStale(ownerUserId: string, now: number): Promise<void> {
    let stale: UserFileRow[];
    try {
      stale = await this.store.listStale(ownerUserId, now - USER_FILE_UPLOAD_RESUME_WINDOW_MS);
    } catch {
      return;
    }
    for (const row of stale) {
      try {
        await this.discard(row);
      } catch (error) {
        this.deps.log.warn("user_files.prune_failed", {
          event: "user_files.prune_failed",
          file_id: row.id,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
  }
}

function ownerOf(caller: UserFileCaller): string {
  return caller.kind === "user" ? caller.userId : caller.ownerUserId;
}

function partCountOf(row: UserFileRow): number {
  return Math.max(1, Math.ceil(row.size_bytes / row.part_size_bytes));
}

function expectedPartBytes(row: UserFileRow, partNumber: number): number {
  const partCount = partCountOf(row);
  if (partNumber < partCount) return row.part_size_bytes;
  return row.size_bytes - row.part_size_bytes * (partCount - 1);
}

function toSandboxFile(row: UserFileRow): SandboxUserFile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at,
  };
}
