import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionAction, SessionViewer } from "@open-inspect/shared";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";

export type TeamsEnforcementMode = "off" | "shadow" | "on";

export function parseTeamsEnforcementMode(value: string | undefined): TeamsEnforcementMode {
  if (value === undefined || value === "") return "shadow";
  if (value === "off" || value === "shadow" || value === "on") return value;
  throw new Error(`Invalid TEAMS_ENFORCEMENT: ${value}`);
}

/**
 * Whether a session is decided by the per-session access rules rather than the workspace-wide
 * permission that shares every non-private session.
 */
export function enforcesSessionAccess(
  mode: TeamsEnforcementMode,
  visibility: SessionVisibility,
  viewer: SessionViewer
): boolean {
  return (
    mode === "on" ||
    visibility === "private" ||
    (viewer.kind === "user" && viewer.ownSessionsOnly === true)
  );
}

export function legacyPermissionForAction(action: SessionAction): PermissionId {
  switch (action) {
    case "read":
      return "sessions.read";
    case "collaborate":
      return "sessions.collaborate";
    case "delete":
      return "sessions.delete";
    case "sandbox":
      return "sessions.sandbox_access";
    case "lifecycle":
    case "move":
    case "changeVisibility":
    case "manageCollaborators":
      return "sessions.lifecycle";
  }
}
