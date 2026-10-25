import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { purgeUserMemory } from "./purge";
import { USER_MEMORY_FORGOTTEN_RETENTION_MS, USER_MEMORY_OP_RETENTION_MS } from "./store";
import { memoryServiceFor, seedUsers } from "./test-helpers";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/d1/migrations"
);

const OWNER = "owner-1";
const DAY_MS = 24 * 60 * 60 * 1000;
const START = 1_800_000_000_000;

describe("purgeUserMemory", () => {
  let dir: string;
  let db: NodeSqlDatabase;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "user-memory-purge-"));
    db = openNodeSqlDatabase(join(dir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    await seedUsers(db, [OWNER]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes keys forgotten or lapsed long ago with every version, and old ops", async () => {
    const clock = { now: START };
    const { service } = memoryServiceFor(db, clock);
    const writer = { kind: "agent", sessionId: "session-1" } as const;
    // Two versions, then forgotten at START.
    await service.applyOps(
      OWNER,
      [
        { op: "set", key: "pref.old", content: "First take" },
        { op: "set", key: "pref.old", content: "Second take" },
        { op: "forget", key: "pref.old" },
        { op: "set", key: "lesson.dated", content: "Launch week: post daily", ttlDays: 1 },
        { op: "set", key: "pref.kept", content: "Male voice" },
        { op: "set", key: "pref.kept", content: "Calm male voice" },
      ],
      writer
    );
    clock.now = START + 2 * DAY_MS;
    await service.applyOps(OWNER, [{ op: "forget", key: "pref.kept" }], writer);
    await service.applyOps(OWNER, [{ op: "set", key: "pref.kept", content: "Deep voice" }], writer);
    clock.now = START + 25 * DAY_MS;
    await service.applyOps(OWNER, [{ op: "set", key: "pref.recent", content: "Jazz" }], writer);
    await service.applyOps(OWNER, [{ op: "forget", key: "pref.recent" }], writer);

    const log = { info: vi.fn() } as unknown as Logger;
    await purgeUserMemory(db, log, START + USER_MEMORY_FORGOTTEN_RETENTION_MS + 2 * DAY_MS);

    const left = await db
      .prepare("SELECT key, version FROM user_memory_entries ORDER BY key, version")
      .all<{ key: string; version: number }>();
    // pref.old (forgotten) and lesson.dated (lapsed) are gone with their history; pref.kept is
    // live again so its forgotten past stays; pref.recent was forgotten too recently.
    expect(left.results.map((row) => `${row.key}@${row.version}`)).toEqual([
      "pref.kept@1",
      "pref.kept@2",
      "pref.kept@3",
      "pref.recent@1",
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "user_memory.purged",
      expect.objectContaining({ entries: 3, ops: 0 })
    );

    await purgeUserMemory(db, log, START + 2 * DAY_MS + USER_MEMORY_OP_RETENTION_MS + 1);
    const ops = await db
      .prepare("SELECT key, created_at FROM user_memory_ops ORDER BY created_at, id")
      .all<{ key: string; created_at: number }>();
    expect(ops.results.every((op) => op.created_at > START + 2 * DAY_MS)).toBe(true);
    expect(ops.results.map((op) => op.key)).toEqual(["pref.recent", "pref.recent"]);
  });
});
