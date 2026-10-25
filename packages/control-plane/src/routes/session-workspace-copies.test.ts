import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { MemoryMediaStore } from "../storage/direct-transfer.test-support";
import { WORKSPACE_COPIES_KEPT } from "../storage/workspace-copies";
import type { Env } from "../types";
import type { SandboxRouteContext } from "./shared";
import { handleCompleteWorkspaceCopy, handleStartWorkspaceCopy } from "./session-workspace-copies";

const ctx = {
  trace_id: "trace-1",
  request_id: "request-1",
  db: {} as SqlDatabase,
  executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
  principal: { kind: "sandbox", sandboxId: "sandbox-1" },
} as unknown as SandboxRouteContext;

function post(body: unknown): Request {
  return new Request("https://cp.test/sessions/s1/workspace-copies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function saveCopy(store: MemoryMediaStore, env: Env, bytes: Uint8Array): Promise<string> {
  const started = await handleStartWorkspaceCopy(
    post({ sizeBytes: bytes.byteLength, extension: "tar.zst" }),
    env,
    { id: "s1" },
    ctx
  );
  expect(started.status).toBe(201);
  const upload = (await started.json()) as { key: string; uploadId: string };
  const etag = store.sendPart(upload.uploadId, 1, bytes);
  const completed = await handleCompleteWorkspaceCopy(
    post({ key: upload.key, uploadId: upload.uploadId, parts: [{ partNumber: 1, etag }] }),
    env,
    { id: "s1" },
    ctx
  );
  expect(completed.status).toBe(201);
  return upload.key;
}

describe("workspace copy routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores copies under the session and keeps only the newest few", async () => {
    let now = Date.UTC(2026, 9, 2);
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    const store = new MemoryMediaStore();
    const env = { MEDIA_BUCKET: store.storage, MEDIA_DIRECT: store.direct } as unknown as Env;
    const keys: string[] = [];
    for (let index = 0; index < WORKSPACE_COPIES_KEPT + 2; index += 1) {
      keys.push(await saveCopy(store, env, new Uint8Array([index])));
    }
    for (const key of keys) {
      expect(key).toMatch(/^sessions\/s1\/workspace\/\d{8}T\d{9}Z-[A-Za-z0-9-]+\.tar\.zst$/);
    }
    const remaining = [...store.objects.keys()].filter((key) => key.includes("/workspace/"));
    expect(remaining.sort()).toEqual(keys.slice(-WORKSPACE_COPIES_KEPT).sort());
  });

  it("refuses to complete a key outside the session's copies", async () => {
    const store = new MemoryMediaStore();
    const env = { MEDIA_BUCKET: store.storage, MEDIA_DIRECT: store.direct } as unknown as Env;
    const response = await handleCompleteWorkspaceCopy(
      post({
        key: "sessions/other/workspace/20261002T000000000Z-x.tar.zst",
        uploadId: "u",
        parts: [{ partNumber: 1, etag: "e" }],
      }),
      env,
      { id: "s1" },
      ctx
    );
    expect(response.status).toBe(400);
  });

  it("refuses oversized copies and answers 501 without direct storage", async () => {
    const store = new MemoryMediaStore();
    const env = { MEDIA_BUCKET: store.storage, MEDIA_DIRECT: store.direct } as unknown as Env;
    const tooBig = await handleStartWorkspaceCopy(
      post({ sizeBytes: 17 * 1024 ** 3, extension: "tar.gz" }),
      env,
      { id: "s1" },
      ctx
    );
    expect(tooBig.status).toBe(413);

    const unavailable = await handleStartWorkspaceCopy(
      post({ sizeBytes: 10, extension: "tar.gz" }),
      { MEDIA_BUCKET: store.storage } as unknown as Env,
      { id: "s1" },
      ctx
    );
    expect(unavailable.status).toBe(501);
  });
});
