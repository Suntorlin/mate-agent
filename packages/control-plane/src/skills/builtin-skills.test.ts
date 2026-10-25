import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  BUNDLED_SKILL_NAMES,
  LISTED_BUILTIN_SKILLS,
  builtinSkillByKey,
  disabledBuiltinNames,
} from "./builtin-skills";

const generatedPath = fileURLToPath(new URL("./builtin-skills.generated.ts", import.meta.url).href);
const generatorPath = fileURLToPath(
  new URL("../../../../scripts/gen-builtin-skills.mjs", import.meta.url).href
);

describe("built-in skills", () => {
  it("matches skills/builtin (run node scripts/gen-builtin-skills.mjs)", async () => {
    const generator = (await import(generatorPath)) as {
      buildBuiltinSkills: () => unknown;
      renderBuiltinSkills: (skills: unknown) => string;
    };
    expect(readFileSync(generatedPath, "utf8")).toBe(
      generator.renderBuiltinSkills(generator.buildBuiltinSkills())
    );
  });

  it("lists the built-in skills with a user-facing line and full SKILL.md", () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual([
      "ad-variants",
      "blender",
      "faceless-explainer",
      "hyperframes",
      "hyperframes-animation",
      "hyperframes-cli",
      "hyperframes-core",
      "hyperframes-creative",
      "long-scroll-film",
      "media-edit",
      "media-use",
      "memory",
      "preview",
      "product-video",
      "save-as-skill",
      "save-workflow",
      "viral-remake",
    ]);
    const remake = builtinSkillByKey("builtin:viral-remake");
    expect(remake?.toggleable).toBe(true);
    expect(remake?.markdown.startsWith("---\nname: viral-remake\n")).toBe(true);
    expect(remake?.tagline).not.toContain("\n");
    expect(remake?.files.some((file) => file.path.startsWith("scripts/"))).toBe(true);
    expect(builtinSkillByKey("builtin:memory")?.toggleable).toBe(false);
    expect(builtinSkillByKey("viral-remake")).toBeNull();
  });

  it("hides platform skills and keeps them always on", () => {
    expect(LISTED_BUILTIN_SKILLS.map((skill) => skill.name)).toEqual([
      "ad-variants",
      "blender",
      "faceless-explainer",
      "long-scroll-film",
      "media-edit",
      "product-video",
      "viral-remake",
    ]);
    for (const name of ["memory", "preview", "save-as-skill", "save-workflow"]) {
      const skill = builtinSkillByKey(`builtin:${name}`);
      expect(skill?.listed, name).toBe(false);
      expect(skill?.toggleable, name).toBe(false);
    }
    expect(builtinSkillByKey("builtin:media-edit")?.toggleable).toBe(true);
    expect(
      disabledBuiltinNames(["builtin:memory", "builtin:preview", "builtin:save-as-skill"])
    ).toEqual([]);
  });

  it("hides the HyperFrames skills faceless-explainer reads and lets it be switched off", () => {
    for (const name of [
      "hyperframes",
      "hyperframes-animation",
      "hyperframes-cli",
      "hyperframes-core",
      "hyperframes-creative",
      "media-use",
    ]) {
      const skill = builtinSkillByKey(`builtin:${name}`);
      expect(skill?.listed, name).toBe(false);
      expect(skill?.toggleable, name).toBe(false);
    }
    const faceless = builtinSkillByKey("builtin:faceless-explainer");
    expect(faceless?.listed).toBe(true);
    expect(faceless?.toggleable).toBe(true);
    expect(faceless?.tagline).toContain("HeyGen");
    expect(disabledBuiltinNames(["builtin:hyperframes"])).toEqual([]);
    expect(disabledBuiltinNames(["builtin:faceless-explainer"])).toEqual([
      "faceless-explainer",
      "hyperframes",
      "hyperframes-animation",
      "hyperframes-cli",
      "hyperframes-core",
      "hyperframes-creative",
      "media-use",
    ]);
  });

  it("only lets toggleable built-ins be switched off", () => {
    expect(
      disabledBuiltinNames(["builtin:viral-remake", "builtin:memory", "skill_x", "builtin:nope"])
    ).toEqual(["viral-remake"]);
  });

  it("reserves image and runtime skill names", () => {
    expect(BUNDLED_SKILL_NAMES.has("viral-remake")).toBe(true);
    expect(BUNDLED_SKILL_NAMES.has("agent-browser")).toBe(true);
    expect(BUNDLED_SKILL_NAMES.has("my-ad")).toBe(false);
  });
});
