import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { EnvConfig } from "../types";

/** The visibilities a deployment may give new top-level sessions; `team` needs an owning team. */
export type DefaultSessionVisibility = Extract<SessionVisibility, "workspace" | "private">;

/**
 * The visibility a new top-level session is created with: `DEFAULT_SESSION_VISIBILITY` when set,
 * else shared with the workspace. A product's users always get private sessions (session-create).
 */
export function parseDefaultSessionVisibility(
  env: Pick<EnvConfig, "DEFAULT_SESSION_VISIBILITY">
): DefaultSessionVisibility {
  const value = env.DEFAULT_SESSION_VISIBILITY?.trim();
  if (!value) return "workspace";
  if (value === "workspace" || value === "private") return value;
  throw new Error(`Invalid DEFAULT_SESSION_VISIBILITY: ${value}`);
}
