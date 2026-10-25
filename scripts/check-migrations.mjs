#!/usr/bin/env node
/**
 * Checks the D1 migrations in deploy/d1/migrations.
 *
 * D1 applies migrations by file name, once each, in order, and the dev and production databases are
 * ahead of or behind a branch by whole files. So a migration that was already applied must never
 * change, and two branches that each add "the next number" must not both land. Always checked:
 *   - every file is named NNNN_snake_case.sql;
 *   - no number is used twice.
 * With --base <ref> (a pull request's target branch), also checked against that branch:
 *   - a file that exists there is not edited, deleted or renamed;
 *   - a new file's number is higher than every number there, so a branch that fell behind has to
 *     renumber instead of landing in a gap.
 * Gaps in the numbering are fine (0046, 0085 and 0086 do not exist); only order matters.
 *
 * Usage: node scripts/check-migrations.mjs [--base <ref>] [--dir <path>]
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** @param {string[]} names file names in the directory */
export function checkNames(names) {
  const problems = [];
  const seen = new Map();
  for (const name of names.filter((n) => n.endsWith(".sql") || /^\d/.test(n)).sort()) {
    const match = NAME.exec(name);
    if (!match) {
      problems.push(`${name}: not named NNNN_snake_case.sql`);
      continue;
    }
    const number = match[1];
    if (seen.has(number))
      problems.push(`${name}: number ${number} is also used by ${seen.get(number)}`);
    else seen.set(number, name);
  }
  return problems;
}

/**
 * @param {object} input
 * @param {string[]} input.baseNames migration names on the base branch
 * @param {{ status: string, path: string }[]} input.changes what this branch did since it left the base,
 *   by file name (`A` added, `M` modified, `D` deleted, `R` renamed away from `path`)
 */
export function checkAgainstBase({ baseNames, changes }) {
  const problems = [];
  const numbers = baseNames.map((name) => NAME.exec(name)?.[1]).filter(Boolean);
  const highest = numbers.length > 0 ? numbers.reduce((a, b) => (a > b ? a : b)) : "0000";
  const onBase = new Set(baseNames);
  for (const { status, path } of changes) {
    if (status === "A") {
      const number = NAME.exec(path)?.[1];
      if (number && number <= highest) {
        problems.push(
          `${path}: the base branch already has ${highest}; renumber this migration above it`
        );
      }
    } else if (onBase.has(path)) {
      const what = { M: "edited", D: "deleted", R: "renamed" }[status] ?? "changed";
      problems.push(
        `${path}: was applied from the base branch and ${what} here; add a new migration instead`
      );
    }
  }
  return problems;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }).toString();
}

function main() {
  const arg = (flag) => {
    const at = process.argv.indexOf(flag);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = arg("--dir") ?? "deploy/d1/migrations";
  const base = arg("--base");

  const problems = checkNames(readdirSync(join(root, dir)));
  if (base) {
    const forkPoint = git(root, "merge-base", base, "HEAD").trim();
    const baseNames = git(root, "ls-tree", "--name-only", base, `${dir}/`)
      .split("\n")
      .filter(Boolean)
      .map((path) => path.split("/").pop());
    const changes = git(root, "diff", "--name-status", "-M", forkPoint, "--", dir)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // For a rename git prints the old path first, and the old name is what the base has.
        const [status, path] = line.split("\t");
        return { status: status[0], path: path.split("/").pop() };
      });
    const untracked = git(root, "ls-files", "--others", "--exclude-standard", "--", dir)
      .split("\n")
      .filter(Boolean)
      .map((path) => ({ status: "A", path: path.split("/").pop() }));
    problems.push(...checkAgainstBase({ baseNames, changes: [...changes, ...untracked] }));
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} migration problem(s).`);
    process.exit(1);
  }
  console.log(`migrations ok${base ? ` against ${base}` : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
