import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { userFilesQuotaBytes } from "../routes/files";
import type { LargeObjectTransfers, UploadedPart } from "../storage/large-object-transfers";
import type { ObjectStorage } from "../storage/object-storage";
import {
  DEFAULT_USER_FILES_QUOTA_BYTES,
  USER_FILE_UPLOAD_RESUME_WINDOW_MS,
  UserFileError,
  UserFileService,
} from "./service";
import { UserFileStore } from "./store";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/d1/migrations"
);
const OWNER = "owner-1";
const MIB = 1024 * 1024;

function fakeTransfers(sandboxDirect: boolean) {
  const parts = new Map<string, UploadedPart[]>();
  const transfers = {
    sandboxDirect,
    createMultipartUpload: vi.fn(async (key: string) => {
      parts.set(`up:${key}`, []);
      return `up:${key}`;
    }),
    signUploadPart: vi.fn(async (_key: string, uploadId: string, partNumber: number) => {
      return `https://store/${uploadId}/${partNumber}`;
    }),
    uploadPart: vi.fn(
      async (_key: string, uploadId: string, partNumber: number, body: Uint8Array) => {
        parts.get(uploadId)!.push({ partNumber, sizeBytes: body.byteLength, etag: "e" });
      }
    ),
    listParts: vi.fn(async (_key: string, uploadId: string) => parts.get(uploadId) ?? []),
    completeMultipartUpload: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
    signDownload: vi.fn(async (key: string) => `https://store/${key}`),
  } satisfies LargeObjectTransfers;
  return { transfers, parts };
}

describe("UserFileService", () => {
  let dir: string;
  let db: NodeSqlDatabase;
  let now: number;
  let ids: number;
  const objects = { delete: vi.fn(async () => undefined) } as unknown as ObjectStorage;

  function service(transfers: LargeObjectTransfers | undefined, quotaBytes = 10 * 1024 * MIB) {
    return new UserFileService({
      store: new UserFileStore(db),
      objects,
      transfers,
      quotaBytes,
      log: createLogger("test"),
      now: () => now,
      generateId: () => `file-${++ids}`,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "user-files-"));
    db = openNodeSqlDatabase(join(dir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    await db
      .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 0, 0)")
      .bind(OWNER)
      .run();
    now = 1_000_000_000;
    ids = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs browser parts directly even where sandboxes must relay", async () => {
    const { transfers } = fakeTransfers(false);
    const files = service(transfers);
    const { file } = await files.createUpload(OWNER, {
      name: "a.mov",
      sizeBytes: 40 * MIB,
      scope: "library",
    });
    const browser = await files.signParts({ kind: "user", userId: OWNER }, file.id, [1, 2, 3]);
    expect(browser.transfer).toBe("direct");
    expect(browser.parts.map((part) => part.url)).toEqual([
      `https://store/up:users/${OWNER}/files/${file.id}/1`,
      `https://store/up:users/${OWNER}/files/${file.id}/2`,
      `https://store/up:users/${OWNER}/files/${file.id}/3`,
    ]);
    const sandbox = await files.signParts(
      { kind: "sandbox", sessionId: "s", ownerUserId: OWNER },
      file.id,
      [1]
    );
    expect(sandbox).toMatchObject({ transfer: "relay", parts: [{ partNumber: 1, url: null }] });
    await expect(
      files.signParts({ kind: "user", userId: OWNER }, file.id, [4])
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("completes only when every part the size calls for is held", async () => {
    const { transfers } = fakeTransfers(true);
    const files = service(transfers);
    const caller = { kind: "user", userId: OWNER } as const;
    const { file } = await files.createUpload(OWNER, {
      name: "b.wav",
      sizeBytes: 16 * MIB + 3,
      scope: "input",
    });
    await files.relayPart(caller, file.id, 2, new Uint8Array(3));
    await expect(files.complete(caller, file.id)).rejects.toMatchObject({
      reason: "incomplete",
      status: 409,
    });
    await files.relayPart(caller, file.id, 1, new Uint8Array(16 * MIB));
    const done = await files.complete(caller, file.id);
    expect(done).toMatchObject({ status: "ready", kind: "audio" });
    expect(transfers.completeMultipartUpload).toHaveBeenCalledTimes(1);
    // A retried completion after a lost response is not an error.
    expect(await files.complete(caller, file.id)).toMatchObject({ status: "ready" });
    expect(transfers.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("counts open uploads against the quota", async () => {
    const files = service(fakeTransfers(true).transfers, 50 * MIB);
    await files.createUpload(OWNER, { name: "a.mov", sizeBytes: 30 * MIB, scope: "library" });
    await expect(
      files.createUpload(OWNER, { name: "b.mov", sizeBytes: 30 * MIB, scope: "library" })
    ).rejects.toBeInstanceOf(UserFileError);
    // The same file again resumes rather than counting twice.
    const again = await files.createUpload(OWNER, {
      name: "a.mov",
      sizeBytes: 30 * MIB,
      scope: "library",
    });
    expect(again.file.id).toBe("file-1");
  });

  it("drops abandoned uploads and never-sent inputs once the resume window has passed", async () => {
    const { transfers } = fakeTransfers(true);
    const files = service(transfers);
    await files.createUpload(OWNER, { name: "old.mov", sizeBytes: 10, scope: "library" });
    now += USER_FILE_UPLOAD_RESUME_WINDOW_MS + 1;
    await files.createUpload(OWNER, { name: "new.mov", sizeBytes: 10, scope: "library" });
    expect(transfers.abortMultipartUpload).toHaveBeenCalledWith(
      `users/${OWNER}/files/file-1`,
      `up:users/${OWNER}/files/file-1`
    );
    const { files: left } = await files.list(OWNER, "library");
    expect(left.map((file) => file.name)).toEqual(["new.mov"]);
  });

  it("answers unavailable without a store that presigns", async () => {
    await expect(
      service(undefined).createUpload(OWNER, { name: "a", sizeBytes: 1, scope: "library" })
    ).rejects.toMatchObject({ status: 501 });
  });
});

describe("userFilesQuotaBytes", () => {
  it("reads USER_FILES_QUOTA_GB and falls back to the default", () => {
    expect(userFilesQuotaBytes({ USER_FILES_QUOTA_GB: "2" })).toBe(2 * 1024 * MIB);
    expect(userFilesQuotaBytes({ USER_FILES_QUOTA_GB: "" })).toBe(DEFAULT_USER_FILES_QUOTA_BYTES);
    expect(userFilesQuotaBytes({ USER_FILES_QUOTA_GB: "-1" })).toBe(DEFAULT_USER_FILES_QUOTA_BYTES);
  });
});
