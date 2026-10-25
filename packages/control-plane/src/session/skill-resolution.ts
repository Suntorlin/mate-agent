import {
  BUILTIN_SKILL_KEY_PREFIX,
  MAX_MANAGED_SKILL_MANIFEST_BYTES,
  type ResolvedSkill,
  type SessionSkillManifestSelection,
  type SessionSkillSelection,
} from "@open-inspect/shared/types/skills";
import { UserSkillPreferenceStore } from "../db/personal-skills";
import { SkillProfileStore } from "../db/skill-profiles";
import { BUILTIN_SKILLS, disabledBuiltinNames } from "../skills/builtin-skills";
import { SkillStore } from "../db/skills";
import type { SqlDatabase } from "../db/sql-database";
import { hashSessionSkillManifest, SKILL_RESOLVER_VERSION } from "../skills/content-addressing";

const MAX_CATALOG_READ_ATTEMPTS = 3;

/** Immutable resolver output persisted with a session before sandbox creation. */
export interface SessionSkillManifestInput {
  selection: SessionSkillManifestSelection;
  resolverVersion: number;
  manifestSha256: string;
  resolvedAt: number;
  skills: ResolvedSkill[];
  ignoredProfileSkillIds?: string[];
  /** Image-bundled skills the session owner switched off; not part of the digest. */
  disabledBundledSkills?: string[];
}

interface SkillResolutionTarget {
  repositories: readonly { repoOwner: string; repoName: string }[];
  environmentId: string | null;
}

interface SkillResolutionOptions {
  /** False for unattended runs: no personal skills or switches. */
  personal?: boolean;
  /**
   * `/my-skills` keys the creator ticked for this session. When given they
   * replace `selection` and the owner's switches: switchable built-ins not
   * named are off, and exactly the named shared and own skills are pinned.
   */
  skillKeys?: readonly string[];
}

/**
 * Resolve the mutable catalog into a deterministic session snapshot. Generation
 * checks retry concurrent catalog changes so the returned digest never mixes
 * rows from different catalog states.
 */
export async function resolveManagedSkills(
  db: SqlDatabase,
  target: SkillResolutionTarget,
  selection: SessionSkillSelection,
  canonicalUserId: string | null,
  options: SkillResolutionOptions = {}
): Promise<SessionSkillManifestInput> {
  // Personal skills and switches belong to interactive sessions of their owner.
  const personalOwner = options.personal === false ? null : canonicalUserId;
  const skills = new SkillStore(db);
  const profiles = new SkillProfileStore(db);
  const picked = options.skillKeys && splitSkillKeys(options.skillKeys);

  let disabledBundledSkills: string[] = [];
  if (picked) {
    disabledBundledSkills = disabledBuiltinNames(
      BUILTIN_SKILLS.map((skill) => skill.key).filter((key) => !picked.builtinKeys.has(key))
    );
  } else if (personalOwner) {
    disabledBundledSkills = disabledBuiltinNames(
      await new UserSkillPreferenceStore(db).disabledKeys(personalOwner)
    );
  }

  for (let attempt = 0; attempt < MAX_CATALOG_READ_ATTEMPTS; attempt++) {
    const generationBefore = await skills.catalogGeneration();
    // The owner's personal skills join the shared ones; the owner's switches
    // drop shared skills they turned off.
    const applicable = await skills.listApplicable(
      target,
      personalOwner,
      picked ? new Set(picked.skillIds) : null
    );
    let manifestSelection: SessionSkillManifestSelection;
    let selectedIds: Set<string> | null;
    if (picked) {
      manifestSelection = { mode: "ids", skillIds: picked.skillIds };
      selectedIds = new Set(picked.skillIds);
    } else if (selection.mode === "profile") {
      if (!canonicalUserId)
        throw new SkillResolutionError("A canonical user is required for profiles", 403);
      const profile = await profiles.getOwned(selection.profileId, canonicalUserId);
      if (!profile) throw new SkillResolutionError("Skill profile not found", 404);
      manifestSelection = {
        mode: "profile",
        profileId: profile.id,
        profileName: profile.name,
      };
      selectedIds = new Set(profile.skillIds);
    } else if (selection.mode === "ids") {
      // Deduplicated and sorted so equal selections hash to equal manifests.
      const skillIds = [...new Set(selection.skillIds)].sort();
      manifestSelection = { mode: "ids", skillIds };
      selectedIds = new Set(skillIds);
    } else {
      manifestSelection = selection;
      selectedIds = selection.mode === "none" ? new Set() : null;
    }

    // Profiles filter the already-applicable set; membership never bypasses
    // disabled state or repository/environment assignment scope.
    const resolved = applicable
      .filter((skill) => selectedIds === null || selectedIds.has(skill.id))
      .map<ResolvedSkill>((skill) => ({
        skillId: skill.id,
        revisionId: skill.currentRevisionId,
        name: skill.name,
        description: skill.description,
        revisionNumber: skill.revisionNumber,
        revisionSha256: skill.revisionSha256,
        totalBytes: skill.totalBytes,
        assignmentSources: skill.assignments,
      }));
    const applicableIds = new Set(applicable.map((skill) => skill.id));
    const ignoredProfileSkillIds =
      selectedIds === null ? [] : [...selectedIds].filter((id) => !applicableIds.has(id)).sort();
    const generationAfter = await skills.catalogGeneration();
    if (generationBefore !== generationAfter) continue;
    enforceManifestLimits(resolved);

    return {
      selection: manifestSelection,
      resolverVersion: SKILL_RESOLVER_VERSION,
      manifestSha256: await hashSessionSkillManifest(manifestSelection, resolved),
      resolvedAt: Date.now(),
      skills: resolved,
      ignoredProfileSkillIds,
      disabledBundledSkills,
    };
  }
  throw new SkillResolutionError("Managed skills catalog changed during resolution", 409);
}

/**
 * Split `/my-skills` keys into built-in keys and catalog skill ids, the latter
 * deduplicated and sorted so equal picks hash to equal manifests.
 */
function splitSkillKeys(keys: readonly string[]): {
  builtinKeys: Set<string>;
  skillIds: string[];
} {
  const builtinKeys = new Set<string>();
  const skillIds = new Set<string>();
  for (const key of keys) {
    if (key.startsWith(BUILTIN_SKILL_KEY_PREFIX)) builtinKeys.add(key);
    else skillIds.add(key);
  }
  return { builtinKeys, skillIds: [...skillIds].sort() };
}

/**
 * Manifest size is bounded by total content bytes, not skill count. A count cap
 * would gate the whole installation on a per-session limit: assignments are
 * additive and global ones apply everywhere, so exceeding it failed every
 * session create and automation run at once.
 */
function enforceManifestLimits(skills: ResolvedSkill[]): void {
  const totalBytes = skills.reduce((total, skill) => total + skill.totalBytes, 0);
  if (totalBytes > MAX_MANAGED_SKILL_MANIFEST_BYTES) {
    throw new SkillResolutionError("Managed skill selection exceeds the content size limit", 400);
  }
}

export class SkillResolutionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
