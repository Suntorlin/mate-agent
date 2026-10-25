import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./check-version.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture({
  root = "1.2.3",
  packages = { a: "1.2.3" },
  lock = "1.2.3",
  changelog = "## [1.2.3] - 2026-10-15\n",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-version-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", version: root }));
  for (const [name, version] of Object.entries(packages)) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ name, ...(version ? { version } : {}) })
    );
  }
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ version: lock, packages: { "": { version: lock } } })
  );
  if (changelog !== null) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

function problems(options) {
  const dir = fixture(options);
  try {
    return checkVersions(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("a consistent repository has no problems", () => {
  assert.deepEqual(problems({}), []);
});

test("a workspace at another version, or with none, is named", () => {
  assert.match(
    problems({ packages: { a: "1.2.3", b: "1.0.0" } })[0],
    /packages\/b\/package.json is at 1.0.0/
  );
  assert.match(problems({ packages: { a: "" } })[0], /no version/);
});

test("the lockfile has to agree", () => {
  assert.match(problems({ lock: "1.0.0" })[0], /package-lock.json is not at 1.2.3/);
});

test("the changelog needs a section for the version", () => {
  assert.match(problems({ changelog: null })[0], /CHANGELOG.md is missing/);
  assert.match(
    problems({ changelog: "## [1.2.2] - 2026-01-01\n" })[0],
    /no "## \[1.2.3\]" section/
  );
  assert.deepEqual(problems({ changelog: "## [Unreleased]\n\n## [1.2.3] - 2026-10-15\n" }), []);
});

test("a root version that is not semantic is the only problem reported", () => {
  const found = problems({ root: "one" });
  assert.equal(found.length, 1);
  assert.match(found[0], /not a semantic version/);
});

test("this repository passes", () => {
  const out = execFileSync("node", ["scripts/check-version.mjs"], { cwd: repoRoot }).toString();
  assert.match(out, /^version ok \d+\.\d+\.\d+/);
});
