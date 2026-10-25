import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3DirectTransfer } from "./s3-direct-transfer";
import type { S3ObjectStorageConfig } from "./s3-object-storage";

const CREDENTIALS = { accessKeyId: "test-key", secretAccessKey: "test-secret" };

function config(overrides: Partial<S3ObjectStorageConfig> = {}): S3ObjectStorageConfig {
  return {
    bucket: "media",
    region: "us-east-1",
    endpoint: "http://object-store:9000",
    allowHttpEndpoint: true,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    ...overrides,
  };
}

describe("createS3DirectTransfer", () => {
  it("is only offered where clients can reach the store", () => {
    expect(createS3DirectTransfer(config(), undefined)).toBeUndefined();
    expect(createS3DirectTransfer(config({ endpoint: undefined }), undefined)).toBeDefined();
    expect(createS3DirectTransfer(config(), "https://engine.example")).toBeDefined();
  });

  it("refuses a plaintext public endpoint unless http is allowed", () => {
    expect(() =>
      createS3DirectTransfer(config({ allowHttpEndpoint: false }), "http://store.example")
    ).toThrow("plaintext http");
  });
});

describe("signed URLs", () => {
  const direct = createS3DirectTransfer(config(), "https://engine.example")!;

  it("signs downloads against the public origin with the download name", async () => {
    const url = new URL(
      await direct.signGet("sessions/s1/files/a1.mov", {
        expiresInSeconds: 900,
        contentDisposition: `attachment; filename*=UTF-8''%E6%88%90%E7%89%87.mov`,
        contentType: "application/octet-stream",
      })
    );
    expect(url.origin).toBe("https://engine.example");
    expect(url.pathname).toBe("/media/sessions/s1/files/a1.mov");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename*=UTF-8''%E6%88%90%E7%89%87.mov`
    );
    expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
  });

  it("signs upload parts without a checksum the real body could never match", async () => {
    const url = new URL(await direct.signUploadPart("sessions/s1/files/a1.zip", "up-1", 3, 7200));
    expect(url.origin).toBe("https://engine.example");
    expect(url.searchParams.get("uploadId")).toBe("up-1");
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect([...url.searchParams.keys()].some((key) => /checksum/i.test(key))).toBe(false);
  });
});

/** The multipart and listing slice of the S3 API, path style. */
class FakeMultipartS3 {
  readonly parts = new Map<string, Map<number, Buffer>>();
  readonly objects = new Map<string, { bytes: Buffer; modified: Date }>();
  private server: Server | null = null;
  endpoint = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url!, this.endpoint);
    const key = decodeURIComponent(url.pathname.replace("/media/", ""));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        this.parts.set("up-1", new Map());
        response
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(
            `<InitiateMultipartUploadResult><Bucket>media</Bucket><Key>${key}</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>`
          );
        return;
      }
      if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        const number = Number(url.searchParams.get("partNumber"));
        this.parts.get(url.searchParams.get("uploadId")!)!.set(number, body);
        response.writeHead(200, { ETag: `"p${number}"` }).end();
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        const parts = this.parts.get(url.searchParams.get("uploadId")!)!;
        const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
          (match) => Number(match[1])
        );
        this.objects.set(key, {
          bytes: Buffer.concat(order.map((number) => parts.get(number)!)),
          modified: new Date(Date.UTC(2026, 9, 2, 0, 0, this.objects.size)),
        });
        response
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(
            `<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>`
          );
        return;
      }
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...this.objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(
            ([name, object]) =>
              `<Contents><Key>${name}</Key><Size>${object.bytes.length}</Size><LastModified>${object.modified.toISOString()}</LastModified></Contents>`
          )
          .join("");
        response
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      response.writeHead(400).end();
    });
  }
}

describe("multipart uploads against an S3 endpoint", () => {
  const s3 = new FakeMultipartS3();
  beforeAll(() => s3.start());
  afterAll(() => s3.stop());

  it("opens, receives signed parts, completes and lists", async () => {
    const direct = createS3DirectTransfer(config({ endpoint: s3.endpoint }), s3.endpoint)!;
    const key = "sessions/s1/files/a1.zip";
    const uploadId = await direct.createMultipartUpload(key, { contentType: "application/zip" });
    expect(uploadId).toBe("up-1");

    const etags = [];
    for (const [number, text] of [
      [1, "hello "],
      [2, "world"],
    ] as const) {
      const response = await fetch(await direct.signUploadPart(key, uploadId, number, 60), {
        method: "PUT",
        body: text,
      });
      expect(response.status).toBe(200);
      etags.push({ partNumber: number, etag: response.headers.get("etag")! });
    }
    await direct.completeMultipartUpload(key, uploadId, etags.reverse());

    expect(s3.objects.get(key)?.bytes.toString()).toBe("hello world");
    expect(await direct.list("sessions/s1/")).toEqual([
      { key, size: 11, lastModifiedMs: Date.UTC(2026, 9, 2) },
    ]);
  });
});
