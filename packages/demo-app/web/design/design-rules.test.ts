/**
 * The design system's rules (DESIGN.md), as tests: a change that breaks one fails here instead of
 * in review. They read the source, so they need no browser.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, extension);
    return extension.test(entry.name) ? [path] : [];
  });
}

const name = (path: string) => relative(WEB, path);
const read = (path: string) => readFileSync(path, "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const CSS = files(WEB, /\.css$/);
/** Everything but the tokens file: that is where the colour literals live. */
const STYLES = CSS.filter((path) => name(path) !== "design/tokens.css");

/** Every `property: value` of a stylesheet, with the line number of the declaration. */
function declarations(css: string, property: RegExp): Array<{ value: string; line: number }> {
  const found: Array<{ value: string; line: number }> = [];
  const text = withoutComments(css);
  for (const match of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    if (property.test(match[1])) {
      found.push({
        value: match[2].trim(),
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return found;
}

function violations(property: RegExp, allowed: RegExp, skip: string[] = []): string[] {
  return STYLES.filter((path) => !skip.includes(name(path))).flatMap((path) =>
    declarations(read(path), property)
      .filter(({ value }) => !allowed.test(value))
      .map(({ value, line }) => `${name(path)}:${line}  ${value}`)
  );
}

describe("design rules: tokens only", () => {
  it("writes no colour literal outside tokens.css", () => {
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;
    const found = STYLES.flatMap((path) =>
      withoutComments(read(path))
        .split("\n")
        .flatMap((text, index) =>
          literal.test(text) ? [`${name(path)}:${index + 1}  ${text.trim()}`] : []
        )
    );
    expect(found, "use a --social-* (or other) token; add one to tokens.css if none fits").toEqual(
      []
    );
  });

  it("takes font sizes from the type scale", () => {
    expect(violations(/^font-size$/, /^var\(--text-[a-z]+\)$|^inherit$/)).toEqual([]);
  });

  it("uses only the two font weights", () => {
    expect(violations(/^font-weight$/, /^var\(--weight-(regular|strong)\)$/)).toEqual([]);
  });

  it("takes corner radii from the radius scale", () => {
    expect(
      violations(/^border(-[a-z]+)*-radius$/, /^((var\(--radius-[a-z]+\)|0)\s*)+$|^inherit$/)
    ).toEqual([]);
  });

  it("takes shadows from the shadow tokens", () => {
    expect(violations(/^box-shadow$/, /^var\(--shadow-[a-z]+\)$|^none$/)).toEqual([]);
  });

  it("takes durations from the motion tokens", () => {
    // base.css holds the one reduced-motion override.
    expect(
      violations(/^(transition|animation)(-duration)?$/, /^(?!.*\b\d+(\.\d+)?m?s\b)/, [
        "design/base.css",
      ])
    ).toEqual([]);
  });
});

describe("design rules: components only", () => {
  const SOURCES = files(WEB, /\.tsx$/).filter(
    (path) => !name(path).startsWith("ui/") && !name(path).includes(".test.")
  );

  it("hand-writes no button, input, textarea or select outside ui/", () => {
    const found = SOURCES.flatMap((path) =>
      read(path)
        .split("\n")
        .flatMap((text, index) =>
          /<(button|input|textarea|select)[\s>]/.test(text)
            ? [`${name(path)}:${index + 1}  ${text.trim()}`]
            : []
        )
    );
    expect(found, "use Button, IconButton, TextField, TextArea, Chip... from ui/").toEqual([]);
  });

  it("has a showcase entry for every exported component", () => {
    const index = read(join(WEB, "ui/index.ts"));
    const exported = [...index.matchAll(/export \{([^}]+)\} from/g)]
      .flatMap((match) => match[1].split(","))
      .map((item) => item.trim())
      .filter((item) => /^[A-Z]/.test(item) && !item.startsWith("type "));
    const showcase = read(join(WEB, "design/Showcase.tsx"));
    expect(exported.filter((component) => !showcase.includes(`<${component}`))).toEqual([]);
  });

  it("lets every icon-only action carry a label", () => {
    const found = SOURCES.flatMap((path) =>
      [...read(path).matchAll(/<IconButton\b(?![^>]*\blabel=)[^>]*>/g)].map(
        (match) => `${name(path)}  ${match[0]}`
      )
    );
    expect(found).toEqual([]);
  });
});
