import type { ArtifactResponse, ArtifactType } from "@open-inspect/shared/types/artifacts";
import {
  sessionCoverTypeSchema,
  type SessionCover,
  type SessionCoverType,
} from "@open-inspect/shared/types/sessions";

export type NormalizedArtifactResponse = Omit<ArtifactResponse, "updatedAt"> & {
  updatedAt: number;
};

const VALID_ARTIFACT_TYPES = [
  "pr",
  "screenshot",
  "video",
  "page",
  "file",
  "preview",
  "branch",
] as const satisfies readonly ArtifactType[];
const VALID_ARTIFACT_TYPE_SET = new Set<string>(VALID_ARTIFACT_TYPES);

function isArtifactType(value: string): value is ArtifactType {
  return VALID_ARTIFACT_TYPE_SET.has(value);
}

export function assertArtifactType(value: string): ArtifactType {
  if (!isArtifactType(value)) {
    throw new Error(`Unsupported artifact type: ${value}`);
  }

  return value;
}

function isCoverType(type: string): type is SessionCoverType {
  return sessionCoverTypeSchema.safeParse(type).success;
}

/**
 * What a session card shows of the session's output: the first image or video
 * it produced, which later output never replaces, and how many it has produced.
 */
export function summarizeSessionMedia(
  artifacts: readonly { id: string; type: string; created_at: number }[]
): { cover: SessionCover | null; count: number } {
  let first: { id: string; type: SessionCoverType; created_at: number } | null = null;
  let count = 0;
  for (const artifact of artifacts) {
    const { id, type, created_at } = artifact;
    if (!isCoverType(type)) continue;
    count += 1;
    // Ties break on id so the choice does not depend on the order rows arrive in.
    if (
      !first ||
      created_at < first.created_at ||
      (created_at === first.created_at && id < first.id)
    ) {
      first = { id, type, created_at };
    }
  }
  return { cover: first ? { artifactId: first.id, type: first.type } : null, count };
}
