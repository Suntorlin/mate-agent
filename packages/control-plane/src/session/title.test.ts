import { describe, expect, it } from "vitest";
import {
  deriveFallbackSessionTitle,
  FALLBACK_SESSION_TITLE_MAX_LENGTH,
  isFallbackSessionTitle,
} from "./title";

describe("deriveFallbackSessionTitle", () => {
  it("takes the first line with words in it", () => {
    expect(deriveFallbackSessionTitle("\n  我想要做一个动效片，去呈现艺术创作主题\n更多说明")).toBe(
      "我想要做一个动效片，去呈现艺术创作主题"
    );
  });

  it("drops a pasted link and keeps the words around it", () => {
    expect(
      deriveFallbackSessionTitle(
        "https://www.instagram.com/reel/Dc_RhWSB-Qg/?utm_source=ig_web_copy_link&stkn=NTc4 你能做这个吗"
      )
    ).toBe("你能做这个吗");
  });

  it("moves on to the next line when a line is only a link", () => {
    expect(deriveFallbackSessionTitle("https://example.com/a/b?c=d\nRemake this reel")).toBe(
      "Remake this reel"
    );
  });

  it("gives no title for a prompt that is only a link", () => {
    expect(deriveFallbackSessionTitle("https://www.instagram.com/reel/Dc_RhWSB-Qg/")).toBeNull();
    expect(deriveFallbackSessionTitle("  \n\t ")).toBeNull();
  });

  it("truncates a long line on a word boundary", () => {
    const title = deriveFallbackSessionTitle("word ".repeat(40));
    expect(title).toMatch(/…$/);
    expect(title?.length).toBeLessThanOrEqual(FALLBACK_SESSION_TITLE_MAX_LENGTH + 1);
    expect(title).not.toMatch(/ …$/);
  });
});

describe("isFallbackSessionTitle", () => {
  const prompts = ["https://example.com/reel 你能做这个吗", "换成竖屏"];

  it("recognises the title any of the prompts would give", () => {
    expect(isFallbackSessionTitle("你能做这个吗", prompts)).toBe(true);
    expect(isFallbackSessionTitle(" 换成竖屏 ", prompts)).toBe(true);
  });

  it("leaves a title somebody chose alone", () => {
    expect(isFallbackSessionTitle("一镜到底穿越房间", prompts)).toBe(false);
    expect(isFallbackSessionTitle("你能做这个吗", [])).toBe(false);
  });
});
