#!/usr/bin/env node
/**
 * One command for "does this tree pass what CI passes", run on the laptop before a push or a deploy.
 *
 *   npm run verify                       everything CI runs (about ten minutes)
 *   npm run verify -- --level static     layout, migrations, lint, format, contracts (about a minute)
 *   npm run verify -- --level unit       static plus type checks and every unit suite
 *   npm run verify -- --only lint,gateway
 *   npm run verify -- --skip integration
 *   npm run verify -- --install          npm ci first (a fresh worktree)
 *   npm run verify -- --list
 *
 * The steps run one after another and never in parallel: each Vitest run already uses every core.
 * A step that fails does not stop the run, so one pass shows everything that is red; --bail stops at
 * the first. Logs go to a temporary directory whose path is printed. The step list is the list in
 * .github/workflows/ci.yml, plus the suites CI did not run before (the gateway, the skills'
 * scripts); when one is added there, add it here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = ["static", "unit", "full"];
const npm = (...args) => ["npm", ...args];

/** Each step: a command list run in order, stopping at the first failure. */
export const STEPS = [
  {
    id: "layout",
    level: "static",
    about: "the root holds only what the layout allows",
    commands: [["node", "scripts/check-layout.mjs"]],
  },
  {
    id: "public-safety",
    level: "static",
    about: "no secret, private name, personal path or private address in the tracked files",
    commands: [
      ["node", "scripts/check-public-safety.ts", "--self-test"],
      ["node", "scripts/check-public-safety.ts", "--tree"],
    ],
  },
  {
    id: "version",
    level: "static",
    about: "one version: workspaces, lockfile and CHANGELOG agree",
    commands: [["node", "scripts/check-version.mjs"]],
  },
  {
    id: "migrations",
    level: "static",
    about: "D1 migrations are named, unique and only added",
    commands: [["node", "scripts/check-migrations.mjs"]],
  },
  {
    id: "harness",
    level: "static",
    about: "the checks, git hooks and agent guard themselves",
    commands: [npm("run", "test:harness")],
  },
  {
    id: "build-shared",
    level: "static",
    about: "the shared package, which the others import built",
    commands: [npm("run", "build", "-w", "@open-inspect/shared")],
  },
  {
    id: "lint",
    level: "static",
    about: "ESLint and the repository's own lint checks",
    commands: [
      npm("run", "lint"),
      npm("run", "test:lint-complexity"),
      npm("run", "lint:sql-portability"),
      npm("run", "test:lint-sql-portability"),
      npm("run", "test:lint-sandbox-boundaries"),
    ],
  },
  {
    id: "contracts",
    level: "static",
    about: "the CLIs and the workflow/Node version contract",
    commands: [
      npm("run", "test:rbac-bootstrap-owner"),
      npm("run", "test:user-merge-cli"),
      npm("run", "test:cf-logs-cli"),
      npm("run", "test:node-version-workflow-contract"),
    ],
  },
  {
    id: "configs-format",
    level: "static",
    about: "Worker configs agree, Prettier, Knip",
    commands: [
      ["node", "--test", "deploy/cloudflare/configs.test.mjs"],
      npm("run", "format:check"),
      npm("run", "knip", "--", "--no-exit-code"),
    ],
  },
  {
    id: "typecheck",
    level: "unit",
    about: "TypeScript, every workspace",
    commands: [npm("run", "typecheck")],
  },
  {
    id: "unit-tests",
    level: "unit",
    about: "shared, control-plane and demo app unit tests",
    commands: [
      npm("test", "-w", "@open-inspect/shared"),
      npm("test", "-w", "@open-inspect/control-plane"),
      npm("test", "-w", "@open-inspect/demo-app"),
    ],
  },
  {
    id: "gateway",
    level: "unit",
    about:
      "the LLM gateway: core and Worker on workerd, the Node host in Node; the Docker data plane",
    commands: [
      npm("test", "-w", "@open-inspect/gateway"),
      npm("test", "-w", "@open-inspect/docker-dataplane"),
    ],
  },
  {
    id: "skill-tests",
    level: "unit",
    about: "the scripts the sandbox skills run (mediaedit, mem, library, ...)",
    commands: [["python3", "-m", "unittest", "discover", "-s", "skills/tests", "-p", "test_*.py"]],
  },
  {
    id: "python",
    level: "unit",
    about: "sandbox runtime: Ruff, pytest and the OpenCode plugin tests",
    needs: "uv",
    commands: "python",
  },
  {
    id: "integration",
    level: "full",
    about: "control-plane integration tests on workerd",
    commands: [npm("run", "test:integration", "-w", "@open-inspect/control-plane")],
  },
];

const PYTHON_COMMANDS = [
  ["uv", "sync", "--extra", "dev"],
  [".venv/bin/ruff", "check"],
  [".venv/bin/ruff", "format", "--check"],
  [
    ".venv/bin/python",
    "-m",
    "pytest",
    "tests",
    "-q",
    "--basetemp",
    // Short on purpose: the tests bind UNIX sockets under it, and macOS temp paths are too long for that.
    "/tmp/verify-pytest",
  ],
  // The OpenCode plugins' and tools' own tests; Node expands the glob itself.
  ["node", "--test", "tests/*.test.mjs"],
];

const INSTALLS = [
  {
    id: "install",
    level: "static",
    about: "npm ci in the root (every workspace)",
    commands: [npm("ci")],
  },
];

/** @returns the steps to run, in order */
export function selectSteps({ level = "full", only, skip = [], install = false }) {
  const rank = LEVELS.indexOf(level);
  if (rank === -1) throw new Error(`--level must be one of ${LEVELS.join(", ")}`);
  const known = new Set(STEPS.map((step) => step.id));
  for (const id of [...(only ?? []), ...skip]) {
    if (!known.has(id)) throw new Error(`no step called ${id}; --list shows them`);
  }
  const steps = STEPS.filter((step) =>
    only ? only.includes(step.id) : LEVELS.indexOf(step.level) <= rank
  ).filter((step) => !skip.includes(step.id));
  return install ? [...INSTALLS, ...steps] : steps;
}

function parseArgs(argv) {
  const options = { skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--level") options.level = value();
    else if (arg === "--only") options.only = value().split(",");
    else if (arg === "--skip") options.skip = value().split(",");
    else if (arg === "--base") options.base = value();
    else if (arg === "--install") options.install = true;
    else if (arg === "--bail") options.bail = true;
    else if (arg === "--list") options.list = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, cwd = root) =>
  spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const has = (command) => spawnSync("which", [command], { encoding: "utf8" }).status === 0;

/** The migrations check also compares with the branch this one will be merged into, when it can. */
function commandsFor(step, options) {
  if (step.id !== "migrations") return step.commands;
  const base =
    options.base ??
    (run(["git", "rev-parse", "--verify", "-q", "origin/dev"]).status === 0 ? "origin/dev" : null);
  return base ? [[...step.commands[0], "--base", base]] : step.commands;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const step of STEPS)
      console.log(`${step.level.padEnd(7)}${step.id.padEnd(16)}${step.about}`);
    return;
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) {
    console.error(
      `verify needs Node 24 (this is ${process.versions.node}; .nvmrc says 24, and other majors give false failures).\n` +
        "On this Mac: export PATH=/opt/homebrew/opt/node@24/bin:$PATH"
    );
    process.exit(2);
  }
  const steps = selectSteps(options);
  if (!options.install && !existsSync(join(root, "node_modules"))) {
    console.error("No node_modules here. Run: npm run verify -- --install");
    process.exit(2);
  }

  const head = run(["git", "rev-parse", "--short", "HEAD"]).stdout.trim();
  const dirty = run(["git", "status", "--porcelain"]).stdout.trim() !== "";
  const logs = join(tmpdir(), `verify-${head}-${Date.now()}`);
  mkdirSync(logs, { recursive: true });
  console.log(
    `node ${process.versions.node} | ${head}${dirty ? " + uncommitted changes" : ""} | logs ${logs}\n`
  );

  const results = [];
  for (const step of steps) {
    const started = Date.now();
    const finish = (status, detail = "") => {
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ id: step.id, status, seconds, detail });
      console.log(
        `${status.padEnd(8)}${step.id.padEnd(16)}${String(seconds).padStart(4)}s  ${detail}`
      );
    };
    if (step.needs && !has(step.needs)) {
      finish("SKIPPED", `${step.needs} is not installed, so this step did not run`);
      continue;
    }
    const log = join(logs, `${step.id}.log`);
    let failed = null;
    const output = [];
    for (const command of step.commands === "python"
      ? PYTHON_COMMANDS
      : commandsFor(step, options)) {
      const cwd = step.commands === "python" ? join(root, "packages/sandbox-runtime") : root;
      const outcome = run(command, cwd);
      output.push(`$ ${command.join(" ")}\n${outcome.stdout}${outcome.stderr}`);
      if (outcome.status !== 0) {
        failed = command.join(" ");
        break;
      }
    }
    writeFileSync(log, output.join("\n"));
    if (failed) {
      const tail = output.at(-1).trimEnd().split("\n").slice(-12).join("\n");
      finish("FAILED", `${failed}\n${tail.replace(/^/gm, "          ")}\n          log: ${log}`);
      if (options.bail) break;
    } else {
      finish("ok");
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  const total = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(
    `\n${failed.length === 0 ? "VERIFY OK" : `VERIFY FAILED (${failed.map((r) => r.id).join(", ")})`}` +
      `  ${results.length} steps, ${Math.round(total / 60)} min` +
      (skipped.length > 0 ? `  NOT RUN: ${skipped.map((r) => r.id).join(", ")}` : "")
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
