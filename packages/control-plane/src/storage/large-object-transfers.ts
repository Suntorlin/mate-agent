/**
 * Large objects that clients move to and from the media store themselves.
 *
 * `ObjectStorage` streams every byte through the host, which is right for a
 * screenshot and wrong for a 4 GB video: the host would buffer it, and the
 * upload would cross the host's own network link twice. This port hands the
 * transfer to the client instead. An upload is an S3 multipart upload whose
 * part URLs the host presigns; a download is a presigned GET. The host only
 * creates, signs, lists and completes, so no request it serves carries more
 * than one part.
 *
 * Only an S3-compatible store implements it (the Node host's); a host without
 * it leaves `Platform.MEDIA_TRANSFERS` unset and the routes that need it answer
 * 501.
 */

export interface UploadedPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

export interface LargeObjectTransfers {
  /**
   * Whether a sandbox can reach the signed URLs itself. When it cannot (the
   * store sits on a private network the host reaches but a remote sandbox does
   * not), sandboxes move bytes through the host's relay routes instead.
   */
  readonly sandboxDirect: boolean;
  createMultipartUpload(key: string, contentType?: string): Promise<string>;
  /** A URL the holder may PUT one part to, without credentials, until `expiresInMs` passes. */
  signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInMs: number
  ): Promise<string>;
  /** Store one part through the host (the relay path). */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<void>;
  /** The parts the store holds for an open upload, in part order. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly Pick<UploadedPart, "partNumber" | "etag">[]
  ): Promise<void>;
  /** Abort an open upload; an upload the store no longer knows is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /**
   * A URL the holder may GET (with ranges) until `expiresInMs` passes. With
   * `downloadName` the response asks the browser to save rather than show it.
   */
  signDownload(
    key: string,
    options: { expiresInMs: number; downloadName?: string; contentType?: string }
  ): Promise<string>;
}
