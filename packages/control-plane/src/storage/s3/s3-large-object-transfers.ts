/**
 * `LargeObjectTransfers` on S3-compatible storage (AWS S3, R2's S3 API, the
 * compose stack's SeaweedFS).
 *
 * Two clients share one set of credentials: `internal` talks to the store
 * from the host (create, list, complete, abort, relay parts) over the
 * endpoint the host reaches, and `signer` presigns URLs for the endpoint
 * clients reach (`OBJECT_STORE_PUBLIC_ENDPOINT`), since a SigV4 signature
 * covers the host it was made for. The two are the same endpoint unless the
 * store sits on a private network, as in the compose stack.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  S3Client,
  UploadPartCommand,
  type ListPartsCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pickVariables, type ConfigSource } from "../../config-source";
import type { S3ObjectStorageConfig } from "./s3-object-storage";
import type { LargeObjectTransfers, UploadedPart } from "../large-object-transfers";

/** The variables `readS3TransferConfig` reads; documented in .env.example. */
export const OBJECT_TRANSFER_VARIABLE_NAMES = [
  "OBJECT_STORE_PUBLIC_ENDPOINT",
  "OBJECT_STORE_CORS_ORIGINS",
  "OBJECT_STORE_SANDBOX_ACCESS",
] as const;

export interface S3TransferConfig {
  /** Endpoint signed URLs point at; the store's own endpoint when unset. */
  publicEndpoint?: string;
  /** Browser origins allowed to PUT parts and GET objects; applied to the bucket at boot. */
  corsOrigins: string[];
  /** Whether sandboxes use signed URLs (`direct`) or the host's relay routes (`relay`). */
  sandboxAccess: "direct" | "relay";
}

/**
 * `OBJECT_STORE_SANDBOX_ACCESS` defaults to `direct` when signed URLs point
 * at https (a public store such as R2 or S3) and `relay` for a plaintext
 * endpoint, which only a local stack has and a remote sandbox cannot reach.
 */
export function readS3TransferConfig(
  env: ConfigSource,
  storage: Pick<S3ObjectStorageConfig, "endpoint">
): S3TransferConfig {
  const variables = pickVariables(env, OBJECT_TRANSFER_VARIABLE_NAMES);
  // One public address for every signed URL (user files from browsers, file artifacts and
  // workspace copies from sandboxes); a trailing slash would end up in each signed path.
  const publicEndpoint = withoutTrailingSlash(variables.OBJECT_STORE_PUBLIC_ENDPOINT);
  const signedEndpoint = publicEndpoint ?? storage.endpoint;
  const access = variables.OBJECT_STORE_SANDBOX_ACCESS;
  if (access && access !== "direct" && access !== "relay") {
    throw new Error(`OBJECT_STORE_SANDBOX_ACCESS must be direct or relay (got ${access})`);
  }
  const defaultAccess =
    signedEndpoint && new URL(signedEndpoint).protocol === "http:" ? "relay" : "direct";
  return {
    publicEndpoint,
    corsOrigins: (variables.OBJECT_STORE_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => withoutTrailingSlash(origin.trim()))
      .filter((origin): origin is string => Boolean(origin)),
    sandboxAccess: (access as "direct" | "relay" | undefined) || defaultAccess,
  };
}

/** An origin compares without its trailing slash (CORS matches `Origin` exactly). */
function withoutTrailingSlash(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, "") || undefined : undefined;
}

class S3LargeObjectTransfers implements LargeObjectTransfers {
  readonly sandboxDirect: boolean;
  private readonly internal: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(storage: S3ObjectStorageConfig, transfer: S3TransferConfig) {
    this.bucket = storage.bucket;
    this.sandboxDirect = transfer.sandboxAccess === "direct";
    const base = {
      region: storage.region,
      forcePathStyle: storage.forcePathStyle ?? false,
      credentials: storage.credentials,
    };
    this.internal = new S3Client({ ...base, endpoint: storage.endpoint });
    // Without WHEN_REQUIRED the SDK bakes a checksum of the (absent) body into
    // each presigned part URL, and the store refuses the real bytes.
    this.signer = new S3Client({
      ...base,
      endpoint: transfer.publicEndpoint ?? storage.endpoint,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const output = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType || "application/octet-stream",
      })
    );
    if (!output.UploadId) {
      throw new Error(`S3 CreateMultipartUpload for ${key} answered without UploadId`);
    }
    return output.UploadId;
  }

  signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInMs: number
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: Math.ceil(expiresInMs / 1000) }
    );
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<void> {
    await this.internal.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      })
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const output: ListPartsCommandOutput = await this.internal.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        })
      );
      for (const part of output.Parts ?? []) {
        if (part.PartNumber === undefined || part.ETag === undefined) continue;
        parts.push({ partNumber: part.PartNumber, sizeBytes: part.Size ?? 0, etag: part.ETag });
      }
      if (!output.IsTruncated || !output.NextPartNumberMarker) break;
      marker = String(output.NextPartNumberMarker);
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly Pick<UploadedPart, "partNumber" | "etag">[]
  ): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      })
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internal.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })
      );
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchUpload") return;
      throw error;
    }
  }

  signDownload(
    key: string,
    options: { expiresInMs: number; downloadName?: string; contentType?: string }
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadName
          ? contentDisposition(options.downloadName)
          : undefined,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: Math.ceil(options.expiresInMs / 1000) }
    );
  }

  /** Let `origins` PUT parts and read objects from the browser. Replaces the bucket's rules. */
  async applyCors(origins: readonly string[]): Promise<void> {
    await this.internal.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...origins],
              AllowedMethods: ["GET", "HEAD", "PUT"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );
  }
}

/** `attachment` with the name in both the ASCII fallback and RFC 5987 forms. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createS3LargeObjectTransfers(
  storage: S3ObjectStorageConfig,
  transfer: S3TransferConfig
): LargeObjectTransfers & { applyCors(origins: readonly string[]): Promise<void> } {
  return new S3LargeObjectTransfers(storage, transfer);
}
