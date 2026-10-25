import { describe, expect, it } from "vitest";
import type { Principal, ResolvedIdentity } from "../auth/principal";
import { isAppUser, isAppUserParticipant } from "./app-user";

function actor(provider: ResolvedIdentity["provider"]): ResolvedIdentity {
  return {
    provider,
    providerUserId: "uid-1",
    canonicalUserId: "user-1",
    participantUserId: `${provider}:uid-1`,
  };
}

describe("isAppUser", () => {
  it("is a product's user relayed by its backend, and nobody else", () => {
    const cases: [Principal | undefined, boolean][] = [
      [{ kind: "service", service: "app", actor: actor("app") }, true],
      [{ kind: "service", service: "app", actor: null }, false],
      [{ kind: "service", service: "slack-bot", actor: actor("slack") }, false],
      [{ kind: "user", userId: "user-1" }, false],
      [{ kind: "sandbox", sessionId: "session-1" }, false],
      [undefined, false],
    ];
    for (const [principal, expected] of cases) expect(isAppUser(principal)).toBe(expected);
  });
});

describe("isAppUserParticipant", () => {
  it("recognizes the participant id an app actor arrives as", () => {
    expect(isAppUserParticipant("app:uid-1")).toBe(true);
    expect(isAppUserParticipant("slack:U123")).toBe(false);
    expect(isAppUserParticipant("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1")).toBe(false);
  });
});
