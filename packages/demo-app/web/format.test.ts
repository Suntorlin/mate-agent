import { describe, expect, it } from "vitest";
import { formatWhen } from "./format.ts";

const noon = new Date(2026, 9, 15, 12, 0).getTime();
const daysBefore = (days: number) => noon - days * 86_400_000;

describe("formatWhen", () => {
  it("says Yesterday for the day before", () => {
    expect(formatWhen(daysBefore(1), noon)).toBe("Yesterday");
  });

  it("shows a time for today and a weekday within the week", () => {
    expect(formatWhen(noon - 60_000, noon)).toMatch(/\d/);
    expect(formatWhen(daysBefore(3), noon)).not.toMatch(/\d/);
  });

  it("shows the date after a week", () => {
    expect(formatWhen(daysBefore(20), noon)).toMatch(/\d/);
  });
});
