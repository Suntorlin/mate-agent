import { describe, expect, it } from "vitest";
import { parsePreference, resolveTheme } from "./theme.ts";

describe("theme", () => {
  it("follows the system until the user chooses", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("a choice beats the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("treats anything stored but light and dark as system", () => {
    expect(parsePreference("dark")).toBe("dark");
    expect(parsePreference("light")).toBe("light");
    expect(parsePreference("auto")).toBe("system");
    expect(parsePreference(null)).toBe("system");
  });
});
