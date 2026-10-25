/**
 * The `DirectObjectTransfer` port on S3-compatible storage: multipart uploads
 * opened and closed by the host, parts and downloads signed for the client to
 * send itself, so gigabyte files never pass through the host.
 *
 * Signed URLs are built against OBJECT_STORE_PUBLIC_ENDPOINT (read with the
 * other transfer settings by `readS3TransferConfig`, so user files and file
 * artifacts share one public address), the address sandboxes and browsers
 * reach the store at (the compose stack's store is
 * only on the compose network; the local stack publishes it through its edge
 * proxy). With no public endpoint, only AWS S3 itself (no
 * OBJECT_STORE_ENDPOINT) is reachable from outside, so the transfer is
 * offered there and nowhere else.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DirectObjectTransfer, StoredObjectSummary } from "../direct-transfer";
import type { S3ObjectStorageConfig } from "./s3-object-storage";

class S3DirectTransfer implements DirectObjectTransfer {
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(config: S3ObjectStorageConfig, publicEndpoint: string | undefined) {
    this.bucket = config.bucket;
    const base = {
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: config.credentials,
    };
    this.client = new S3Client({ ...base, endpoint: config.endpoint });
    // Checksums only when an operation requires one: a presigned PUT signs the
    // checksum of the body it was given, which is none, and the store would
    // refuse every real body against it.
    this.signer = new S3Client({
      ...base,
      endpoint: publicEndpoint ?? config.endpoint,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async createMultipartUpload(key: string, options: { contentType: string }): Promise<string> {
    const output = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
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
    expiresInSeconds: number
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      })
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })
    );
  }

  signPut(key: string, options: { contentType: string; expiresInSeconds: number }) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: options.contentType }),
      { expiresIn: options.expiresInSeconds }
    );
  }

  signGet(
    key: string,
    options: { expiresInSeconds: number; contentDisposition?: string; contentType?: string }
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresInSeconds }
    );
  }

  async list(prefix: string): Promise<StoredObjectSummary[]> {
    const objects: StoredObjectSummary[] = [];
    let continuationToken: string | undefined;
    do {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const entry of output.Contents ?? []) {
        if (!entry.Key) continue;
        objects.push({
          key: entry.Key,
          size: entry.Size ?? 0,
          lastModifiedMs: entry.LastModified?.getTime() ?? 0,
        });
      }
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects.sort(
      (a, b) => a.lastModifiedMs - b.lastModifiedMs || a.key.localeCompare(b.key)
    );
  }
}

/**
 * The direct transfer for this store, or undefined when clients could not
 * reach the URLs it would sign (a private endpoint and no public one).
 */
export function createS3DirectTransfer(
  config: S3ObjectStorageConfig,
  publicEndpoint: string | undefined
): DirectObjectTransfer | undefined {
  if (!publicEndpoint && config.endpoint) return undefined;
  if (publicEndpoint && new URL(publicEndpoint).protocol === "http:" && !config.allowHttpEndpoint) {
    throw new Error(
      `OBJECT_STORE_PUBLIC_ENDPOINT ${publicEndpoint} is plaintext http; signed URLs would cross ` +
        "the network in the clear. Use https, or set OBJECT_STORE_ALLOW_HTTP=true for a local " +
        "compose stack only."
    );
  }
  return new S3DirectTransfer(config, publicEndpoint);
}
