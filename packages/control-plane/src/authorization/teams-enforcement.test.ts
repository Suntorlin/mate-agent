import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS, type SessionViewer } from "@open-inspect/shared";
import {
  enforcesSessionAccess,
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
} from "./teams-enforcement";

describe("teams enforcement", () => {
  it("defaults to shadow and accepts only the three modes", () => {
    expect(parseTeamsEnforcementMode(undefined)).toBe("shadow");
    expect(parseTeamsEnforcementMode("off")).toBe("off");
    expect(parseTeamsEnforcementMode("shadow")).toBe("shadow");
    expect(parseTeamsEnforcementMode("on")).toBe("on");
    expect(() => parseTeamsEnforcementMode("enabled")).toThrow();
  });

  it("decides a session by its own access rules when enforced, private, or read by a lone creator", () => {
    const member: SessionViewer = {
      kind: "user",
      userId: "user-a",
      roleKey: "member",
      permissions: [],
      suspended: false,
      memberships: new Map(),
    };
    const service: SessionViewer = { kind: "service", teamId: null };
    for (const mode of ["off", "shadow"] as const) {
      for (const visibility of ["workspace", "team"] as const) {
        expect(enforcesSessionAccess(mode, visibility, member)).toBe(false);
        expect(enforcesSessionAccess(mode, visibility, service)).toBe(false);
        expect(enforcesSessionAccess(mode, visibility, { ...member, ownSessionsOnly: true })).toBe(
          true
        );
      }
      expect(enforcesSessionAccess(mode, "private", member)).toBe(true);
    }
    expect(enforcesSessionAccess("on", "workspace", member)).toBe(true);
  });

  it("maps every resolver action to its pre-enforcement permission", () => {
    expect(SESSION_ACTIONS.map((action) => legacyPermissionForAction(action))).toEqual([
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "sessions.delete",
      "sessions.sandbox_access",
      "sessions.lifecycle",
      "sessions.lifecycle",
      "sessions.lifecycle",
    ]);
  });
});
