/**
 * Transfers that go straight between a client (the sandbox, the browser) and
 * the media store, with the host only signing them: large uploads in parts,
 * and downloads. Hosts that cannot sign requests for their store (R2 through
 * a Worker binding) do not provide it, and the routes that need it answer 501.
 */

export type DirectUploadPart = { partNumber: number; etag: string };

export type StoredObjectSummary = { key: string; size: number; lastModifiedMs: number };

export interface DirectObjectTransfer {
  /** Opens a multipart upload and returns its upload id. */
  createMultipartUpload(key: string, options: { contentType: string }): Promise<string>;
  /** A URL the client PUTs one part's bytes to; the response's ETag names the part. */
  signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number
  ): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: DirectUploadPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** A URL the client PUTs a whole object to (single request, for objects of a few GiB at most). */
  signPut(key: string, options: { contentType: string; expiresInSeconds: number }): Promise<string>;
  /**
   * A URL the client GETs the object from. `contentDisposition` and `contentType` override the
   * stored headers on the response, so a download keeps its name whatever the key is.
   */
  signGet(
    key: string,
    options: { expiresInSeconds: number; contentDisposition?: string; contentType?: string }
  ): Promise<string>;
  /** Every object under `prefix`, oldest first. */
  list(prefix: string): Promise<StoredObjectSummary[]>;
}
