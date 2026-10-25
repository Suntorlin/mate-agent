import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  userMemoryContentChars,
  userMemoryContentProblem,
  userMemoryKeySchema,
  userMemoryLayerForKey,
  userMemoryOpsRequestSchema,
  USER_MEMORY_LIMITS,
} from "./user-memory";
import { serverMessageSchema } from "./server-messages";

describe("userMemoryKeySchema", () => {
  it.each([
    "pref.voice",
    "lesson.product-closeups",
    "project.2026-10-02.coffee",
    "recent.summary",
    "profile.name",
    "profile.time_zone",
  ])("accepts %s", (key) => expect(userMemoryKeySchema.safeParse(key).success).toBe(true));

  it.each([
    "voice",
    "pref",
    "pref.Voice",
    "notes.x",
    "profile",
    "pref.a.b.c.d",
    "pref..x",
    `pref.${"x".repeat(80)}`,
  ])("rejects %s", (key) => expect(userMemoryKeySchema.safeParse(key).success).toBe(false));

  it("maps a key to its layer", () => {
    expect(userMemoryLayerForKey("pref.voice")).toBe("preference");
    expect(userMemoryLayerForKey("project.2026-10-02.x")).toBe("project");
    expect(userMemoryLayerForKey("profile.role")).toBe("profile");
    expect(() => userMemoryLayerForKey("notes.x")).toThrow();
  });
});

describe("userMemoryContentProblem", () => {
  it("allows a short fact in any language", () => {
    expect(userMemoryContentProblem("字幕用黄色描边，不要 emoji")).toBeNull();
    expect(userMemoryContentProblem("Prefers a male voice for voice-overs")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["x".repeat(USER_MEMORY_LIMITS.contentChars + 1), "longer"],
    ["line one\nline two", "one line"],
    ["api_key: sk-abcdefghijklmnopqrstu", "secret"],
    ["https://store.example/o.mp4?X-Amz-Signature=abc", "signed URL"],
    ["Traceback (most recent call last):", "log"],
    ['{"status": "ok"}', "log"],
  ])("refuses %j", (text, reason) => {
    expect(userMemoryContentProblem(text)).toContain(reason);
  });

  it("gives a project entry more room than the other layers", () => {
    const long = "x".repeat(USER_MEMORY_LIMITS.contentChars + 1);
    expect(userMemoryContentProblem(long, "project")).toBeNull();
    expect(userMemoryContentProblem(long, "preference")).toContain("longer than 300");
    expect(
      userMemoryContentProblem("x".repeat(USER_MEMORY_LIMITS.projectContentChars + 1), "project")
    ).toContain("longer than 600");
    expect(userMemoryContentChars("project")).toBe(600);
    expect(userMemoryContentChars("lesson")).toBe(300);
    expect(userMemoryContentChars()).toBe(300);
  });
});

describe("estimateTokens", () => {
  it("counts CJK per character and other text per four characters", () => {
    expect(estimateTokens("字幕")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("字幕 abcd")).toBe(4);
  });
});

describe("ops and messages", () => {
  it("parses the op forms mem sends", () => {
    const parsed = userMemoryOpsRequestSchema.parse({
      ops: [
        { op: "set", key: "pref.voice", content: "男声", said: true },
        { op: "append", key: "project.2026-10-02.coffee", content: "改成 15 秒" },
        { op: "forget", key: "lesson.old", reason: "outdated" },
      ],
    });
    expect(parsed.ops).toHaveLength(3);
  });

  it("accepts memory messages in the server message union", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "memory_updated",
        batchId: "b1",
        source: "user_said",
        changes: [
          { op: "set", key: "pref.voice", layer: "preference", content: "男声", status: "active" },
        ],
      }).success
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({
        type: "memory_loaded",
        paused: false,
        counts: {
          profile: 3,
          recent: false,
          preferences: 2,
          lessons: 0,
          projects: 1,
          pending: 0,
        },
      }).success
    ).toBe(true);
  });
});
