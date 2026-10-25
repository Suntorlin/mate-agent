/**
 * The skills baked into the sandbox image, as the Skills page shows them.
 *
 * The image copies skills/builtin/* into every session; this module mirrors those
 * files (see builtin-skills.generated.ts) so the control plane can list and
 * show them, validate a user's on/off choice, and keep personal skills from
 * taking their names.
 */

import { BUILTIN_SKILL_KEY_PREFIX } from "@open-inspect/shared/types/skills";
import { BUILTIN_SKILL_SOURCES, type BuiltinSkillSource } from "./builtin-skills.generated";

/** One line a user reads on the Skills page; the agent reads the full description. */
const TAGLINES: Record<string, string> = {
  "viral-remake": "Remake a viral short's structure and motion for your own brief.",
  "ad-variants": "Turns one finished ad into hooks, headlines and sizes to test, in one batch.",
  "long-scroll-film": "A 30–60 s walk-through-the-eras film drawn in code, with voices.",
  "product-video": "A 10–30 s product video with voice-over from your real product photos.",
  blender: "3D renders, animations and model conversions with headless Blender.",
  "media-edit":
    "Captions, silence cuts, vertical reframes, beat cuts and clean audio for your footage.",
  memory: "Remembers your preferences and what worked.",
  preview: "Shows drafts and finished cuts next to the chat.",
  "save-as-skill": "Turns a finished session into a skill of your own.",
  "faceless-explainer":
    "Explainer videos with no one on camera: type, diagrams, motion and a voice-over. By HeyGen.",
};

/**
 * Platform plumbing: always installed, never listed or switchable. Users reach
 * these through the product itself (Memory page, preview pane, the "Save as skill"
 * button), not as tools they pick.
 */
const PLATFORM_SKILLS = new Set(["memory", "preview", "save-as-skill", "save-workflow"]);

/**
 * HyperFrames (HeyGen) skills that faceless-explainer reads: installed with it, never listed or
 * switched on their own. Switching faceless-explainer off is enough, as nothing else starts them.
 */
const HYPERFRAMES_SUPPORT_SKILLS = new Set([
  "hyperframes",
  "hyperframes-animation",
  "hyperframes-cli",
  "hyperframes-core",
  "hyperframes-creative",
  "media-use",
]);

/** Installed, but not something a user picks: off the Skills page and always on. */
const UNLISTED_SKILLS = new Set([...PLATFORM_SKILLS, ...HYPERFRAMES_SUPPORT_SKILLS]);

/** Always on: what is not listed cannot be switched. */
const ALWAYS_ON: ReadonlySet<string> = UNLISTED_SKILLS;

/**
 * Skills the runtime bundles for coding work. They stay installed and are not
 * shown to users, but personal skills may not take their names either.
 */
const RUNTIME_SKILL_NAMES = [
  "agent-browser",
  "record-video",
  "upload-screenshot",
  "visual-verification",
];

export interface BuiltinSkill extends BuiltinSkillSource {
  key: string;
  tagline: string;
  toggleable: boolean;
  /** Shown on the Skills page; platform skills are not. */
  listed: boolean;
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = BUILTIN_SKILL_SOURCES.map((source) => ({
  ...source,
  key: `${BUILTIN_SKILL_KEY_PREFIX}${source.name}`,
  tagline: TAGLINES[source.name] ?? source.description,
  toggleable: !ALWAYS_ON.has(source.name),
  listed: !UNLISTED_SKILLS.has(source.name),
}));

/** Names a personal skill cannot take: they would collide with what the image installs. */
export const BUNDLED_SKILL_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_SKILL_SOURCES.map((source) => source.name),
  ...RUNTIME_SKILL_NAMES,
]);

/** The built-ins a user sees on the Skills page. */
export const LISTED_BUILTIN_SKILLS: readonly BuiltinSkill[] = BUILTIN_SKILLS.filter(
  (skill) => skill.listed
);

export function builtinSkillByKey(key: string): BuiltinSkill | null {
  return BUILTIN_SKILLS.find((skill) => skill.key === key) ?? null;
}

/**
 * Built-in names a user's disabled preference keys switch off, ignoring always-on skills.
 * Switching faceless-explainer off also takes the HyperFrames skills it reads out of the session:
 * left in, the agent would build an explainer with them directly, around the switch.
 */
export function disabledBuiltinNames(disabledKeys: Iterable<string>): string[] {
  const keys = new Set(disabledKeys);
  const names = BUILTIN_SKILLS.filter((skill) => skill.toggleable && keys.has(skill.key)).map(
    (skill) => skill.name
  );
  if (names.includes("faceless-explainer")) names.push(...HYPERFRAMES_SUPPORT_SKILLS);
  return names.sort();
}
