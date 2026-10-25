/**
 * Test doubles for the media store and its direct transfers, sharing one
 * in-memory bucket: a multipart upload completes into an object the
 * ObjectStorage side can read, as it does on S3.
 */

import type {
  DirectObjectTransfer,
  DirectUploadPart,
  StoredObjectSummary,
} from "./direct-transfer";
import type { ObjectStorage, ObjectStorageMetadata } from "./object-storage";

export interface MemoryObject {
  bytes: Uint8Array;
  contentType?: string;
  lastModifiedMs: number;
}

export class MemoryMediaStore {
  readonly objects = new Map<string, MemoryObject>();
  /** Bytes per pending upload part, keyed by upload id then part number. */
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  readonly signed: Array<{ op: string; key: string; options?: unknown }> = [];
  readonly aborted: string[] = [];
  private clock = 1_000;
  private nextUpload = 1;

  /** Stores a part as the client's PUT would; returns its ETag. */
  sendPart(uploadId: string, partNumber: number, bytes: Uint8Array): string {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`unknown upload ${uploadId}`);
    upload.parts.set(partNumber, bytes);
    return `"etag-${partNumber}"`;
  }

  putObject(key: string, bytes: Uint8Array, lastModifiedMs?: number): void {
    this.objects.set(key, { bytes, lastModifiedMs: lastModifiedMs ?? this.tick() });
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  readonly storage: ObjectStorage = {
    put: async (key, value, options) => {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : ArrayBuffer.isView(value)
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(await new Response(value).arrayBuffer());
      this.objects.set(key, {
        bytes,
        contentType: options?.contentType,
        lastModifiedMs: this.tick(),
      });
    },
    delete: async (key) => {
      this.objects.delete(key);
    },
    head: async (key) => {
      const object = this.objects.get(key);
      return object ? metadataOf(object) : null;
    },
    get: async (key, options) => {
      const object = this.objects.get(key);
      if (!object) return null;
      const range = options?.range;
      const bytes = range
        ? object.bytes.slice(range.offset, range.offset + range.length)
        : object.bytes;
      return { ...metadataOf(object), body: new Response(bytes).body! };
    },
  };

  readonly direct: DirectObjectTransfer = {
    createMultipartUpload: async (key) => {
      const uploadId = `upload-${this.nextUpload++}`;
      this.uploads.set(uploadId, { key, parts: new Map() });
      return uploadId;
    },
    signUploadPart: async (key, uploadId, partNumber, expiresInSeconds) => {
      this.signed.push({ op: "part", key, options: { uploadId, partNumber, expiresInSeconds } });
      return `https://store.test/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
    },
    completeMultipartUpload: async (key, uploadId, parts: DirectUploadPart[]) => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
      const chunks = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => {
          const bytes = upload.parts.get(part.partNumber);
          if (!bytes || part.etag !== `"etag-${part.partNumber}"`) throw new Error("InvalidPart");
          return bytes;
        });
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.uploads.delete(uploadId);
      this.objects.set(key, { bytes, lastModifiedMs: this.tick() });
    },
    abortMultipartUpload: async (key, uploadId) => {
      this.uploads.delete(uploadId);
      this.aborted.push(key);
    },
    signPut: async (key, options) => {
      this.signed.push({ op: "put", key, options });
      return `https://store.test/${key}?put`;
    },
    signGet: async (key, options) => {
      this.signed.push({ op: "get", key, options });
      return `https://store.test/${key}?get`;
    },
    list: async (prefix): Promise<StoredObjectSummary[]> =>
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({
          key,
          size: object.bytes.byteLength,
          lastModifiedMs: object.lastModifiedMs,
        }))
        .sort((a, b) => a.lastModifiedMs - b.lastModifiedMs),
  };
}

function metadataOf(object: MemoryObject): ObjectStorageMetadata {
  return {
    size: object.bytes.byteLength,
    httpEtag: `"${object.bytes.byteLength}"`,
    writeHttpMetadata(headers: Headers): void {
      if (object.contentType) headers.set("Content-Type", object.contentType);
    },
  };
}
