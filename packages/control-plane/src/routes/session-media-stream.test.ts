import { describe, expect, it, vi } from "vitest";
import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type { SqlDatabase } from "../db/sql-database";
import { DIRECT_DOWNLOAD_URL_TTL_SECONDS } from "../media";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import type { SessionRuntimeClient } from "../session/runtime-client";
import { MemoryMediaStore } from "../storage/direct-transfer.test-support";
import type { Env } from "../types";
import { handleMediaGet } from "./session-media-stream";
import type { SessionRouteContext } from "./session-route";

const FILE: SessionArtifact = {
  id: "f1",
  type: "file",
  url: "sessions/s1/files/f1.fcpxml",
  metadata: {
    objectKey: "sessions/s1/files/f1.fcpxml",
    filename: "北汉山 final.fcpxml",
    mimeType: "application/xml",
    sizeBytes: 9,
  },
  createdAt: 1,
};

function context(artifact: SessionArtifact): SessionRouteContext {
  const sessionRuntime: SessionRuntimeClient = {
    fetch: vi.fn(async () => Response.json({ artifact })),
  };
  return {
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
}

describe("file artifact downloads", () => {
  it("redirects to a short-lived signed URL that downloads under the file's name", async () => {
    const store = new MemoryMediaStore();
    const env = { MEDIA_BUCKET: store.storage, MEDIA_DIRECT: store.direct } as unknown as Env;

    const response = await handleMediaGet(
      new Request("https://cp.test/sessions/s1/media/f1"),
      env,
      { id: "s1", artifactId: "f1" },
      context(FILE)
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://store.test/sessions/s1/files/f1.fcpxml?get"
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(store.signed).toEqual([
      {
        op: "get",
        key: "sessions/s1/files/f1.fcpxml",
        options: {
          expiresInSeconds: DIRECT_DOWNLOAD_URL_TTL_SECONDS,
          contentDisposition:
            `attachment; filename="___ final.fcpxml"; ` +
            `filename*=UTF-8''%E5%8C%97%E6%B1%89%E5%B1%B1%20final.fcpxml`,
          contentType: "application/octet-stream",
        },
      },
    ]);
  });

  it("streams the file as an attachment where the store cannot be reached directly", async () => {
    const store = new MemoryMediaStore();
    store.putObject("sessions/s1/files/f1.fcpxml", new TextEncoder().encode("<fcpxml/>"));
    const env = { MEDIA_BUCKET: store.storage } as unknown as Env;

    const response = await handleMediaGet(
      new Request("https://cp.test/sessions/s1/media/f1"),
      env,
      { id: "s1", artifactId: "f1" },
      context(FILE)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("<fcpxml/>");
  });

  it("never redirects a preview", async () => {
    const store = new MemoryMediaStore();
    store.putObject("sessions/s1/media/v1.mp4", new Uint8Array([1, 2, 3]));
    const env = { MEDIA_BUCKET: store.storage, MEDIA_DIRECT: store.direct } as unknown as Env;
    const video: SessionArtifact = {
      id: "v1",
      type: "video",
      url: "sessions/s1/media/v1.mp4",
      metadata: { mimeType: "video/mp4" },
      createdAt: 1,
    };

    const response = await handleMediaGet(
      new Request("https://cp.test/sessions/s1/media/v1"),
      env,
      { id: "s1", artifactId: "v1" },
      context(video)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(store.signed).toEqual([]);
  });
});
