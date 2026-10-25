import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ROOT_ENTRIES, checkEntries } from "./check-layout.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("an entry at the root that nobody listed is reported with where to put it instead", () => {
  const problems = checkEntries(["package.json", "notes.txt", ".dockerignore"]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^\.dockerignore: not a known root entry/);
  assert.match(problems[1], /^notes\.txt: not a known root entry.*deploy\/, docs\/, scripts\//);
});

test("the root keeps only the dot entries a tool reads from there", () => {
  assert.deepEqual(
    Object.keys(ROOT_ENTRIES)
      .filter((name) => name.startsWith("."))
      .sort(),
    [".claude", ".github", ".gitignore", ".gitleaks.toml", ".husky", ".nvmrc", ".prettierignore"]
  );
});

test("this repository passes", () => {
  const out = execFileSync("node", ["scripts/check-layout.mjs"], { cwd: repoRoot }).toString();
  assert.match(out, /^layout ok/);
});
