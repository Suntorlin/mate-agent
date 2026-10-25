import { describe, expect, it } from "vitest";
import { mintGatewayToken } from "./sandbox-env";

/** The claims of a JWT, read without checking its signature. */
function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

describe("mintGatewayToken", () => {
  const input = { userId: "engine-user-1", sessionId: "s1", nowMs: 1_800_000_000_000 };

  it("names the product's user on a session a product's user owns, so its calls are reported", async () => {
    const { token, claims } = await mintGatewayToken("secret", { ...input, appUserId: "acme-1" });
    expect(claims).toMatchObject({ sub: "engine-user-1", sid: "s1", app: "acme-1" });
    expect(claimsOf(token)).toMatchObject({ sub: "engine-user-1", sid: "s1", app: "acme-1" });
  });

  it("carries no app claim for anyone else", async () => {
    for (const appUserId of [undefined, null]) {
      const { token } = await mintGatewayToken("secret", { ...input, appUserId });
      expect(claimsOf(token)).not.toHaveProperty("app");
    }
  });
});
