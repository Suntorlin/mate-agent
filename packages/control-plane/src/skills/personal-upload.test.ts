import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { skillLocalesFromMetadata } from "@open-inspect/shared/types/skills";
import { describe, expect, it } from "vitest";
import {
  normalizeUploadPaths,
  parseSkillUpload,
  personalSkillNameProblem,
  skillDisplayNameProblem,
} from "./personal-upload";

const markdown = "---\nname: cafe-ad\ndescription: A cafe ad. Use for cafes.\n---\n\n# Cafe\n";
const file = (path: string, content = "x", executable = false) => ({ path, content, executable });

describe("personal skill uploads", () => {
  it("strips the single top folder of a zipped skill and OS litter", () => {
    expect(
      normalizeUploadPaths([
        file("cafe-ad/SKILL.md", markdown),
        file("cafe-ad/scripts/a.sh"),
        file("__MACOSX/cafe-ad/._a.sh"),
        file("cafe-ad/.DS_Store"),
      ]).map((entry) => entry.path)
    ).toEqual(["SKILL.md", "scripts/a.sh"]);
    expect(
      normalizeUploadPaths([file("SKILL.md", markdown), file("x/y.md")]).map((entry) => entry.path)
    ).toEqual(["SKILL.md", "x/y.md"]);
  });

  it("maps frontmatter and keeps only scripts executable", () => {
    const parsed = parseSkillUpload([
      file("SKILL.md", markdown),
      file("scripts/cut.sh", "#!/bin/sh\n", true),
      file("references/notes.md", "n", true),
    ]);
    expect(parsed.name).toBe("cafe-ad");
    expect(parsed.content.description).toBe("A cafe ad. Use for cafes.");
    expect(parsed.content.files).toEqual([
      { path: "scripts/cut.sh", content: "#!/bin/sh\n", executable: true },
      { path: "references/notes.md", content: "n", executable: false },
    ]);
  });

  it("keeps the name the creator gave it beside the slug", () => {
    const parsed = parseSkillUpload([
      file(
        "SKILL.md",
        "---\nname: koubo-oneclick\ndescription: d\nmetadata:\n  display_name: 口播一键出片\n---\nbody"
      ),
    ]);
    expect(parsed.name).toBe("koubo-oneclick");
    expect(parsed.content.metadata).toEqual({ display_name: "口播一键出片" });
    expect(skillDisplayNameProblem("口播一键出片")).toBeNull();
    expect(skillDisplayNameProblem("一\n二")).toMatch(/one line/);
    expect(skillDisplayNameProblem("长".repeat(64))).toBeNull();
    expect(skillDisplayNameProblem("长".repeat(65))).toMatch(/at most 64/);
    expect(() =>
      parseSkillUpload([
        file(
          "SKILL.md",
          `---\nname: x-y\ndescription: d\nmetadata:\n  display_name: "${"长".repeat(65)}"\n---\n`
        ),
      ])
    ).toThrow(/display name/);
  });

  it("reads the names and one-liners save-as-skill writes for other languages", () => {
    // The frontmatter the save-as-skill instructions show, comment line and all.
    const saved = readFileSync(
      fileURLToPath(
        new URL("../../../../skills/builtin/save-as-skill/SKILL.md", import.meta.url).href
      ),
      "utf8"
    );
    const example = saved.match(/```markdown\n(---\nname: product-ad-15s[\s\S]*?\n---\n)/)?.[1];
    const parsed = parseSkillUpload([file("SKILL.md", `${example}\nbody`)]);
    expect(skillLocalesFromMetadata(parsed.content.metadata)).toEqual({
      "zh-CN": { description: "一张产品图，做成 15 秒竖版广告" },
      en: {
        name: "15-second product ad",
        description: "A 15-second vertical ad from one product photo",
      },
      ja: { name: "15秒の商品広告", description: "商品写真1枚から15秒の縦型広告を作る" },
    });
  });

  it("explains what is wrong", () => {
    expect(() => parseSkillUpload([file("README.md")])).toThrow(/SKILL\.md at its top level/);
    expect(() => parseSkillUpload([file("SKILL.md", "---\ndescription: d\n---\nbody")])).toThrow(
      /needs a name/
    );
    expect(() =>
      parseSkillUpload(
        Array.from({ length: 101 }, (_, index) =>
          file(index ? `f${index}.md` : "SKILL.md", markdown)
        )
      )
    ).toThrow(/at most 100 files/);
  });

  it("follows the Agent Skills naming rules and keeps built-in names", () => {
    expect(personalSkillNameProblem("cafe-ad")).toBeNull();
    expect(personalSkillNameProblem("my-claude-tool")).toMatch(/claude/);
    expect(personalSkillNameProblem("anthropic")).toMatch(/anthropic/);
    expect(personalSkillNameProblem("preview")).toMatch(/built-in/);
    expect(personalSkillNameProblem("agent-browser")).toMatch(/built-in/);
    expect(personalSkillNameProblem("Cafe Ad")).toMatch(/not a valid/);
    expect(personalSkillNameProblem("a".repeat(65))).toMatch(/not a valid/);
  });
});
