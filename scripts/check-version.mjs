#!/usr/bin/env node
/**
 * One version for the whole repository. The root package.json holds it; every workspace package
 * carries the same number, package-lock.json agrees, and CHANGELOG.md has a section for it. A
 * release is that number plus the git tag `v<version>` (see docs/RELEASING.md).
 *
 * Usage: node scripts/check-version.mjs [--root <dir>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Every problem with the repository's version, as a list of sentences; empty when it is fine. */
export function checkVersions(root) {
  const problems = [];
  const rootPackage = readJson(join(root, "package.json"));
  const version = rootPackage.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    return [`the root package.json version ${JSON.stringify(version)} is not a semantic version`];
  }

  const packagesDir = join(root, "packages");
  for (const name of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, name, "package.json");
    if (!existsSync(file)) continue;
    const found = readJson(file).version;
    if (found !== version) {
      problems.push(
        `packages/${name}/package.json is at ${found ?? "no version"}, the root is at ${version}`
      );
    }
  }

  const lockFile = join(root, "package-lock.json");
  if (existsSync(lockFile)) {
    const lock = readJson(lockFile);
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      problems.push(`package-lock.json is not at ${version} (run npm install --package-lock-only)`);
    }
  }

  const changelog = join(root, "CHANGELOG.md");
  if (!existsSync(changelog)) {
    problems.push("CHANGELOG.md is missing");
  } else if (
    !new RegExp(`^## \\[${version.replace(/[.+]/g, "\\$&")}\\]`, "m").test(
      readFileSync(changelog, "utf8")
    )
  ) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  const root =
    index > 0 ? process.argv[index + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkVersions(root);
  if (problems.length > 0) {
    console.error(`version: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`version ok ${readJson(join(root, "package.json")).version}`);
}
