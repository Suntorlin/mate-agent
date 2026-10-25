import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_ART_GESTURE_LENGTH,
  MAX_SKILL_ART_SEED,
  MAX_SKILL_DISPLAY_NAME_LENGTH,
  MAX_SKILL_LOCALES,
  MAX_SKILL_LOCALE_DESCRIPTION_LENGTH,
  createSkillInputSchema,
  importSkillInputSchema,
  layerSkillLocales,
  listSkillsResponseSchema,
  sessionSkillSelectionSchema,
  skillContentInputSchema,
  skillDisplayName,
  skillImportSourceSchema,
  skillLocalesFromMetadata,
  skillLocalesSchema,
  skillNameSchema,
  skillResolutionPreviewInputSchema,
  skillSummarySchema,
  updateMySkillInputSchema,
} from "./skills";
import { MAX_TARGET_REPOSITORIES } from "./repositories";

/** "la", "lb", …: one more well-formed locale tag than a skill may carry. */
function oneLocaleTooMany(): string[] {
  return Array.from(
    { length: MAX_SKILL_LOCALES + 1 },
    (_, index) => `l${String.fromCharCode(97 + index)}`
  );
}

describe("managed skill contracts", () => {
  it("accepts portable names and rejects ambiguous names", () => {
    expect(skillNameSchema.safeParse("acme-code-review").success).toBe(true);
    expect(skillNameSchema.safeParse("Acme Review").success).toBe(false);
    expect(skillNameSchema.safeParse("acme--review").success).toBe(false);
  });

  it("reads the display name from metadata, ignoring a blank one", () => {
    expect(skillDisplayName({ display_name: " 口播一键出片 " })).toBe("口播一键出片");
    expect(skillDisplayName({ display_name: "  " })).toBeNull();
    expect(skillDisplayName({ author: "x" })).toBeNull();
  });

  it("reads names and one-liners by language from metadata, leaving out what does not fit", () => {
    expect(
      skillLocalesFromMetadata({
        display_name: "Talking character",
        "display_name.zh-CN": " 会说话的角色 ",
        "summary.zh-CN": "让角色开口说一句话，口型对上",
        "display_name.ja": "しゃべるキャラクター",
        "summary.pt": "Faz a personagem falar",
        author: "x",
        summary: "No language",
        // None of these is a reason to refuse the skill.
        "display_name.": "No tag",
        "display_name.Chinese": "Not a tag",
        "display_name.zh_CN": "Underscore",
        "summary.zh-CN.short": "Too deep",
        "display_name.ko": "   ",
        "display_name.de": "长".repeat(MAX_SKILL_DISPLAY_NAME_LENGTH + 1),
        "summary.de": "x".repeat(MAX_SKILL_LOCALE_DESCRIPTION_LENGTH + 1),
        "display_name.fr": "😀".repeat(MAX_SKILL_DISPLAY_NAME_LENGTH),
        "summary.fr": "x".repeat(MAX_SKILL_LOCALE_DESCRIPTION_LENGTH),
      })
    ).toEqual({
      "zh-CN": { name: "会说话的角色", description: "让角色开口说一句话，口型对上" },
      ja: { name: "しゃべるキャラクター" },
      pt: { description: "Faz a personagem falar" },
      fr: {
        name: "😀".repeat(MAX_SKILL_DISPLAY_NAME_LENGTH),
        description: "x".repeat(MAX_SKILL_LOCALE_DESCRIPTION_LENGTH),
      },
    });
    expect(skillLocalesFromMetadata({})).toEqual({});

    // Languages past the limit are left out; one already counted still gains its line.
    const tags = oneLocaleTooMany();
    const crowded = skillLocalesFromMetadata({
      ...Object.fromEntries(tags.map((tag) => [`display_name.${tag}`, `Name ${tag}`])),
      "summary.la": "One line",
    });
    expect(Object.keys(crowded)).toEqual(tags.slice(0, MAX_SKILL_LOCALES));
    expect(crowded.la).toEqual({ name: "Name la", description: "One line" });
    expect(skillLocalesSchema.safeParse(crowded).success).toBe(true);
  });

  it("checks a locale tag's shape only, and the length of each string", () => {
    const locales = {
      "zh-CN": { name: "会说话的角色", description: "让角色开口说一句话" },
      en: { name: "Talking character" },
      "sr-Latn": { description: "Lik koji govori" },
      xx: {},
    };
    expect(skillLocalesSchema.parse(locales)).toEqual(locales);
    expect(skillLocalesSchema.parse({})).toEqual({});
    expect(skillLocalesSchema.parse({ en: { name: " Talking character " } })).toEqual({
      en: { name: "Talking character" },
    });
    for (const value of [
      { English: { name: "Talking character" } },
      { zh_CN: { name: "会说话的角色" } },
      { en: { name: "" } },
      { en: { name: "   " } },
      { en: { name: "x".repeat(MAX_SKILL_DISPLAY_NAME_LENGTH + 1) } },
      { en: { description: "x".repeat(MAX_SKILL_LOCALE_DESCRIPTION_LENGTH + 1) } },
      { en: { name: "Talking character", title: "Talking" } },
      { en: "Talking character" },
      Object.fromEntries(oneLocaleTooMany().map((tag) => [tag, { name: "x" }])),
    ]) {
      expect(skillLocalesSchema.safeParse(value).success).toBe(false);
    }
  });

  it("lays typed languages over a skill's own, per language and per field", () => {
    expect(
      layerSkillLocales(
        {
          "zh-CN": { name: "会说话的角色", description: "让角色开口说一句话" },
          ja: { name: "しゃべるキャラクター" },
        },
        { "zh-CN": { name: "开口说话" }, ko: { description: "캐릭터가 말합니다" }, de: {} }
      )
    ).toEqual({
      "zh-CN": { name: "开口说话", description: "让角色开口说一句话" },
      ko: { description: "캐릭터가 말합니다" },
      ja: { name: "しゃべるキャラクター" },
    });
    expect(layerSkillLocales({}, {})).toEqual({});
  });

  it("rejects traversal, duplicate files, and executable reference files", () => {
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "../secret", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "SKILL.md/hidden", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "references/checklist.md", content: "one" },
          { path: "references/checklist.md", content: "two" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "references/checklist.md", content: "x", executable: true }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "scripts", content: "not a directory" },
          { path: "scripts/run.sh", content: "#!/bin/sh" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "invalid \ud800 Unicode",
      }).success
    ).toBe(false);
  });

  it("normalizes omitted content collections and all-session selection", () => {
    const skill = createSkillInputSchema.parse({
      name: "acme-review",
      content: { description: "Review code", body: "Review it." },
    });
    expect(skill.assignments).toEqual([]);
    expect(skill.content.files).toEqual([]);
    expect(skill.content.metadata).toEqual({});
    expect(sessionSkillSelectionSchema.parse({ mode: "all" })).toEqual({ mode: "all" });
  });

  it("bounds repository resolution previews to the session repository contract", () => {
    const repositories = Array.from({ length: MAX_TARGET_REPOSITORIES + 1 }, (_, index) => ({
      repoOwner: "acme",
      repoName: `repo-${index}`,
    }));
    expect(skillResolutionPreviewInputSchema.safeParse({ repositories }).success).toBe(false);
  });

  it("requires a cursor exactly when another skill catalog page exists", () => {
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: false, nextCursor: null }).success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: "next-skill" })
        .success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: null }).success
    ).toBe(false);
  });

  it("defaults missing import provenance for rolling response compatibility", () => {
    const summary = skillSummarySchema.parse({
      id: "skill-1",
      name: "acme-review",
      description: "Review code",
      enabled: true,
      currentRevisionId: "revision-1",
      revisionNumber: 1,
      revisionSha256: "a".repeat(64),
      revisionCreatedBy: "user-1",
      creatorDisplayName: null,
      lastEditorDisplayName: null,
      revisionAuthorDisplayName: null,
      assignments: [],
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(summary.source).toBeNull();
  });

  it("requires confirmation of the complete previewed revision", () => {
    const input = {
      source: { repository: { repoOwner: "acme", repoName: "skills" } },
      expectedCommitSha: "a".repeat(40),
      expectedSourceSha256: "b".repeat(64),
    };

    expect(importSkillInputSchema.safeParse(input).success).toBe(false);
    expect(
      importSkillInputSchema.safeParse({ ...input, expectedRevisionSha256: "c".repeat(64) }).success
    ).toBe(true);
  });

  it("validates persisted import provenance invariants", () => {
    const source = {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "main",
      resolvedRef: "main",
      commitSha: "a".repeat(40),
      subdirectory: "skills/deploy",
      sourceSha256: "b".repeat(64),
    };

    expect(skillImportSourceSchema.safeParse(source).success).toBe(true);
    expect(skillImportSourceSchema.safeParse({ ...source, provider: "unknown" }).success).toBe(
      false
    );
    expect(skillImportSourceSchema.safeParse({ ...source, commitSha: "not-a-sha" }).success).toBe(
      false
    );
    expect(
      skillImportSourceSchema.safeParse({ ...source, subdirectory: "../deploy" }).success
    ).toBe(false);
  });

  it("updates a library skill's switch or its cover choice, never both", () => {
    const art = { gesture: "ripple", base: "half", seed: 4821 };
    for (const body of [
      { enabled: false },
      { art },
      { art: { gesture: "ripple" } },
      { art: null },
    ]) {
      expect(updateMySkillInputSchema.parse(body)).toEqual(body);
    }
    for (const body of [
      {},
      { enabled: true, art },
      { art: { gesture: "" } },
      { art: { gesture: "x".repeat(MAX_SKILL_ART_GESTURE_LENGTH + 1) } },
      { art: { gesture: "ripple", base: "wet" } },
      { art: { gesture: "ripple", seed: 0 } },
      { art: { gesture: "ripple", seed: 1.5 } },
      { art: { gesture: "ripple", seed: MAX_SKILL_ART_SEED + 1 } },
      { art: { gesture: "ripple", image: "cover.webp" } },
    ]) {
      expect(updateMySkillInputSchema.safeParse(body).success).toBe(false);
    }
  });
});
