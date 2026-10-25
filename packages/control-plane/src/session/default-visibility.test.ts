import { describe, expect, it } from "vitest";
import { parseDefaultSessionVisibility } from "./default-visibility";

describe("parseDefaultSessionVisibility", () => {
  it("shares sessions with the workspace by default", () => {
    expect(parseDefaultSessionVisibility({})).toBe("workspace");
    expect(parseDefaultSessionVisibility({ DEFAULT_SESSION_VISIBILITY: "" })).toBe("workspace");
  });

  it("follows an explicit setting either way", () => {
    expect(parseDefaultSessionVisibility({ DEFAULT_SESSION_VISIBILITY: "private" })).toBe(
      "private"
    );
    expect(
      parseDefaultSessionVisibility({
        DEFAULT_SESSION_VISIBILITY: "workspace",
      })
    ).toBe("workspace");
  });

  it("rejects values it cannot honor", () => {
    expect(() => parseDefaultSessionVisibility({ DEFAULT_SESSION_VISIBILITY: "team" })).toThrow(
      "Invalid DEFAULT_SESSION_VISIBILITY: team"
    );
    expect(() => parseDefaultSessionVisibility({ DEFAULT_SESSION_VISIBILITY: "public" })).toThrow();
  });
});
