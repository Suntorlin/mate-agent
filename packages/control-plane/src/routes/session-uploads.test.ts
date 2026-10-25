import { describe, expect, it, vi } from "vitest";
import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type { SqlDatabase } from "../db/sql-database";
import { DIRECT_UPLOAD_PART_BYTES, FILE_MAX_BYTES, VIDEO_MAX_BYTES } from "../media";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import { MemoryMediaStore } from "../storage/direct-transfer.test-support";
import type { Env } from "../types";
import type { SessionRouteContext } from "./session-route";
import { handleAbortUpload, handleCompleteUpload, handleStartUpload } from "./session-uploads";

const MP4_HEAD = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

interface Harness {
  store: MemoryMediaStore;
  env: Env;
  ctx: SessionRouteContext;
  created: Array<{ artifactId: string; artifactType: string; metadata: Record<string, unknown> }>;
  existing: SessionArtifact[];
}

function harness(options: { direct?: boolean; existing?: SessionArtifact[] } = {}): Harness {
  const store = new MemoryMediaStore();
  const created: Harness["created"] = [];
  const existing = options.existing ?? [];
  const sessionRuntime: SessionRuntimeClient = {
    fetch: vi.fn(async (_sessionId: string, path: string, init?: RequestInit) => {
      if (path === SessionInternalPaths.artifacts) return Response.json({ artifacts: existing });
      if (path === SessionInternalPaths.createMediaArtifact) {
        created.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "ok" });
      }
      return new Response("unexpected", { status: 500 });
    }),
  };
  const ctx: SessionRouteContext = {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
    sessionRuntime,
  };
  const env = {
    MEDIA_BUCKET: store.storage,
    ...(options.direct === false ? {} : { MEDIA_DIRECT: store.direct }),
  } as unknown as Env;
  return { store, env, ctx, created, existing };
}

function post(body: unknown): Request {
  return new Request("https://cp.test/sessions/s1/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface StartedUpload {
  artifactId: string;
  objectKey: string;
  uploadId: string;
  filename: string;
  partSizeBytes: number;
  parts: Array<{ partNumber: number; url: string }>;
}

async function start(h: Harness, body: Record<string, unknown>): Promise<StartedUpload> {
  const response = await handleStartUpload(post(body), h.env, { id: "s1" }, h.ctx);
  expect(response.status).toBe(201);
  return response.json();
}

function artifactOf(type: SessionArtifact["type"], index: number): SessionArtifact {
  return { id: `a${index}`, type, url: null, metadata: null, createdAt: index };
}

describe("direct uploads", () => {
  it("hands over any file: signed parts in, a file artifact under its own name out", async () => {
    const h = harness();
    const started = await start(h, {
      artifactType: "file",
      filename: "../renders/成片 v2 母版.mov",
      sizeBytes: DIRECT_UPLOAD_PART_BYTES + 10,
      contentType: "video/quicktime",
    });
    expect(started.filename).toBe("成片 v2 母版.mov");
    expect(started.objectKey).toBe(`sessions/s1/files/${started.artifactId}.mov`);
    expect(started.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(started.partSizeBytes).toBe(DIRECT_UPLOAD_PART_BYTES);

    const etags = started.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: h.store.sendPart(started.uploadId, part.partNumber, new Uint8Array(part.partNumber)),
    }));
    const response = await handleCompleteUpload(
      post({
        artifactType: "file",
        uploadId: started.uploadId,
        filename: started.filename,
        contentType: "video/quicktime",
        caption: "母版 ProRes",
        parts: etags,
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );

    expect(response.status).toBe(201);
    expect(h.created).toEqual([
      {
        artifactId: started.artifactId,
        artifactType: "file",
        objectKey: started.objectKey,
        metadata: {
          objectKey: started.objectKey,
          filename: "成片 v2 母版.mov",
          mimeType: "video/quicktime",
          sizeBytes: 3,
          caption: "母版 ProRes",
        },
      },
    ]);
  });

  it("marks a project bundle", async () => {
    const h = harness();
    const started = await start(h, { artifactType: "file", filename: "project.zip", sizeBytes: 4 });
    const etag = h.store.sendPart(started.uploadId, 1, new Uint8Array(4));
    const response = await handleCompleteUpload(
      post({
        artifactType: "file",
        uploadId: started.uploadId,
        filename: "project.zip",
        kind: "project",
        parts: [{ partNumber: 1, etag }],
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );
    expect(response.status).toBe(201);
    expect(h.created[0].metadata).toMatchObject({
      kind: "project",
      mimeType: "application/octet-stream",
    });
  });

  it("refuses files over the limit and sessions at their file count", async () => {
    const oversized = harness();
    const tooBig = await handleStartUpload(
      post({ artifactType: "file", filename: "huge.mov", sizeBytes: FILE_MAX_BYTES + 1 }),
      oversized.env,
      { id: "s1" },
      oversized.ctx
    );
    expect(tooBig.status).toBe(400);

    const full = harness({
      existing: Array.from({ length: 200 }, (_, index) => artifactOf("file", index)),
    });
    const tooMany = await handleStartUpload(
      post({ artifactType: "file", filename: "one-more.pdf", sizeBytes: 10 }),
      full.env,
      { id: "s1" },
      full.ctx
    );
    expect(tooMany.status).toBe(429);
  });

  it("takes a large video preview directly and checks it is an MP4", async () => {
    const h = harness();
    const started = await start(h, {
      artifactType: "video",
      filename: "v03-4k.mp4",
      sizeBytes: 300 * 1024 * 1024,
    });
    expect(started.objectKey).toBe(`sessions/s1/media/${started.artifactId}.mp4`);
    expect(started.parts).toHaveLength(5);
    const parts = started.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: h.store.sendPart(
        started.uploadId,
        part.partNumber,
        part.partNumber === 1 ? MP4_HEAD : new Uint8Array(2)
      ),
    }));
    const response = await handleCompleteUpload(
      post({
        artifactType: "video",
        uploadId: started.uploadId,
        filename: started.filename,
        parts,
        video: {
          caption: "成片 v3 4K",
          durationMs: 180_000,
          recordingStartedAt: 1_000,
          recordingEndedAt: 181_000,
          dimensions: '{"width":2160,"height":3840}',
          truncated: "false",
          hasAudio: "true",
        },
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );
    expect(response.status).toBe(201);
    expect(h.created[0]).toMatchObject({
      artifactType: "video",
      metadata: {
        caption: "成片 v3 4K",
        durationMs: 180_000,
        dimensions: { width: 2160, height: 3840 },
        mimeType: "video/mp4",
        hasAudio: true,
      },
    });
  });

  it("drops a direct video that is not an MP4", async () => {
    const h = harness();
    const started = await start(h, { artifactType: "video", filename: "x.mp4", sizeBytes: 3 });
    const etag = h.store.sendPart(started.uploadId, 1, new TextEncoder().encode("not a video"));
    const response = await handleCompleteUpload(
      post({
        artifactType: "video",
        uploadId: started.uploadId,
        filename: "x.mp4",
        parts: [{ partNumber: 1, etag }],
        video: {
          caption: "x",
          durationMs: 1000,
          recordingStartedAt: 1,
          recordingEndedAt: 1001,
          dimensions: '{"width":2,"height":2}',
          truncated: "false",
        },
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );
    expect(response.status).toBe(400);
    expect(h.store.objects.has(started.objectKey)).toBe(false);
    expect(h.created).toEqual([]);
  });

  it("refuses a preview longer than ten minutes or bigger than the preview limit", async () => {
    const h = harness();
    const big = await handleStartUpload(
      post({ artifactType: "video", filename: "long.mp4", sizeBytes: VIDEO_MAX_BYTES + 1 }),
      h.env,
      { id: "s1" },
      h.ctx
    );
    expect(big.status).toBe(400);
    const notMp4 = await handleStartUpload(
      post({ artifactType: "video", filename: "master.mov", sizeBytes: 10 }),
      h.env,
      { id: "s1" },
      h.ctx
    );
    expect(notMp4.status).toBe(400);

    const started = await start(h, { artifactType: "video", filename: "long.mp4", sizeBytes: 12 });
    const etag = h.store.sendPart(started.uploadId, 1, MP4_HEAD);
    const tooLong = await handleCompleteUpload(
      post({
        artifactType: "video",
        uploadId: started.uploadId,
        filename: "long.mp4",
        parts: [{ partNumber: 1, etag }],
        video: {
          caption: "x",
          durationMs: 10 * 60_000 + 1,
          recordingStartedAt: 1,
          recordingEndedAt: 10 * 60_000 + 2,
          dimensions: '{"width":2,"height":2}',
          truncated: "false",
        },
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );
    expect(tooLong.status).toBe(400);
  });

  it("does not complete an upload whose parts did not all arrive", async () => {
    const h = harness();
    const started = await start(h, { artifactType: "file", filename: "a.zip", sizeBytes: 4 });
    const response = await handleCompleteUpload(
      post({
        artifactType: "file",
        uploadId: started.uploadId,
        filename: "a.zip",
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
      }),
      h.env,
      { id: "s1", artifactId: started.artifactId },
      h.ctx
    );
    expect(response.status).toBe(409);
    expect(h.created).toEqual([]);
  });

  it("aborts an upload on request", async () => {
    const h = harness();
    const started = await start(h, { artifactType: "file", filename: "a.zip", sizeBytes: 4 });
    const response = await handleAbortUpload(
      post({ artifactType: "file", uploadId: started.uploadId, filename: "a.zip" }),
      h.env,
      { id: "s1", artifactId: started.artifactId }
    );
    expect(response.status).toBe(200);
    expect(h.store.aborted).toEqual([started.objectKey]);
  });

  it("answers 501 where the store cannot be reached directly", async () => {
    const h = harness({ direct: false });
    const response = await handleStartUpload(
      post({ artifactType: "file", filename: "a.zip", sizeBytes: 4 }),
      h.env,
      { id: "s1" },
      h.ctx
    );
    expect(response.status).toBe(501);
  });
});
