import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { MySkill, MySkillDetail } from "@open-inspect/shared/types/skills";
import { SessionIndexStore } from "../../src/db/session-index";
import { PersonalSkillStore, UserSkillPreferenceStore } from "../../src/db/personal-skills";
import { SessionSkillStore } from "../../src/db/session-skills";
import { SkillStore } from "../../src/db/skills";
import { resolveManagedSkills } from "../../src/session/skill-resolution";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, queryDO, seedSandboxAuthHash, serviceFetch } from "./helpers";

const USER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const asA = { as: { userId: USER_A, role: "member" as const } };
const asB = { as: { userId: USER_B, role: "member" as const } };

function skillMarkdown(name: string, description = "Make a 15-second cafe ad. Use for cafes.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThree shots.\n`;
}

async function save(
  user: typeof asA,
  files: { path: string; content: string; executable?: boolean }[],
  replace = false
) {
  return serviceFetch("https://test.local/my-skills", {
    method: "POST",
    body: JSON.stringify({ files, replace }),
    ...user,
  });
}

async function list(user: typeof asA): Promise<MySkill[]> {
  const response = await serviceFetch("https://test.local/my-skills", user);
  expect(response.status).toBe(200);
  return ((await response.json()) as { skills: MySkill[] }).skills;
}

async function patch(user: typeof asA, key: string, body: unknown) {
  return serviceFetch(`https://test.local/my-skills/${key}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    ...user,
  });
}

const noTarget = { repositories: [], environmentId: null };

describe("personal skills", () => {
  beforeEach(cleanD1Tables);

  it("keeps a user's skills private to that user", async () => {
    const created = await save(asA, [
      { path: "SKILL.md", content: skillMarkdown("cafe-ad") },
      { path: "scripts/cut.sh", content: "#!/bin/sh\necho cut\n", executable: true },
    ]);
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: MySkill };
    expect(skill).toMatchObject({ kind: "own", name: "cafe-ad", enabled: true, toggleable: true });

    const mine = await list(asA);
    expect(mine.filter((item) => item.kind === "own").map((item) => item.name)).toEqual([
      "cafe-ad",
    ]);
    expect(mine.filter((item) => item.kind === "builtin").map((item) => item.name)).toContain(
      "viral-remake"
    );
    expect((await list(asB)).some((item) => item.kind === "own")).toBe(false);

    const detail = await serviceFetch(`https://test.local/my-skills/${skill.key}`, asA);
    const body = (await detail.json()) as { skill: MySkillDetail };
    expect(body.skill.markdown).toContain("name: cafe-ad");
    expect(body.skill.files).toEqual([{ path: "scripts/cut.sh", sizeBytes: 19 }]);

    for (const [method, payload] of [
      ["GET", undefined],
      ["PATCH", JSON.stringify({ enabled: false })],
      ["DELETE", undefined],
    ] as const) {
      const response = await serviceFetch(`https://test.local/my-skills/${skill.key}`, {
        method,
        body: payload,
        ...asB,
      });
      expect(response.status).toBe(404);
    }

    // The administrators' catalog never lists or opens personal skills.
    const adminList = await serviceFetch("https://test.local/skills");
    expect(((await adminList.json()) as { skills: unknown[] }).skills).toEqual([]);
    expect((await serviceFetch(`https://test.local/skills/${skill.key}`)).status).toBe(404);

    const resolvedA = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A);
    const resolvedB = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_B);
    expect(resolvedA.skills.map((item) => item.name)).toEqual(["cafe-ad"]);
    expect(resolvedB.skills).toEqual([]);
    const automation = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A, {
      personal: false,
    });
    expect(automation.skills).toEqual([]);

    // Two users may each own a skill of the same name.
    expect(
      (await save(asB, [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }])).status
    ).toBe(201);
  });

  it("replaces only on request, and deleting frees the name", async () => {
    const first = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("brand-intro") }]);
    const { skill } = (await first.json()) as { skill: MySkill };
    const conflict = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("brand-intro") }]);
    expect(conflict.status).toBe(409);

    const replaced = await save(
      asA,
      [{ path: "SKILL.md", content: skillMarkdown("brand-intro", "A five second logo sting.") }],
      true
    );
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      created: false,
      skill: { key: skill.key, description: "A five second logo sting." },
    });

    const disabled = await serviceFetch(`https://test.local/my-skills/${skill.key}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      ...asA,
    });
    expect(disabled.status).toBe(200);
    expect((await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A)).skills).toEqual(
      []
    );

    const deleted = await serviceFetch(`https://test.local/my-skills/${skill.key}`, {
      method: "DELETE",
      ...asA,
    });
    expect(deleted.status).toBe(200);
    expect((await list(asA)).some((item) => item.kind === "own")).toBe(false);
    const again = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("brand-intro") }]);
    expect(again.status).toBe(201);
  });

  it("validates uploads", async () => {
    const cases: [{ path: string; content: string }[], RegExp][] = [
      [[{ path: "notes.md", content: "hi" }], /SKILL\.md/],
      [[{ path: "SKILL.md", content: "# no frontmatter" }], /frontmatter/],
      [[{ path: "SKILL.md", content: "---\nname: x-y\n---\nbody" }], /description/],
      [[{ path: "SKILL.md", content: skillMarkdown("viral-remake") }], /built-in/],
      [[{ path: "SKILL.md", content: skillMarkdown("claude-helper") }], /claude/],
      [[{ path: "SKILL.md", content: skillMarkdown("Bad_Name") }], /not a valid skill name/],
      [
        [
          {
            path: "SKILL.md",
            content: `---\nname: x-y\ndescription: d\nmetadata:\n  display_name: "${"长".repeat(65)}"\n---\n`,
          },
        ],
        /display name/,
      ],
    ];
    for (const [files, message] of cases) {
      const response = await save(asA, files);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(message);
    }

    // A zip of the skill folder carries one top folder and OS litter.
    const zipped = await save(asA, [
      { path: "cafe-ad/SKILL.md", content: skillMarkdown("cafe-ad") },
      { path: "cafe-ad/references/shots.md", content: "1. door" },
      { path: "__MACOSX/cafe-ad/._SKILL.md", content: "" },
    ]);
    expect(zipped.status).toBe(201);
    const { skill } = (await zipped.json()) as { skill: MySkill };
    const detail = await serviceFetch(`https://test.local/my-skills/${skill.key}`, asA);
    expect(((await detail.json()) as { skill: MySkillDetail }).skill.files).toEqual([
      { path: "references/shots.md", sizeBytes: 7 },
    ]);
  });

  it("switches built-in and shared skills per user and pins them with the session", async () => {
    const shared = await new SkillStore(env.DB).create(
      {
        name: "house-style",
        content: {
          description: "House style",
          body: "# Style\n",
          license: null,
          compatibility: null,
          metadata: {},
          files: [],
        },
        assignments: [{ type: "global" }],
      },
      "admin"
    );
    // A shared name cannot become a personal one.
    expect(
      (await save(asA, [{ path: "SKILL.md", content: skillMarkdown("house-style") }])).status
    ).toBe(409);

    for (const key of ["builtin:viral-remake", shared.id]) {
      const response = await serviceFetch(`https://test.local/my-skills/${key}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        ...asA,
      });
      expect(response.status).toBe(200);
    }

    const mine = await list(asA);
    expect(mine.find((item) => item.key === "builtin:viral-remake")?.enabled).toBe(false);
    expect(mine.find((item) => item.key === shared.id)).toMatchObject({
      kind: "shared",
      enabled: false,
    });
    expect((await list(asB)).find((item) => item.key === "builtin:viral-remake")?.enabled).toBe(
      true
    );

    const manifestA = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A);
    const manifestB = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_B);
    expect(manifestA.skills).toEqual([]);
    expect(manifestA.disabledBundledSkills).toEqual(["viral-remake"]);
    expect(manifestB.skills.map((item) => item.name)).toEqual(["house-style"]);
    expect(manifestB.disabledBundledSkills).toEqual([]);

    const now = Date.now();
    const sessions = new SessionIndexStore(env.DB);
    await sessions.create({
      id: "a-session",
      title: null,
      ownerTeamId: null,
      visibility: "private",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      userId: USER_A,
      createdAt: now,
      updatedAt: now,
      skillManifest: manifestA,
    });
    const installation = await new SessionSkillStore(env.DB).getSandboxInstallation("a-session");
    expect(installation?.disabledBundledSkills).toEqual(["viral-remake"]);
  });

  it("pins the skills a creator ticked for one session over the account's switches", async () => {
    const store = new SkillStore(env.DB);
    const sharedSkill = (name: string) =>
      store.create(
        {
          name,
          content: {
            description: `${name} for everyone`,
            body: `# ${name}\n`,
            license: null,
            compatibility: null,
            metadata: {},
            files: [],
          },
          assignments: [{ type: "global" }],
        },
        "admin"
      );
    const houseStyle = await sharedSkill("house-style");
    await sharedSkill("brand-kit");
    const ownSaved = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }]);
    const own = ((await ownSaved.json()) as { skill: MySkill }).skill;
    const otherSaved = await save(asB, [{ path: "SKILL.md", content: skillMarkdown("secret-ad") }]);
    const othersOwn = ((await otherSaved.json()) as { skill: MySkill }).skill;
    // On the account, A switched off its own skill, a shared one and a built-in.
    for (const key of [own.key, houseStyle.id, "builtin:media-edit"]) {
      expect((await patch(asA, key, { enabled: false })).status).toBe(200);
    }

    // Without keys, the account's switches decide, as before.
    const account = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A);
    expect(account.selection).toEqual({ mode: "all" });
    expect(account.skills.map((item) => item.name)).toEqual(["brand-kit"]);
    expect(account.disabledBundledSkills).toEqual(["media-edit"]);

    // With keys, exactly the ticked skills: switched-off ones included, another
    // user's private skill never.
    const pickedKeys = [othersOwn.key, own.key, houseStyle.id, own.key];
    const picked = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A, {
      skillKeys: [...pickedKeys, "builtin:media-edit", "builtin:viral-remake"],
    });
    expect(picked.skills.map((item) => item.name)).toEqual(["cafe-ad", "house-style"]);
    expect(picked.selection).toEqual({
      mode: "ids",
      skillIds: [...new Set(pickedKeys)].sort(),
    });
    expect(picked.ignoredProfileSkillIds).toEqual([othersOwn.key]);
    // Unticked switchable built-ins are off, the HyperFrames skills follow
    // faceless-explainer, and the always-on platform skills stay although unticked.
    expect(picked.disabledBundledSkills).toEqual([
      "ad-variants",
      "blender",
      "faceless-explainer",
      "hyperframes",
      "hyperframes-animation",
      "hyperframes-cli",
      "hyperframes-core",
      "hyperframes-creative",
      "long-scroll-film",
      "media-use",
      "product-video",
    ]);

    const explainer = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A, {
      skillKeys: ["builtin:faceless-explainer"],
    });
    expect(explainer.skills).toEqual([]);
    expect(explainer.disabledBundledSkills).toEqual([
      "ad-variants",
      "blender",
      "long-scroll-film",
      "media-edit",
      "product-video",
      "viral-remake",
    ]);

    // B cannot pick A's private skill either.
    const byB = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_B, {
      skillKeys: [own.key],
    });
    expect(byB.skills).toEqual([]);
    expect(byB.ignoredProfileSkillIds).toEqual([own.key]);

    // The pick is pinned with the session.
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: "picked-session",
      title: null,
      ownerTeamId: null,
      visibility: "private",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      userId: USER_A,
      createdAt: now,
      updatedAt: now,
      skillManifest: picked,
    });
    const sessionSkills = new SessionSkillStore(env.DB);
    const installation = await sessionSkills.getSandboxInstallation("picked-session");
    expect(installation?.skills.map((item) => item.name)).toEqual(["cafe-ad", "house-style"]);
    expect(installation?.disabledBundledSkills).toEqual(picked.disabledBundledSkills);
    expect((await sessionSkills.getSessionSkillsView("picked-session"))?.selection).toEqual(
      picked.selection
    );
  });

  it("stores a cover choice on the caller's own skill, apart from its versions", async () => {
    const created = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }]);
    const { skill } = (await created.json()) as { skill: MySkill };
    expect(skill.art).toBeNull();
    expect((await patch(asA, skill.key, { enabled: false })).status).toBe(200);
    const switchedOff = (await list(asA)).find((item) => item.key === skill.key);
    expect(switchedOff).toMatchObject({ enabled: false, art: null });

    const art = { gesture: "ripple", base: "half", seed: 4821 };
    const chosen = await patch(asA, skill.key, { art });
    expect(chosen.status).toBe(200);
    // Choosing a cover neither switches the skill back on nor reorders the library.
    await expect(chosen.json()).resolves.toEqual({ skill: { ...switchedOff, art } });
    expect((await list(asA)).find((item) => item.key === skill.key)).toEqual({
      ...switchedOff,
      art,
    });
    const detail = await serviceFetch(`https://test.local/my-skills/${skill.key}`, asA);
    expect(((await detail.json()) as { skill: MySkillDetail }).skill.art).toEqual(art);
    const store = new PersonalSkillStore(env.DB);
    expect((await store.get(skill.key, USER_A))?.revisionNumber).toBe(1);

    // New content is a new version of the same skill; the cover stays.
    const replaced = await save(
      asA,
      [{ path: "SKILL.md", content: skillMarkdown("cafe-ad", "Now four shots.") }],
      true
    );
    await expect(replaced.json()).resolves.toMatchObject({
      created: false,
      skill: { key: skill.key, description: "Now four shots.", art },
    });
    expect((await store.get(skill.key, USER_A))?.revisionNumber).toBe(2);

    for (const body of [
      {},
      { enabled: true, art },
      { art: { gesture: "" } },
      { art: { gesture: "ripple", seed: 0 } },
      { art: { gesture: "ripple", image: "cover.webp" } },
    ]) {
      expect((await patch(asA, skill.key, body)).status).toBe(400);
    }
    expect((await list(asA)).find((item) => item.key === skill.key)?.art).toEqual(art);

    const cleared = await patch(asA, skill.key, { art: null });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ skill: { key: skill.key, art: null } });
    expect((await list(asA)).find((item) => item.key === skill.key)?.art).toBeNull();
  });

  it("refuses a cover choice for a skill the caller does not own", async () => {
    const created = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }]);
    const { skill } = (await created.json()) as { skill: MySkill };
    const shared = await new SkillStore(env.DB).create(
      {
        name: "house-style",
        content: { description: "House style", body: "# Style\n", metadata: {}, files: [] },
        assignments: [{ type: "global" }],
      },
      "admin"
    );
    const art = { gesture: "ripple" };

    for (const key of ["builtin:viral-remake", shared.id]) {
      expect((await patch(asA, key, { art })).status).toBe(403);
      expect((await patch(asA, key, { art: null })).status).toBe(403);
    }
    // Someone else's skill is not there at all.
    expect((await patch(asB, skill.key, { art })).status).toBe(404);
    expect((await list(asA)).every((item) => item.art === null)).toBe(true);
  });

  it("lets the owner pick an image or video of their own as the example output, or clear it", async () => {
    const created = await save(asA, [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }]);
    const { skill } = (await created.json()) as { skill: MySkill };
    const now = Date.now();
    const sessions = new SessionIndexStore(env.DB);
    for (const [id, userId] of [
      ["mine", USER_A],
      ["theirs", USER_B],
    ] as const) {
      await sessions.create({
        id,
        title: null,
        ownerTeamId: null,
        visibility: "private",
        repoOwner: null,
        repoName: null,
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        userId,
        createdAt: now,
        updatedAt: now,
      });
      const { stub } = await initNamedSessionDO(id);
      for (const [artifactId, type] of [
        ["still", "screenshot"],
        ["clip", "video"],
        ["notes", "file"],
      ]) {
        await queryDO(
          stub,
          "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          artifactId,
          type,
          `sessions/${id}/media/${artifactId}`,
          null,
          now,
          now
        );
      }
    }
    for (const userId of [USER_A, USER_B]) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
        .bind(userId, "Creator", now, now)
        .run();
    }
    await env.DB.batch(
      [
        ["photo", USER_A, "image", "ready"],
        ["half-sent", USER_A, "image", "uploading"],
        ["font", USER_A, "font", "ready"],
        ["their-photo", USER_B, "image", "ready"],
      ].map(([id, owner, kind, status]) =>
        env.DB.prepare(
          `INSERT INTO user_files (id, owner_user_id, scope, name, kind, size_bytes, object_key,
               status, part_size_bytes, created_at, updated_at)
             VALUES (?, ?, 'library', 'cover.png', ?, 10, ?, ?, 16, ?, ?)`
        ).bind(id, owner, kind, `users/${owner}/files/${id}`, status, now, now)
      )
    );
    const coverOf = async () => (await list(asA)).find((item) => item.key === skill.key)?.cover;

    const still = await patch(asA, skill.key, {
      cover: { sessionId: "mine", artifactId: "still" },
    });
    expect(still.status).toBe(200);
    await expect(still.json()).resolves.toMatchObject({
      skill: { key: skill.key, cover: { sessionId: "mine", artifactId: "still", kind: "image" } },
    });
    await patch(asA, skill.key, { cover: { sessionId: "mine", artifactId: "clip" } });
    expect(await coverOf()).toEqual({ sessionId: "mine", artifactId: "clip", kind: "video" });

    // The drawn cover stays underneath: choosing one does not touch the example output.
    await patch(asA, skill.key, { art: { gesture: "ripple" } });
    expect(await coverOf()).toEqual({ sessionId: "mine", artifactId: "clip", kind: "video" });

    expect((await patch(asA, skill.key, { cover: { fileId: "photo" } })).status).toBe(200);
    expect(await coverOf()).toEqual({ fileId: "photo", kind: "image" });

    // Someone else's, not media, not there, or not uploaded yet: refused, and nothing changes.
    for (const [cover, status] of [
      [{ sessionId: "theirs", artifactId: "still" }, 404],
      [{ sessionId: "nowhere", artifactId: "still" }, 404],
      [{ sessionId: "mine", artifactId: "missing" }, 404],
      [{ sessionId: "mine", artifactId: "notes" }, 400],
      [{ fileId: "their-photo" }, 404],
      [{ fileId: "half-sent" }, 404],
      [{ fileId: "font" }, 400],
      [{ fileId: "photo", kind: "video" }, 400],
      [{ sessionId: "mine" }, 400],
    ] as const) {
      expect((await patch(asA, skill.key, { cover })).status).toBe(status);
    }
    expect(await coverOf()).toEqual({ fileId: "photo", kind: "image" });
    expect((await patch(asB, skill.key, { cover: { fileId: "their-photo" } })).status).toBe(404);
    expect((await patch(asA, "builtin:viral-remake", { cover: { fileId: "photo" } })).status).toBe(
      403
    );

    const cleared = await patch(asA, skill.key, { cover: null });
    await expect(cleared.json()).resolves.toMatchObject({ skill: { cover: null } });
    expect(await coverOf()).toBeNull();
    expect((await list(asA)).find((item) => item.key === skill.key)?.art).toEqual({
      gesture: "ripple",
    });
  });

  it("returns the names and one-liners a skill's SKILL.md carries in other languages", async () => {
    const markdown = (metadata: string) =>
      `---\nname: cafe-ad\ndescription: Make a 15-second cafe ad.\nmetadata:\n  display_name: Cafe ad\n${metadata}---\n\n# Cafe ad\n`;
    const created = await save(asA, [
      {
        path: "SKILL.md",
        content: markdown(
          [
            "  display_name.zh-CN: 咖啡店广告",
            "  summary.zh-CN: 十五秒的咖啡店广告",
            "  display_name.ja: カフェ広告",
            // Entries that do not fit are left out; the skill is saved all the same.
            "  display_name.Chinese: 咖啡店广告",
            '  summary.ko: "   "',
            `  display_name.de: ${"x".repeat(65)}`,
            `  summary.de: ${"x".repeat(301)}`,
            "",
          ].join("\n")
        ),
      },
    ]);
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: MySkill };
    const locales = {
      "zh-CN": { name: "咖啡店广告", description: "十五秒的咖啡店广告" },
      ja: { name: "カフェ広告" },
    };
    expect(skill).toMatchObject({ displayName: "Cafe ad", locales });

    const shared = await new SkillStore(env.DB).create(
      {
        name: "house-style",
        content: {
          description: "House style",
          body: "# Style\n",
          metadata: { "display_name.zh-CN": "门店风格", "summary.fr": "Le style maison" },
          files: [],
        },
        assignments: [{ type: "global" }],
      },
      "admin"
    );
    const mine = await list(asA);
    expect(mine.find((item) => item.key === skill.key)?.locales).toEqual(locales);
    expect(mine.find((item) => item.key === shared.id)?.locales).toEqual({
      "zh-CN": { name: "门店风格" },
      fr: { description: "Le style maison" },
    });
    // Built-ins carry none: the web names them from its locale files.
    const builtins = mine.filter((item) => item.kind === "builtin");
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((item) => Object.keys(item.locales).length === 0)).toBe(true);
    for (const key of [skill.key, shared.id, "builtin:viral-remake"]) {
      const detail = await serviceFetch(`https://test.local/my-skills/${key}`, asA);
      expect(((await detail.json()) as { skill: MySkillDetail }).skill.locales).toEqual(
        mine.find((item) => item.key === key)?.locales
      );
    }

    // Editing the SKILL.md is how a creator changes them.
    const replaced = await save(
      asA,
      [{ path: "SKILL.md", content: markdown("  display_name.ja: カフェの広告\n") }],
      true
    );
    await expect(replaced.json()).resolves.toMatchObject({
      created: false,
      skill: { key: skill.key, locales: { ja: { name: "カフェの広告" } } },
    });
    const cleared = await save(asA, [{ path: "SKILL.md", content: markdown("") }], true);
    expect(((await cleared.json()) as { skill: MySkill }).skill.locales).toEqual({});
  });

  it("hides platform skills and keeps them installed", async () => {
    const names = (await list(asA)).filter((item) => item.kind === "builtin").map((s) => s.name);
    expect(names).toEqual([
      "ad-variants",
      "blender",
      "faceless-explainer",
      "long-scroll-film",
      "media-edit",
      "product-video",
      "viral-remake",
    ]);

    // Platform plumbing, and the HyperFrames skills faceless-explainer reads.
    for (const name of [
      "memory",
      "preview",
      "save-as-skill",
      "save-workflow",
      "hyperframes",
      "hyperframes-animation",
      "hyperframes-cli",
      "hyperframes-core",
      "hyperframes-creative",
      "media-use",
    ]) {
      const key = `builtin:${name}`;
      expect((await serviceFetch(`https://test.local/my-skills/${key}`, asA)).status).toBe(404);
      const patch = await serviceFetch(`https://test.local/my-skills/${key}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        ...asA,
      });
      expect(patch.status).toBe(404);
      // A switch-off saved before the skill was hidden is ignored.
      await new UserSkillPreferenceStore(env.DB).set(USER_A, key, false);
    }
    const manifest = await resolveManagedSkills(env.DB, noTarget, { mode: "all" }, USER_A);
    expect(manifest.disabledBundledSkills).toEqual([]);
  });

  it("saves what a session made as its owner's skill, from the sandbox", async () => {
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: "made-it",
      title: null,
      ownerTeamId: null,
      visibility: "private",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      userId: USER_A,
      createdAt: now,
      updatedAt: now,
    });
    const { stub } = await initNamedSessionDO("made-it");
    await seedSandboxAuthHash(stub, { authToken: "made-it-token", sandboxId: "sandbox-made-it" });
    const post = (body: unknown, token = "made-it-token") =>
      SELF.fetch("https://test.local/sessions/made-it/saved-skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await post({
      files: [{ path: "SKILL.md", content: skillMarkdown("cafe-ad") }],
      coverArtifactId: "artifact-1",
      coverKind: "video",
    });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      created: true,
      skill: {
        name: "cafe-ad",
        displayName: null,
        cover: { sessionId: "made-it", artifactId: "artifact-1", kind: "video" },
      },
    });

    // Saving again is the latest version; an omitted cover keeps the old one. The name the
    // creator gave it travels in the frontmatter while the slug stays what sessions load.
    const second = await post({
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: cafe-ad\ndescription: Now four shots.\nmetadata:\n  display_name: 口播一键出片\n---\n\n# 口播一键出片\n",
        },
      ],
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      created: false,
      skill: {
        name: "cafe-ad",
        displayName: "口播一键出片",
        description: "Now four shots.",
        cover: { artifactId: "artifact-1" },
      },
    });

    expect((await list(asA)).find((item) => item.kind === "own")).toMatchObject({
      name: "cafe-ad",
      displayName: "口播一键出片",
    });
    expect((await list(asB)).some((item) => item.kind === "own")).toBe(false);
    expect((await post({ files: [] }, "wrong-token")).status).toBe(401);
  });
});
