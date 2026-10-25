#!/usr/bin/env node
/**
 * Keeps the repository's top level the way the layout in AGENTS.md describes it.
 *
 * Every tracked entry at the root is on the list below with the reason it has to be there. A new
 * root entry is not forbidden; it has to be added here with its reason, which is the point at which
 * someone asks whether it belongs in `deploy/`, `docs/` or `scripts/`.
 *
 * Usage: node scripts/check-layout.mjs [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every tracked entry at the root, and why it is there. Dot entries stay only where a tool reads them from the root. */
export const ROOT_ENTRIES = {
  // Tools that look for these at the root and nowhere else.
  ".claude": "Claude Code project settings and the agent-guard hook",
  ".github": "GitHub Actions, issue and pull request templates, community files",
  ".gitignore": "git",
  ".gitleaks.toml": "gitleaks reads its config from the root (scripts/check-public-safety.ts)",
  ".husky": "git hooks (husky points core.hooksPath here)",
  ".nvmrc": "Node version for nvm and for the workflows' node-version-file",
  ".prettierignore": "Prettier reads it from the root (the config itself lives in package.json)",
  // Project documents.
  "AGENTS.md": "agent instructions (CLAUDE.md links to it)",
  "CLAUDE.md": "symlink to AGENTS.md",
  "CHANGELOG.md":
    "release notes, one section per version (scripts/check-version.mjs keeps it in step)",
  LICENSE: "license",
  "README.md": "readme",
  // Root tooling config that the tools resolve from the root.
  "eslint.config.js": "ESLint",
  "knip.json": "Knip",
  "package-lock.json": "npm",
  "package.json": "npm workspaces, scripts, Prettier config",
  "ruff.toml": "Ruff",
  "vitest.workspace.ts": "Vitest",
  // The code and content, by kind.
  deploy:
    "everything that runs somewhere: Cloudflare Worker configs, D1 migrations, compose stacks and env examples, the edge proxy",
  docs: "documentation",
  packages:
    "npm workspaces and sandbox Python: the engine (control-plane), the LLM gateway, shared types, sandbox runtime and images, the local Docker data plane",
  scripts:
    "repository tooling: lint checks, verify, git hooks, agent guard, the local stack, benchmarks",
  skills:
    "the skills the sandbox bakes in (builtin), the Remotion starter they render with, and their script tests",
  terraform: "build scripts of the sandbox providers, hashed into the sandbox image",
};

/** @param {string[]} files tracked paths, relative to the root */
export function checkEntries(files) {
  const problems = [];
  const top = new Set(files.map((file) => file.split("/")[0]));
  for (const entry of [...top].sort()) {
    if (!(entry in ROOT_ENTRIES)) {
      problems.push(
        `${entry}: not a known root entry. Put it under deploy/, docs/, scripts/ or ` +
          "packages/, or add it to ROOT_ENTRIES in scripts/check-layout.mjs with the reason it " +
          "has to sit at the root."
      );
    }
  }
  return problems;
}

function main() {
  const flag = process.argv.indexOf("--root");
  const root =
    flag === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : process.argv[flag + 1];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split("\0")
    .filter(Boolean);
  const problems = checkEntries(files);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} layout problem(s).`);
    process.exit(1);
  }
  console.log(
    `layout ok: ${files.length} tracked files, ${Object.keys(ROOT_ENTRIES).length} root entries allowed`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
