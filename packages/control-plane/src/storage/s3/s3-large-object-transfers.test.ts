import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  contentDisposition,
  createS3LargeObjectTransfers,
  readS3TransferConfig,
} from "./s3-large-object-transfers";
import { createS3ObjectStorage } from "./s3-object-storage";

describe("readS3TransferConfig", () => {
  it("relays sandboxes when signed URLs would be plaintext", () => {
    expect(readS3TransferConfig({}, { endpoint: "http://object-store:9000" })).toEqual({
      publicEndpoint: undefined,
      corsOrigins: [],
      sandboxAccess: "relay",
    });
  });

  it("lets sandboxes go direct to an https store", () => {
    expect(
      readS3TransferConfig(
        {
          OBJECT_STORE_PUBLIC_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
          OBJECT_STORE_CORS_ORIGINS: "https://studio.example, http://localhost:3000 ,",
        },
        { endpoint: "http://object-store:9000" }
      )
    ).toEqual({
      publicEndpoint: "https://acct.r2.cloudflarestorage.com",
      corsOrigins: ["https://studio.example", "http://localhost:3000"],
      sandboxAccess: "direct",
    });
    expect(readS3TransferConfig({}, { endpoint: undefined }).sandboxAccess).toBe("direct");
  });

  it("drops trailing slashes from the public endpoint and the origins", () => {
    expect(
      readS3TransferConfig(
        {
          OBJECT_STORE_PUBLIC_ENDPOINT: "https://engine.example/",
          OBJECT_STORE_CORS_ORIGINS: "http://localhost:3000/",
        },
        { endpoint: "http://object-store:9000" }
      )
    ).toEqual({
      publicEndpoint: "https://engine.example",
      corsOrigins: ["http://localhost:3000"],
      sandboxAccess: "direct",
    });
  });

  it("honours an explicit sandbox access mode and refuses an unknown one", () => {
    expect(
      readS3TransferConfig(
        { OBJECT_STORE_SANDBOX_ACCESS: "direct" },
        { endpoint: "http://localhost:9000" }
      ).sandboxAccess
    ).toBe("direct");
    expect(() =>
      readS3TransferConfig({ OBJECT_STORE_SANDBOX_ACCESS: "tunnel" }, { endpoint: undefined })
    ).toThrow(/direct or relay/);
  });
});

describe("contentDisposition", () => {
  it("carries a non-ASCII name in the RFC 5987 form", () => {
    expect(contentDisposition('北汉山 "cut".mp4')).toBe(
      `attachment; filename="___ _cut_.mp4"; filename*=UTF-8''${encodeURIComponent('北汉山 "cut".mp4')}`
    );
  });
});

/**
 * Against a real S3-compatible store, when one is named: the signing, the
 * multipart lifecycle and CORS are the store's behaviour, which a fake would
 * only restate. Run with
 *   TEST_S3_ENDPOINT=http://127.0.0.1:19000 TEST_S3_ACCESS_KEY=… \
 *   TEST_S3_SECRET_KEY=… TEST_S3_BUCKET=media npx vitest run s3-large-object-transfers
 */
const endpoint = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)("S3 large object transfers against a real store", () => {
  const storage = {
    bucket: process.env.TEST_S3_BUCKET ?? "media",
    region: "us-east-1",
    endpoint,
    allowHttpEndpoint: true,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "",
    },
  };
  const transfers = createS3LargeObjectTransfers(storage, {
    publicEndpoint: (endpoint ?? "").replace("127.0.0.1", "localhost"),
    corsOrigins: [],
    sandboxAccess: "relay",
  });
  const objects = createS3ObjectStorage({ ...storage, maxObjectBytes: 64 * 1024 * 1024 });

  it("uploads parts through signed URLs, resumes from the listed parts and completes", async () => {
    const key = `test/${randomUUID()}`;
    const partSize = 5 * 1024 * 1024;
    const bytes = randomBytes(partSize * 2 + 1234);
    const uploadId = await transfers.createMultipartUpload(key, "video/mp4");

    const put = async (partNumber: number) => {
      const url = await transfers.signUploadPart(key, uploadId, partNumber, 60_000);
      const start = (partNumber - 1) * partSize;
      const response = await fetch(url, {
        method: "PUT",
        body: bytes.subarray(start, Math.min(start + partSize, bytes.length)),
      });
      expect(response.status).toBe(200);
    };
    await put(1);
    await put(3);
    // A dropped connection leaves parts 1 and 3; the client asks and fills the gap.
    const listed = await transfers.listParts(key, uploadId);
    expect(listed.map((part) => part.partNumber)).toEqual([1, 3]);
    await transfers.uploadPart(key, uploadId, 2, bytes.subarray(partSize, partSize * 2));
    const parts = await transfers.listParts(key, uploadId);
    expect(parts.map((part) => part.sizeBytes)).toEqual([partSize, partSize, 1234]);
    await transfers.completeMultipartUpload(key, uploadId, parts);

    const head = await objects.head(key);
    expect(head?.size).toBe(bytes.length);

    const url = await transfers.signDownload(key, { expiresInMs: 60_000, downloadName: "片.mp4" });
    const ranged = await fetch(url, { headers: { Range: "bytes=10-19" } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    await objects.delete(key);
  });

  it("aborts an open upload, twice without error", async () => {
    const key = `test/${randomUUID()}`;
    const uploadId = await transfers.createMultipartUpload(key);
    await transfers.abortMultipartUpload(key, uploadId);
    await transfers.abortMultipartUpload(key, uploadId);
  });

  it("applies CORS so a browser origin may PUT parts", async () => {
    await transfers.applyCors(["http://localhost:3101"]);
    const response = await fetch(`${endpoint}/${storage.bucket}/test/cors-probe`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3101",
        "Access-Control-Request-Method": "PUT",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3101");
  });
});
