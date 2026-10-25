/**
 * Turn an uploaded skill directory — a lone SKILL.md, the files of a zip, a
 * folder read from a link, or what the agent saved from a session — into
 * validated managed-skill content for its owner's library.
 */

import {
  MAX_SKILL_DISPLAY_NAME_LENGTH,
  MAX_SKILL_FILES,
  MAX_SKILL_REVISION_BYTES,
  RESERVED_SKILL_NAME_WORDS,
  SKILL_DISPLAY_NAME_METADATA_KEY,
  skillFileInputSchema,
  skillNameSchema,
  type PersonalSkillFileInput,
  type SkillContentInput,
  type SkillFileInput,
} from "@open-inspect/shared/types/skills";
import { BUNDLED_SKILL_NAMES } from "./builtin-skills";
import { mapFrontmatter, SkillImportError } from "./git-import";

const IGNORED_SEGMENTS = new Set(["__MACOSX", ".DS_Store", ".git", "__pycache__"]);
const utf8 = new TextEncoder();

export interface ParsedSkillUpload {
  name: string;
  content: SkillContentInput;
}

/** Drop OS litter, and the single top folder a zipped skill directory carries. */
export function normalizeUploadPaths(files: PersonalSkillFileInput[]): PersonalSkillFileInput[] {
  const kept = files.filter(
    (file) => !file.path.split("/").some((part) => IGNORED_SEGMENTS.has(part))
  );
  if (kept.some((file) => file.path === "SKILL.md")) return kept;
  const tops = new Set(kept.map((file) => file.path.split("/")[0]));
  if (tops.size === 1) {
    const [top] = tops;
    if (kept.some((file) => file.path === `${top}/SKILL.md`)) {
      return kept.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
    }
  }
  return kept;
}

/** Why a name cannot be a personal skill's, or null when it can. */
export function personalSkillNameProblem(name: string): string | null {
  if (!skillNameSchema.safeParse(name).success) {
    return `"${name}" is not a valid skill name: use lowercase letters, numbers and single hyphens, at most 64 characters`;
  }
  const reserved = RESERVED_SKILL_NAME_WORDS.find((word) => name.includes(word));
  if (reserved) return `Skill names cannot contain "${reserved}"`;
  if (BUNDLED_SKILL_NAMES.has(name)) return `${name} is a built-in skill; choose another name`;
  return null;
}

/** Why a display name cannot be shown as a skill's, or null when it can. */
export function skillDisplayNameProblem(displayName: string): string | null {
  if (/[\r\n]/.test(displayName)) return "A skill's display name must be one line";
  if (Array.from(displayName.trim()).length > MAX_SKILL_DISPLAY_NAME_LENGTH) {
    return `A skill's display name can be at most ${MAX_SKILL_DISPLAY_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate an uploaded directory and map its SKILL.md frontmatter.
 *
 * @throws SkillImportError (status 400) naming what is wrong.
 */
export function parseSkillUpload(input: PersonalSkillFileInput[]): ParsedSkillUpload {
  const files = normalizeUploadPaths(input);
  const markdown = files.find((file) => file.path === "SKILL.md");
  if (!markdown) throw new SkillImportError("A skill needs a SKILL.md at its top level", 400);
  if (files.length > MAX_SKILL_FILES) {
    throw new SkillImportError(`A skill can hold at most ${MAX_SKILL_FILES} files`, 400);
  }
  const totalBytes = files.reduce((total, file) => total + utf8.encode(file.content).byteLength, 0);
  if (totalBytes > MAX_SKILL_REVISION_BYTES) {
    throw new SkillImportError(
      `A skill can hold at most ${MAX_SKILL_REVISION_BYTES / 1024 / 1024} MB of text`,
      400
    );
  }

  const supporting: SkillFileInput[] = [];
  for (const file of files) {
    if (file.path === "SKILL.md") continue;
    const parsed = skillFileInputSchema.safeParse({
      ...file,
      // Only scripts may run; anything else marked executable is just a file.
      executable: file.executable && file.path.startsWith("scripts/"),
    });
    if (!parsed.success) {
      throw new SkillImportError(
        `${file.path}: ${parsed.error.issues[0]?.message ?? "invalid file"}`,
        400
      );
    }
    supporting.push(parsed.data);
  }

  const mapped = mapFrontmatter(markdown.content, supporting);
  if (!mapped.frontmatterName) {
    throw new SkillImportError("SKILL.md frontmatter needs a name", 400);
  }
  const problem = personalSkillNameProblem(mapped.frontmatterName);
  if (problem) throw new SkillImportError(problem, 400);
  const displayName = mapped.content.metadata[SKILL_DISPLAY_NAME_METADATA_KEY];
  const displayProblem = displayName === undefined ? null : skillDisplayNameProblem(displayName);
  if (displayProblem) throw new SkillImportError(displayProblem, 400);
  return { name: mapped.frontmatterName, content: mapped.content };
}
