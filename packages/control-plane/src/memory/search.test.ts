import { describe, expect, it } from "vitest";
import { USER_MEMORY_RECALL_WEIGHTS, userMemorySearchTokens, matchUserMemory } from "./search";

type Layer = "preference" | "lesson" | "project" | "recent";

function entry(key: string, layer: Layer, content: string, updatedAt: number) {
  return { key, layer, content, updatedAt };
}

describe("userMemorySearchTokens", () => {
  it("keeps lowercase ASCII words of two or more characters and CJK bigrams", () => {
    expect([...userMemorySearchTokens("Voice-over: a MALE voice, 9:16")].sort()).toEqual(
      ["16", "male", "over", "voice"].sort()
    );
    expect([...userMemorySearchTokens("咖啡特写")].sort()).toEqual(["咖啡", "啡特", "特写"].sort());
    expect([...userMemorySearchTokens("男 声")]).toEqual([]);
  });
});

describe("matchUserMemory", () => {
  const entries = [
    entry("pref.voice", "preference", "Male voice for coffee videos", 3),
    entry("lesson.coffee", "lesson", "Coffee close-ups sell", 1),
    entry("project.2026-10-02.coffee", "project", "Coffee launch video", 2),
    entry("recent.summary", "recent", "2026-10-02 coffee launch", 4),
    entry("pref.music", "preference", "Lo-fi music", 5),
  ];

  it("scores matched tokens by layer weight and leaves unweighted layers out of recall", () => {
    const ranked = matchUserMemory("coffee", entries, USER_MEMORY_RECALL_WEIGHTS);
    expect(ranked.map((match) => [match.entry.key, match.score])).toEqual([
      ["lesson.coffee", 1],
      ["project.2026-10-02.coffee", 0.8],
      ["pref.voice", 0.6],
    ]);
  });

  it("counts every matched token, the key included", () => {
    const ranked = matchUserMemory("coffee launch video", entries, USER_MEMORY_RECALL_WEIGHTS);
    expect(ranked[0]).toMatchObject({ entry: { key: "project.2026-10-02.coffee" }, matched: 3 });
    expect(matchUserMemory("music", entries, USER_MEMORY_RECALL_WEIGHTS)[0]).toMatchObject({
      entry: { key: "pref.music" },
      matched: 1,
    });
  });

  it("breaks ties by recency and, without weights, matches every layer", () => {
    const ranked = matchUserMemory("coffee", entries);
    expect(ranked.map((match) => match.entry.key)).toEqual([
      "recent.summary",
      "pref.voice",
      "project.2026-10-02.coffee",
      "lesson.coffee",
    ]);
    expect(matchUserMemory("a", entries)).toEqual([]);
  });

  it("matches Chinese by bigrams", () => {
    const chinese = [
      entry("lesson.closeups", "lesson", "咖啡产品要拍特写", 1),
      entry("pref.voice", "preference", "优先男声", 2),
    ];
    expect(
      matchUserMemory("这次的咖啡视频", chinese, USER_MEMORY_RECALL_WEIGHTS).map(
        (match) => match.entry.key
      )
    ).toEqual(["lesson.closeups"]);
  });
});
