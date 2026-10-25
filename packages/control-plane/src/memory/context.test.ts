import { estimateTokens, type UserMemoryEntry } from "@open-inspect/shared/types/user-memory";
import { describe, expect, it } from "vitest";
import {
  USER_MEMORY_CONTEXT_LESSONS,
  USER_MEMORY_CONTEXT_PROJECTS,
  USER_MEMORY_EMPTY_CONTEXT,
  renderUserMemoryContext,
} from "./context";

let nextId = 0;

function entry(
  key: string,
  content: string,
  options: Partial<Pick<UserMemoryEntry, "status" | "locked" | "updatedAt">> = {}
) {
  const layer = (
    {
      pref: "preference",
      lesson: "lesson",
      project: "project",
      recent: "recent",
      profile: "profile",
    } as const
  )[key.split(".")[0] as "pref"];
  nextId += 1;
  return {
    id: `e${nextId}`,
    key,
    layer,
    content,
    status: options.status ?? ("active" as const),
    locked: options.locked ?? false,
    updatedAt: options.updatedAt ?? nextId,
  };
}

describe("renderUserMemoryContext", () => {
  it("renders the block: about the user, now, preferences, lessons, projects, unconfirmed", () => {
    const voice = entry("pref.voice", "优先男声", { locked: true, updatedAt: 1 });
    const music = entry("pref.music", "Lo-fi music", { updatedAt: 5 });
    const context = renderUserMemoryContext([
      music,
      voice,
      entry("recent.summary", "2026-10-01 coffee launch\n2026-10-02 hooks test"),
      entry("lesson.closeups", "Close-ups of the cup sell"),
      entry("project.2026-10-02.coffee", "15s launch video, loved"),
      entry("pref.cuts", "Fast cuts", { status: "pending" }),
      entry("lesson.tone", "Playful", { status: "pending" }),
      entry("profile.role", "Coffee shop owner"),
      entry("profile.name", "Ada"),
      entry("profile.city", "Osaka", { status: "pending" }),
    ]);

    expect(context.text).toBe(
      [
        "<user-memory>",
        "Saved for this user, who can see and edit it.",
        "Use it without asking again for what is already here.",
        "## About the user",
        "- profile.name: Ada",
        "- profile.role: Coffee shop owner",
        "## Now",
        "- 2026-10-01 coffee launch",
        "- 2026-10-02 hooks test",
        "## Preferences",
        "- pref.voice: 优先男声 (locked)",
        "- pref.music: Lo-fi music",
        "## Lessons",
        "- lesson.closeups: Close-ups of the cup sell",
        "## Recent projects",
        "- project.2026-10-02.coffee: 15s launch video, loved",
        "## Unconfirmed (use lightly, the user has not approved these)",
        "- profile.city: Osaka",
        "- lesson.tone: Playful",
        "- pref.cuts: Fast cuts",
        "Record lasting facts with `mem` (see the memory skill); search older ones with `mem search <words>`.",
        "</user-memory>",
      ].join("\n")
    );
    expect(context.counts).toEqual({
      profile: 2,
      recent: true,
      preferences: 2,
      lessons: 1,
      projects: 1,
      pending: 3,
    });
    expect(context.entryIds).toHaveLength(10);
  });

  it("is one line when there is no memory", () => {
    const context = renderUserMemoryContext([]);
    expect(context).toEqual({
      text: USER_MEMORY_EMPTY_CONTEXT,
      entryIds: [],
      counts: {
        profile: 0,
        recent: false,
        preferences: 0,
        lessons: 0,
        projects: 0,
        pending: 0,
      },
    });
  });

  it("keeps the newest three projects and the newest lessons", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) =>
        entry(`project.2026-09-0${index + 1}.p${index}`, `Project ${index}`, { updatedAt: index })
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        entry(`lesson.l${index}`, `Lesson ${index}`, { updatedAt: index })
      ),
    ];
    const context = renderUserMemoryContext(entries);
    expect(context.counts).toMatchObject({
      projects: USER_MEMORY_CONTEXT_PROJECTS,
      lessons: USER_MEMORY_CONTEXT_LESSONS,
    });
    expect(context.text).toContain("project.2026-09-05.p4");
    expect(context.text).not.toContain("project.2026-09-02.p1");
    expect(context.text).toContain("lesson.l11:");
    expect(context.text).not.toContain("lesson.l1:");
  });

  it("trims lessons, then unconfirmed entries, then unlocked preferences, oldest first", () => {
    const long = (label: string) => `${label} ${"词".repeat(120)}`;
    const entries = [
      entry("pref.locked", long("locked"), { locked: true, updatedAt: 1 }),
      entry("pref.old", long("old preference"), { updatedAt: 2 }),
      entry("pref.new", long("new preference"), { updatedAt: 30 }),
      entry("lesson.old", long("old lesson"), { updatedAt: 3 }),
      entry("lesson.new", long("new lesson"), { updatedAt: 40 }),
      entry("pref.guess-old", long("old guess"), { status: "pending", updatedAt: 4 }),
      entry("pref.guess-new", long("new guess"), { status: "pending", updatedAt: 50 }),
      entry("project.2026-10-02.coffee", long("project"), { updatedAt: 60 }),
    ];
    const keysAt = (budget: number) => {
      const context = renderUserMemoryContext(entries, budget);
      expect(estimateTokens(context.text)).toBeLessThanOrEqual(budget);
      return entries.filter((each) => context.entryIds.includes(each.id)).map((each) => each.key);
    };

    const all = entries.map((each) => each.key);
    expect(keysAt(10_000)).toEqual(all);
    // Each step gives up the next entry in the documented order.
    const order = [
      "lesson.old",
      "lesson.new",
      "pref.guess-old",
      "pref.guess-new",
      "pref.old",
      "pref.new",
    ];
    const full = estimateTokens(renderUserMemoryContext(entries, 10_000).text);
    for (let dropped = 1; dropped <= order.length; dropped += 1) {
      const budget = full - dropped * 125;
      expect(keysAt(budget)).toEqual(all.filter((key) => !order.slice(0, dropped).includes(key)));
    }
    // Beyond the documented order, the project and finally locked preferences go too.
    expect(keysAt(150)).toEqual([]);
  });
});
