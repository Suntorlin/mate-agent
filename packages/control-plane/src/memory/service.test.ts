import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_MEMORY_LIMITS } from "@open-inspect/shared/types/user-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { USER_MEMORY_PAUSED_CONTEXT } from "./context";
import { memoryServiceFor, seedUsers } from "./test-helpers";
import { UserMemoryService, type UserMemoryWriter } from "./service";
import type { UserMemoryStore } from "./store";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/d1/migrations"
);

const OWNER = "owner-1";
const OTHER = "owner-2";
const DAY_MS = 24 * 60 * 60 * 1000;

const CREATOR: UserMemoryWriter = { kind: "user" };
const AGENT: UserMemoryWriter = { kind: "agent", sessionId: "session-1" };
const EXTRACTOR: UserMemoryWriter = { kind: "extractor", sessionId: "session-1", messageId: "m1" };
const SUMMARY: UserMemoryWriter = { kind: "consolidator", sessionId: "session-1" };

describe("UserMemoryService", () => {
  let dir: string;
  let db: NodeSqlDatabase;
  let clock: { now: number };
  let service: UserMemoryService;
  let store: UserMemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "user-memory-"));
    db = openNodeSqlDatabase(join(dir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    await seedUsers(db, [OWNER, OTHER]);
    clock = { now: 1_800_000_000_000 };
    ({ service, store } = memoryServiceFor(db, clock));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function set(
    key: string,
    content: string,
    writer: UserMemoryWriter = CREATOR,
    extra: { said?: boolean; inference?: boolean; ttlDays?: number } = {}
  ) {
    const applied = await service.applyOps(OWNER, [{ op: "set", key, content, ...extra }], writer);
    return applied.results[0]!;
  }

  async function ops(batchId: string) {
    return (await store.opsForBatch(OWNER, batchId)).map(
      (op) => `${op.op}:${op.key}:${op.outcome}`
    );
  }

  async function current(ownerUserId = OWNER) {
    return (await service.list(ownerUserId)).entries;
  }

  describe("versions", () => {
    it("writes a new version for every change and keeps the old ones", async () => {
      const first = await set("pref.voice", "Prefers a male voice");
      clock.now += 1_000;
      const second = await set("pref.voice", "Prefers a calm male voice");

      expect(first).toMatchObject({ outcome: "applied", entry: { version: 1, relation: null } });
      expect(second).toMatchObject({
        outcome: "applied",
        entry: { version: 2, relation: "updates", content: "Prefers a calm male voice" },
      });
      expect((await current()).map((entry) => entry.content)).toEqual([
        "Prefers a calm male voice",
      ]);
      const exported = await service.export(OWNER);
      expect(
        exported.entries.map((entry) => [entry.version, entry.isLatest, entry.content])
      ).toEqual([
        [1, false, "Prefers a male voice"],
        [2, true, "Prefers a calm male voice"],
      ]);
    });

    it("appends to a timeline entry, once", async () => {
      await set("project.2026-10-02.coffee", "15s vertical launch video");
      const applied = await service.applyOps(
        OWNER,
        [
          { op: "append", key: "project.2026-10-02.coffee", content: "user loved the pacing" },
          { op: "append", key: "project.2026-10-02.coffee", content: "user loved the pacing" },
        ],
        AGENT
      );
      expect(applied.results.map((result) => result.outcome)).toEqual(["applied", "unchanged"]);
      expect(applied.results[0]!.entry).toMatchObject({
        content: "15s vertical launch video → user loved the pacing",
        relation: "extends",
        version: 2,
      });
      expect(applied.changes).toHaveLength(1);
    });

    it("drops a separator the writer copied into an append", async () => {
      await set("project.2026-10-02.coffee", "15s vertical launch video");
      const applied = await service.applyOps(
        OWNER,
        [
          { op: "append", key: "project.2026-10-02.coffee", content: "→ v2 approved" },
          { op: "append", key: "project.2026-10-02.coffee", content: "→→ v2 approved" },
        ],
        AGENT
      );
      expect(applied.results.map((result) => result.outcome)).toEqual(["applied", "unchanged"]);
      expect(applied.results[0]!.entry).toMatchObject({
        content: "15s vertical launch video → v2 approved",
      });
    });

    it("lets a project entry grow to its own limit", async () => {
      await set("project.2026-10-02.coffee", "x".repeat(USER_MEMORY_LIMITS.contentChars - 5));
      const grown = (
        await service.applyOps(
          OWNER,
          [{ op: "append", key: "project.2026-10-02.coffee", content: "user loved the pacing" }],
          AGENT
        )
      ).results[0]!;
      expect(grown).toMatchObject({ outcome: "applied" });
      expect(grown.entry!.content.length).toBeGreaterThan(USER_MEMORY_LIMITS.contentChars);
      const full = (
        await service.applyOps(
          OWNER,
          [
            {
              op: "append",
              key: "project.2026-10-02.coffee",
              content: "y".repeat(USER_MEMORY_LIMITS.projectContentChars - 300),
            },
          ],
          AGENT
        )
      ).results[0]!;
      expect(full).toMatchObject({ outcome: "invalid" });
      expect(full.detail).toContain(`past ${USER_MEMORY_LIMITS.projectContentChars} characters`);
    });

    it("refuses an append that would grow past the entry limit", async () => {
      await set("lesson.hooks", "x".repeat(USER_MEMORY_LIMITS.contentChars - 5));
      const result = (
        await service.applyOps(
          OWNER,
          [{ op: "append", key: "lesson.hooks", content: "more" }],
          AGENT
        )
      ).results[0]!;
      expect(result).toMatchObject({ outcome: "invalid" });
      expect(result.detail).toContain("set a shorter summary");
    });

    it("answers unchanged for the same text and logs it", async () => {
      await set("pref.captions", "Yellow captions with an outline");
      const applied = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.captions", content: "  Yellow captions with an outline " }],
        AGENT
      );
      expect(applied.results[0]).toMatchObject({ outcome: "unchanged", entry: { version: 1 } });
      expect(applied.changes).toEqual([]);
      expect(await ops(applied.batchId)).toEqual(["set:pref.captions:unchanged"]);
    });
  });

  describe("status", () => {
    it("makes what the user wrote or said and project records active, and inferences pending", async () => {
      expect((await set("pref.a", "User wrote this")).entry).toMatchObject({
        status: "active",
        source: "user_edit",
      });
      expect((await set("pref.b", "User said this", AGENT, { said: true })).entry).toMatchObject({
        status: "active",
        source: "user_said",
        isInference: false,
      });
      expect(
        (await set("pref.c", "Agent concluded this", AGENT, { inference: true })).entry
      ).toMatchObject({ status: "pending", source: "agent", isInference: true });
      expect((await set("lesson.d", "Agent observed this", AGENT)).entry).toMatchObject({
        status: "active",
        source: "agent",
      });
      expect(
        (await set("pref.e", "Extraction heard this", EXTRACTOR, { said: true })).entry
      ).toMatchObject({ status: "active", source: "extractor", isInference: false });
      expect((await set("pref.f", "Extraction guessed this", EXTRACTOR)).entry).toMatchObject({
        status: "pending",
        source: "extractor",
        isInference: true,
      });
      expect(
        (await set("project.2026-10-02.coffee", "Launch teaser delivered", EXTRACTOR)).entry
      ).toMatchObject({ status: "active", source: "extractor", isInference: false });
    });

    it("promotes a pending entry the user later says, without demoting an active one", async () => {
      await set("pref.music", "Lo-fi music", EXTRACTOR);
      expect(await set("pref.music", "Lo-fi music", AGENT, { said: true })).toMatchObject({
        outcome: "applied",
        entry: { status: "active", version: 2 },
      });
      expect(await set("pref.music", "Lo-fi music", EXTRACTOR)).toMatchObject({
        outcome: "unchanged",
        entry: { status: "active" },
      });
    });
  });

  describe("profile", () => {
    it("takes the user's own fields as set, and anyone else's as suggestions to approve", async () => {
      expect((await set("profile.name", "Ada")).entry).toMatchObject({ status: "active" });
      // Even what the user said is only a suggestion: the profile is theirs to fill in.
      const suggested = await set("profile.role", "Product designer", AGENT, { said: true });
      expect(suggested.entry).toMatchObject({ status: "pending", source: "user_said" });
      expect((await set("profile.time_zone", "Asia/Tokyo", EXTRACTOR)).entry).toMatchObject({
        status: "pending",
      });

      expect(await service.approve(OWNER, suggested.entry!.id)).toMatchObject({
        key: "profile.role",
        status: "active",
      });
    });

    it("leaves a field the user has set to the user", async () => {
      await set("profile.name", "Ada");
      const applied = await service.applyOps(
        OWNER,
        [
          { op: "set", key: "profile.name", content: "Adeline", said: true },
          { op: "forget", key: "profile.name" },
        ],
        AGENT
      );
      expect(applied.results.map((result) => result.outcome)).toEqual(["locked", "locked"]);
      expect((await current()).map((entry) => `${entry.key}=${entry.content}`)).toEqual([
        "profile.name=Ada",
      ]);
      // A suggestion not yet approved can still be replaced by a better one.
      await set("profile.city", "Osaka", EXTRACTOR);
      expect(await set("profile.city", "Tokyo", AGENT)).toMatchObject({
        outcome: "applied",
        entry: { status: "pending", content: "Tokyo" },
      });
    });
  });

  describe("refusals", () => {
    it("lets only the user change or forget a locked key", async () => {
      const { entry } = await service.create(OWNER, { key: "pref.voice", content: "Male voice" });
      await service.update(OWNER, entry.id, { locked: true });

      const applied = await service.applyOps(
        OWNER,
        [
          { op: "set", key: "pref.voice", content: "Female voice", said: true },
          { op: "forget", key: "pref.voice" },
        ],
        AGENT
      );
      expect(applied.results.map((result) => result.outcome)).toEqual(["locked", "locked"]);
      expect(await ops(applied.batchId)).toEqual([
        "set:pref.voice:locked",
        "forget:pref.voice:locked",
      ]);

      const edited = await service.update(OWNER, entry.id, { content: "Deep male voice" });
      expect(edited).toMatchObject({ content: "Deep male voice", locked: true, version: 2 });
    });

    it("refuses a new key in a full layer but still updates existing ones", async () => {
      for (let index = 0; index < USER_MEMORY_LIMITS.preferenceEntries; index += 1) {
        expect(await set(`pref.p${index}`, `Preference number ${index}`)).toMatchObject({
          outcome: "applied",
        });
      }
      const full = await set("pref.one-more", "One preference too many", AGENT);
      expect(full.outcome).toBe("full");
      expect(full.detail).toContain("merge or forget");
      expect(await set("pref.p0", "Preference zero, revised", AGENT)).toMatchObject({
        outcome: "applied",
      });
      // Forgetting makes room again.
      await service.applyOps(OWNER, [{ op: "forget", key: "pref.p1" }], AGENT);
      expect(await set("pref.one-more", "One preference, now it fits", AGENT)).toMatchObject({
        outcome: "applied",
      });
    });

    it("refuses what is not memory", async () => {
      expect(await set("pref.key", "api_key: sk-abcdefghijklmnopqrstuvwxyz", AGENT)).toMatchObject({
        outcome: "invalid",
        detail: "looks like a secret",
      });
      expect(await set("pref.two", "line one\nline two", AGENT)).toMatchObject({
        outcome: "invalid",
        detail: "one line only",
      });
      expect(await set("recent.summary", "2026-10-01 working on a launch", AGENT)).toMatchObject({
        outcome: "invalid",
      });
    });

    it("refuses everyone but the user while memory is paused", async () => {
      await service.setPaused(OWNER, true);
      const applied = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.voice", content: "Male voice", said: true }],
        AGENT
      );
      expect(applied.results[0]).toMatchObject({ outcome: "paused" });
      expect(await ops(applied.batchId)).toEqual(["set:pref.voice:paused"]);
      expect(await set("pref.voice", "Male voice")).toMatchObject({ outcome: "applied" });

      const context = await service.context(OWNER);
      expect(context).toMatchObject({
        text: USER_MEMORY_PAUSED_CONTEXT,
        paused: true,
        entryIds: [],
      });
      expect(await service.search(OWNER, "voice", { limit: 5, exclude: new Set() })).toEqual([]);
      expect((await service.list(OWNER)).paused).toBe(true);
    });

    it("answers missing for a forget with nothing to forget", async () => {
      const applied = await service.applyOps(OWNER, [{ op: "forget", key: "pref.none" }], AGENT);
      expect(applied.results[0]).toMatchObject({ outcome: "missing" });
    });
  });

  describe("expiry and forgetting", () => {
    it("treats a lapsed or forgotten entry as gone, and writes after it as a new version", async () => {
      await set("lesson.launch", "Launch week: post daily", AGENT, { ttlDays: 7 });
      expect(await current()).toHaveLength(1);
      clock.now += 8 * DAY_MS;
      expect(await current()).toEqual([]);

      await set("pref.voice", "Male voice");
      await service.applyOps(
        OWNER,
        [{ op: "forget", key: "pref.voice", reason: "changed mind" }],
        AGENT
      );
      expect(await current()).toEqual([]);
      const again = await set("pref.voice", "Female voice");
      expect(again.entry).toMatchObject({ version: 2, relation: "updates", locked: false });
    });

    it("lets the summary job write a dated multi-line recent.summary", async () => {
      const result = await set(
        "recent.summary",
        "2026-10-01 coffee launch series\n2026-10-02 testing hooks",
        SUMMARY,
        { ttlDays: USER_MEMORY_LIMITS.recentSummaryDays }
      );
      expect(result.entry).toMatchObject({ status: "active", source: "extractor" });
      expect(result.entry!.forgetAfter).toBe(
        clock.now + USER_MEMORY_LIMITS.recentSummaryDays * DAY_MS
      );
    });
  });

  describe("undo", () => {
    it("undoes a batch: new keys are forgotten, changed keys step back, forgotten ones return", async () => {
      await set("pref.voice", "Male voice");
      await set("pref.music", "Lo-fi");
      clock.now += 1_000;
      const batch = await service.applyOps(
        OWNER,
        [
          { op: "set", key: "pref.voice", content: "Female voice", said: true },
          { op: "set", key: "lesson.new", content: "Close-ups sell the product" },
          { op: "append", key: "lesson.new", content: "especially in the first second" },
          { op: "forget", key: "pref.music" },
        ],
        AGENT
      );
      expect(batch.changes).toHaveLength(4);

      clock.now += 1_000;
      expect(await service.undo(OWNER, batch.batchId)).toBe(4);
      expect(
        (await current()).map((entry) => `${entry.key}=${entry.content}@${entry.version}`).sort()
      ).toEqual(["pref.music=Lo-fi@1", "pref.voice=Male voice@1"]);

      // Undoing again changes nothing.
      expect(await service.undo(OWNER, batch.batchId)).toBe(0);
      await expect(service.undo(OWNER, "agent:unknown")).rejects.toMatchObject({ status: 404 });
    });

    it("leaves a key alone when a later batch changed it", async () => {
      const first = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.voice", content: "Male voice", said: true }],
        AGENT
      );
      await set("pref.voice", "Female voice");
      expect(await service.undo(OWNER, first.batchId)).toBe(0);
      expect((await current()).map((entry) => entry.content)).toEqual(["Female voice"]);
    });

    it("keeps another owner's batch out of reach", async () => {
      const batch = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.voice", content: "Male voice" }],
        AGENT
      );
      await expect(service.undo(OTHER, batch.batchId)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("approval", () => {
    it("approves a pending entry and declines another", async () => {
      const pending = (await set("pref.cuts", "Fast cuts", EXTRACTOR)).entry!;
      const other = (await set("pref.music", "Jazz", EXTRACTOR)).entry!;

      expect(await service.approve(OWNER, pending.id)).toMatchObject({ status: "active" });
      expect(await service.decline(OWNER, other.id)).toMatchObject({ key: "pref.music" });
      expect((await current()).map((entry) => `${entry.key}:${entry.status}`)).toEqual([
        "pref.cuts:active",
      ]);
      const exported = await service.export(OWNER);
      expect(exported.entries.find((entry) => entry.key === "pref.music")).toMatchObject({
        forgetReason: "declined",
      });
    });

    it("finds only the caller's own entries", async () => {
      const entry = (await set("pref.cuts", "Fast cuts", EXTRACTOR)).entry!;
      await expect(service.approve(OTHER, entry.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.forget(OTHER, entry.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.update(OTHER, entry.id, { locked: true })).rejects.toMatchObject({
        status: 404,
      });
      expect(await service.forgetIds(OTHER, [entry.id])).toBe(0);
      expect(await current(OTHER)).toEqual([]);
      expect(await current()).toHaveLength(1);
    });
  });

  describe("forgetting in bulk", () => {
    it("previews by keyword, forgets the chosen ids, and clears the rest", async () => {
      await set("pref.voice", "Male voice for coffee videos");
      await set("lesson.coffee", "咖啡产品要拍特写");
      await set("pref.music", "Lo-fi music");

      const preview = await service.forgetPreview(OWNER, "coffee 咖啡");
      expect(preview.map((entry) => entry.key).sort()).toEqual(["lesson.coffee", "pref.voice"]);

      expect(
        await service.forgetIds(
          OWNER,
          preview.map((entry) => entry.id),
          "user asked"
        )
      ).toBe(2);
      expect((await current()).map((entry) => entry.key)).toEqual(["pref.music"]);
      expect(await service.clear(OWNER)).toBe(1);
      expect(await current()).toEqual([]);
      const exported = await service.export(OWNER);
      expect(exported.entries).toHaveLength(3);
      expect(exported.entries.every((entry) => entry.forgottenAt !== null)).toBe(true);
    });
  });

  describe("reading for a session", () => {
    it("renders the context, notes what it handed out, and recalls the rest by keyword", async () => {
      await set("pref.voice", "Male voice");
      for (let index = 0; index < 12; index += 1) {
        clock.now += 1_000;
        await set(`lesson.l${index}`, `Lesson ${index} about product close-ups`, AGENT);
      }
      const context = await service.context(OWNER);
      expect(context.paused).toBe(false);
      expect(context.counts).toMatchObject({ preferences: 1, lessons: 10 });
      expect(context.text).toContain("- pref.voice: Male voice");
      expect(context.text).not.toContain("lesson.l0:");

      const recalled = await service.search(OWNER, "close-ups product", {
        limit: USER_MEMORY_LIMITS.recallResults,
        exclude: new Set(context.entryIds),
      });
      expect(recalled.map((item) => item.key)).toEqual(["lesson.l1", "lesson.l0"]);
      const used = (await store.listCurrent(OWNER, clock.now)).filter(
        (row) => row.last_used_at !== null
      );
      expect(used).toHaveLength(context.entryIds.length + recalled.length);
    });

    it("builds the live update a session shows", async () => {
      const agentSaid = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.voice", content: "Male voice", said: true }],
        AGENT
      );
      expect(UserMemoryService.updatedMessage(agentSaid, AGENT)).toMatchObject({
        type: "memory_updated",
        source: "user_said",
        changes: [{ op: "set", key: "pref.voice", status: "active" }],
      });
      const mixed = await service.applyOps(
        OWNER,
        [
          { op: "set", key: "pref.music", content: "Jazz", said: true },
          { op: "set", key: "pref.cuts", content: "Fast cuts", inference: true },
          { op: "set", key: "pref.voice", content: "Male voice" },
        ],
        AGENT
      );
      expect(UserMemoryService.updatedMessage(mixed, AGENT)).toMatchObject({
        source: "agent",
        changes: [{ key: "pref.music" }, { key: "pref.cuts", status: "pending" }],
      });
      const nothing = await service.applyOps(OWNER, [{ op: "forget", key: "pref.none" }], AGENT);
      expect(UserMemoryService.updatedMessage(nothing, AGENT)).toBeNull();
    });
  });
});
