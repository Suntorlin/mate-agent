import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { LargeObjectTransfers, UploadedPart } from "../../src/storage/large-object-transfers";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedSandboxAuthHash, serviceRequestHeaders } from "./helpers";

const BASE = "https://test.local";
// Two users who signed in separately.
const ALICE = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BOB = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const ALICE_SANDBOX_TOKEN = "user-files-alice-sandbox-token";
const BOB_SANDBOX_TOKEN = "user-files-bob-sandbox-token";
const PART = 16 * 1024 * 1024;

/**
 * The store side of a multipart upload, in memory: what a browser PUTs to a
 * signed URL lands in `parts`, and completion writes the joined bytes to the
 * media bucket so the relay route can serve them.
 */
class FakeTransfers implements LargeObjectTransfers {
  sandboxDirect = false;
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  readonly aborted: string[] = [];
  private next = 0;

  async createMultipartUpload(key: string): Promise<string> {
    const uploadId = `upload-${++this.next}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return uploadId;
  }
  async signUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `https://store.test/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  /** What a browser does with a signed part URL. */
  putSigned(url: string, body: Uint8Array): void {
    const parsed = new URL(url);
    const upload = this.uploads.get(parsed.searchParams.get("uploadId")!)!;
    upload.parts.set(Number(parsed.searchParams.get("partNumber")), body);
  }
  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<void> {
    this.uploads.get(uploadId)!.parts.set(partNumber, body);
  }
  async listParts(_key: string, uploadId: string): Promise<UploadedPart[]> {
    const upload = this.uploads.get(uploadId);
    return [...(upload?.parts ?? new Map<number, Uint8Array>()).entries()]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, bytes]) => ({ partNumber, sizeBytes: bytes.byteLength, etag: "e" }));
  }
  async completeMultipartUpload(key: string, uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)!;
    const chunks = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await env.MEDIA_BUCKET.put(key, joined);
    this.uploads.delete(uploadId);
  }
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.aborted.push(uploadId);
    this.uploads.delete(uploadId);
  }
  async signDownload(key: string, options: { downloadName?: string }): Promise<string> {
    return `https://store.test/${key}?download=${options.downloadName ?? ""}`;
  }
}

let transfers: FakeTransfers;

async function call(
  userId: string | { sandboxToken: string },
  path: string,
  options: {
    method?: string;
    body?: unknown;
    raw?: Uint8Array;
    headers?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers =
    typeof userId === "string"
      ? await serviceRequestHeaders(url, { method, body, as: { userId, role: "member" } })
      : { Authorization: `Bearer ${userId.sandboxToken}` };
  return routeRequest(
    new Request(url, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined && typeof userId !== "string"
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
      body: options.raw ?? body,
    }),
    {
      ...env,
      TEAMS_ENFORCEMENT: "on",
      DEFAULT_SESSION_VISIBILITY: "private",
      MEDIA_TRANSFERS: transfers,
      ...options.env,
    } as typeof env,
    createExecutionContext()
  );
}

async function createSession(userId: string, sandboxToken: string): Promise<string> {
  const response = await call(userId, "/sessions", {
    method: "POST",
    body: { title: "Cut", model: "anthropic/claude-haiku-4-5" },
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await seedSandboxAuthHash(stub, { authToken: sandboxToken, sandboxId: `sandbox-${userId}` });
  return sessionId;
}

interface UploadResponse {
  file: { id: string; status: string; name: string; kind: string; scope: string };
  upload: { partSizeBytes: number; partCount: number; uploadedParts: number[] };
}

/** Upload `bytes` as the browser does: create, sign, PUT each part, complete. */
async function upload(
  userId: string,
  name: string,
  bytes: Uint8Array,
  scope: "library" | "input" = "library",
  options: { skipParts?: number[]; complete?: boolean } = {}
): Promise<UploadResponse> {
  const created = await call(userId, "/files/uploads", {
    method: "POST",
    body: { name, sizeBytes: bytes.byteLength, scope },
  });
  expect(created.status).toBe(201);
  const plan = await created.json<UploadResponse>();
  const wanted = Array.from({ length: plan.upload.partCount }, (_, i) => i + 1).filter(
    (n) => !plan.upload.uploadedParts.includes(n) && !options.skipParts?.includes(n)
  );
  if (wanted.length > 0) {
    const signed = await call(userId, `/files/${plan.file.id}/upload/parts`, {
      method: "POST",
      body: { partNumbers: wanted },
    });
    expect(signed.status).toBe(200);
    const { transfer, parts } = await signed.json<{
      transfer: string;
      parts: { partNumber: number; url: string }[];
    }>();
    expect(transfer).toBe("direct");
    for (const part of parts) {
      const start = (part.partNumber - 1) * plan.upload.partSizeBytes;
      transfers.putSigned(part.url, bytes.subarray(start, start + plan.upload.partSizeBytes));
    }
  }
  if (options.complete !== false) {
    const completed = await call(userId, `/files/${plan.file.id}/upload/complete`, {
      method: "POST",
    });
    expect(completed.status).toBe(200);
  }
  return plan;
}

async function digest(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOf(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096 + seed) % 251;
  return bytes;
}

async function libraryNames(userId: string): Promise<string[]> {
  const response = await call(userId, "/files?scope=library");
  expect(response.status).toBe(200);
  const body = await response.json<{ files: { name: string; status: string }[] }>();
  return body.files.filter((file) => file.status === "ready").map((file) => file.name);
}

describe("user files", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    transfers = new FakeTransfers();
    for (const userId of [ALICE, BOB]) {
      expect((await call(userId, "/me/authorization")).status).toBe(200);
    }
  });

  it("uploads a multi-part file to the owner's library and keeps it from everyone else", async () => {
    const plan = await upload(ALICE, "brand/intro.mov", bytesOf(PART + 1000));
    expect(plan.file).toMatchObject({ name: "brand-intro.mov", kind: "video", scope: "library" });
    expect(plan.upload).toMatchObject({ partSizeBytes: PART, partCount: 2, uploadedParts: [] });

    expect(await libraryNames(ALICE)).toEqual(["brand-intro.mov"]);
    expect(await libraryNames(BOB)).toEqual([]);

    const id = plan.file.id;
    const url = await call(ALICE, `/files/${id}/url?download=1`);
    expect(await url.json()).toEqual({
      url: expect.stringContaining("download=brand-intro.mov"),
    });

    const denied: Array<[string, string, unknown?]> = [
      ["GET", `/files/${id}/url`],
      ["GET", `/files/${id}/content`],
      ["GET", `/files/${id}/upload`],
      ["POST", `/files/${id}/upload/parts`, { partNumbers: [1] }],
      ["POST", `/files/${id}/upload/complete`],
      ["PATCH", `/files/${id}`, { name: "mine.mov" }],
      ["DELETE", `/files/${id}`],
    ];
    for (const [method, path, body] of denied) {
      const response = await call(BOB, path, { method, body });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }

    const renamed = await call(ALICE, `/files/${id}`, {
      method: "PATCH",
      body: { name: "Intro.mov", kind: "other" },
    });
    expect(await renamed.json()).toMatchObject({ file: { name: "Intro.mov", kind: "other" } });
    expect((await call(ALICE, `/files/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await libraryNames(ALICE)).toEqual([]);
    expect(await env.MEDIA_BUCKET.head(`users/${ALICE}/files/${id}`)).toBeNull();
  });

  it("resumes an interrupted upload instead of starting over", async () => {
    const bytes = bytesOf(PART * 2 + 5);
    const first = await upload(ALICE, "long.mp4", bytes, "library", {
      skipParts: [2, 3],
      complete: false,
    });
    const early = await call(ALICE, `/files/${first.file.id}/upload/complete`, {
      method: "POST",
    });
    expect(early.status).toBe(409);

    const again = await upload(ALICE, "long.mp4", bytes);
    expect(again.file.id).toBe(first.file.id);
    expect(again.upload.uploadedParts).toEqual([1]);
    expect(await libraryNames(ALICE)).toEqual(["long.mp4"]);
    const stored = await env.MEDIA_BUCKET.get(`users/${ALICE}/files/${first.file.id}`);
    const storedBytes = await stored!.arrayBuffer();
    expect(storedBytes.byteLength).toBe(bytes.byteLength);
    expect(await digest(storedBytes)).toBe(await digest(bytes));
  });

  it("reports the library's own size beside everything the quota counts", async () => {
    await upload(ALICE, "logo.png", bytesOf(3000), "library");
    await upload(ALICE, "clip.mov", bytesOf(5000), "input");
    await upload(BOB, "other.mov", bytesOf(7000), "library");

    const response = await call(ALICE, "/files?scope=library");
    const { usage } = await response.json<{ usage: Record<string, number> }>();
    expect(usage).toEqual({
      usedBytes: 8000,
      scopeBytes: 3000,
      limitBytes: 100 * 1024 * 1024 * 1024,
    });
  });

  it("refuses a file past the owner's quota", async () => {
    const response = await call(ALICE, "/files/uploads", {
      method: "POST",
      body: { name: "huge.mov", sizeBytes: 3 * 1024 * 1024 * 1024, scope: "library" },
      env: { USER_FILES_QUOTA_GB: "2" },
    });
    expect(response.status).toBe(413);
  });

  it("attaches inputs only to the owner's own session, with the owner's own files", async () => {
    const alice = await createSession(ALICE, ALICE_SANDBOX_TOKEN);
    const bob = await createSession(BOB, BOB_SANDBOX_TOKEN);
    const aliceClip = await upload(ALICE, "clip.mov", bytesOf(2048), "input");
    const bobClip = await upload(BOB, "secret.mov", bytesOf(4096), "input");

    // Bob cannot reach Alice's session, nor attach Alice's file to his own.
    const intoAlice = await call(BOB, `/sessions/${alice}/inputs`, {
      method: "POST",
      body: { fileIds: [bobClip.file.id] },
    });
    expect(intoAlice.status).toBe(404);
    const stolen = await call(BOB, `/sessions/${bob}/inputs`, {
      method: "POST",
      body: { fileIds: [aliceClip.file.id] },
    });
    expect(stolen.status).toBe(400);
    expect((await call(BOB, `/sessions/${alice}/inputs`)).status).toBe(404);

    const attached = await call(ALICE, `/sessions/${alice}/inputs`, {
      method: "POST",
      body: { fileIds: [aliceClip.file.id] },
    });
    expect(attached.status).toBe(200);
    const listed = await call(ALICE, `/sessions/${alice}/inputs`);
    expect(await listed.json()).toMatchObject({
      files: [{ id: aliceClip.file.id, name: "clip.mov", sessionId: alice }],
    });
    // Attaching again is harmless.
    expect(
      (
        await call(ALICE, `/sessions/${alice}/inputs`, {
          method: "POST",
          body: { fileIds: [aliceClip.file.id] },
        })
      ).status
    ).toBe(200);
  });

  it("gives a session's sandbox its inputs and its owner's library, and nobody else's", async () => {
    const alice = await createSession(ALICE, ALICE_SANDBOX_TOKEN);
    await createSession(BOB, BOB_SANDBOX_TOKEN);
    const clipBytes = bytesOf(3000, 3);
    const clip = await upload(ALICE, "clip.mov", clipBytes, "input");
    await call(ALICE, `/sessions/${alice}/inputs`, {
      method: "POST",
      body: { fileIds: [clip.file.id] },
    });
    const font = await upload(ALICE, "Brand Sans.otf", bytesOf(500));
    const bobFile = await upload(BOB, "bob.png", bytesOf(100));

    const aliceSandbox = { sandboxToken: ALICE_SANDBOX_TOKEN };
    const index = await call(aliceSandbox, `/sessions/${alice}/files`);
    expect(index.status).toBe(200);
    expect(await index.json()).toMatchObject({
      inputs: [{ id: clip.file.id, name: "clip.mov", kind: "video", sizeBytes: 3000 }],
      library: [{ id: font.file.id, name: "Brand Sans.otf", kind: "font" }],
    });

    // Bob's sandbox token does not open Alice's session; Alice's sandbox cannot read Bob's file.
    expect(
      (await call({ sandboxToken: BOB_SANDBOX_TOKEN }, `/sessions/${alice}/files`)).status
    ).toBe(401);
    expect(
      (await call(aliceSandbox, `/sessions/${alice}/files/${bobFile.file.id}/download`)).status
    ).toBe(404);
    // People never use the sandbox routes.
    expect((await call(ALICE, `/sessions/${alice}/files`)).status).toBe(401);

    const download = await call(aliceSandbox, `/sessions/${alice}/files/${clip.file.id}/download`);
    expect(await download.json()).toMatchObject({ transfer: "relay", url: null, sizeBytes: 3000 });
    const ranged = await call(aliceSandbox, `/sessions/${alice}/files/${clip.file.id}/content`, {
      headers: { Range: "bytes=100-199" },
    });
    expect(ranged.status).toBe(206);
    expect(await digest(await ranged.arrayBuffer())).toBe(
      await digest(clipBytes.subarray(100, 200))
    );

    transfers.sandboxDirect = true;
    const direct = await call(aliceSandbox, `/sessions/${alice}/files/${font.file.id}/download`);
    expect(await direct.json()).toMatchObject({ transfer: "direct", url: expect.any(String) });
  });

  it("lets the agent save a file into the owner's library through the relay", async () => {
    const alice = await createSession(ALICE, ALICE_SANDBOX_TOKEN);
    const sandbox = { sandboxToken: ALICE_SANDBOX_TOKEN };
    const bytes = bytesOf(1234);
    const inputScope = await call(sandbox, `/sessions/${alice}/files/uploads`, {
      method: "POST",
      body: { name: "x.mp4", sizeBytes: 1, scope: "input" },
    });
    expect(inputScope.status).toBe(400);

    const created = await call(sandbox, `/sessions/${alice}/files/uploads`, {
      method: "POST",
      body: { name: "final cut.mp4", sizeBytes: bytes.byteLength, scope: "library" },
    });
    expect(created.status).toBe(201);
    const { file } = await created.json<UploadResponse>();
    const signed = await call(sandbox, `/sessions/${alice}/files/${file.id}/upload/parts`, {
      method: "POST",
      body: { partNumbers: [1] },
    });
    expect(await signed.json()).toMatchObject({ transfer: "relay", parts: [{ url: null }] });
    const wrongSize = await call(sandbox, `/sessions/${alice}/files/${file.id}/upload/parts/1`, {
      method: "PUT",
      raw: bytes.subarray(0, 10),
    });
    expect(wrongSize.status).toBe(400);
    const part = await call(sandbox, `/sessions/${alice}/files/${file.id}/upload/parts/1`, {
      method: "PUT",
      raw: bytes,
    });
    expect(part.status).toBe(200);
    const done = await call(sandbox, `/sessions/${alice}/files/${file.id}/upload/complete`, {
      method: "POST",
    });
    expect(done.status).toBe(200);
    expect(await libraryNames(ALICE)).toEqual(["final cut.mp4"]);
    expect(await libraryNames(BOB)).toEqual([]);
  });

  it("answers 501 where the store cannot take direct uploads", async () => {
    const response = await call(ALICE, "/files/uploads", {
      method: "POST",
      body: { name: "a.mov", sizeBytes: 10, scope: "library" },
      env: { MEDIA_TRANSFERS: undefined },
    });
    expect(response.status).toBe(501);
  });
});
