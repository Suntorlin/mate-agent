# AGENTS.md

Mate Agent: a general-purpose agent runtime. A session is a Durable Object (or the Node host's
equivalent) holding messages, events and state; the agent itself runs in a sandbox with Claude Code
(Anthropic models, the default) or OpenCode (OpenAI, xAI and the other providers, including ChatGPT
and SuperGrok subscriptions), or inline for short turns. The engine serves one product, which brings
its own accounts, persona, tools (an MCP server) and credits and signs in as the `app` service; a
new product forks the engine rather than sharing it. `packages/demo-app` is the reference product.
Built on Open-Inspect (`ColeMurray/background-agents`); see `docs/UPSTREAM.md`.

## Red lines (read this first)

- **No cloud.** This repository has no Cloudflare or Vercel environment of its own. Never run
  `wrangler deploy`, `wrangler d1 ... --remote`, `wrangler secret`, or any other command against a
  remote account from this repository unless the maintainer asked for it in the current turn: the
  wrangler login on a machine can reach accounts that are not this project's. The configs in
  `deploy/cloudflare` are templates with placeholder ids.
- The remote `upstream` (Open-Inspect, if present) is fetch-only; never push to it. This repository
  takes fixes from there by hand, never automatically (`docs/UPSTREAM.md`).
- Never `git push`, and never open or merge a PR, unless the user asked for it in the current turn.
  Pushing a tag is a push. Commit messages are in English.
- Never create cloud resources or spend money without asking.
- Secrets never go into files, docs or logs; local secrets live in ignored `.env*` files. This
  repository is public: `scripts/check-public-safety.ts` (pre-commit hook, `verify`, CI) refuses
  secrets, private names, personal paths and private addresses. Private names to block go in the
  ignored `.public-safety.local`, one per line.
- No `git stash`; use a WIP commit instead.
- Local work runs on this machine only: the Node host, local Docker sandboxes, the local gateway.

### Repository layout

Code is under `packages/` (npm workspaces and the sandbox's Python). `scripts/check-layout.mjs`
fails CI if a new entry appears at the root without a reason.

| Path                       | What it is                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/control-plane`   | The engine: sessions, Durable Objects, D1; user memory (`src/memory`), user files (`src/files`), the product (`src/app`), the gateway client (`src/gateway`)    |
| `packages/shared`          | Types and utilities shared by the workspaces                                                                                                                    |
| `packages/sandbox-runtime` | Python that runs inside a sandbox (the Claude and OpenCode harnesses, `mem`, `library`, `gateway-key`)                                                          |
| `packages/sandbox-images`  | The sandbox image build and its build-hash; `packages/vercel-infra` talks to Vercel sandboxes                                                                   |
| `packages/demo-app`        | Demo Studio, the reference product on the engine: mock accounts, credits and MCP tools, chat and preview (see its README)                                       |
| `packages/*-infra`         | Build tooling of the other sandbox providers (Modal, Daytona, E2B, OpenComputer); the engine runs on Vercel                                                     |
| `packages/gateway`         | The LLM gateway: one core (`src/core`), the Cloudflare Worker host (`src/worker`, what dev runs) and the Node host (`src/node`, SQLite; the local stacks)       |
| `skills/builtin`           | Skills baked into the sandbox image (creative examples and platform plumbing); `scripts/gen-builtin-skills.mjs` mirrors them into the control plane             |
| `skills/remotion-starter`  | The Remotion project the image copies in whole                                                                                                                  |
| `skills/tests`             | Tests for the skills' scripts (`mediaedit`, `mem`, `library`, ...); run by CI and `verify`                                                                      |
| `deploy/cloudflare`        | Worker configs, deploy and smoke scripts for the dev environment                                                                                                |
| `deploy/d1/migrations`     | D1 migrations (additive only)                                                                                                                                   |
| `deploy/compose`           | The local Docker stacks (`docker-compose.engine.yml` is the daily one), their overlays and `.env.example`; run `docker compose` with `-f deploy/compose/<file>` |
| `deploy/edge`              | The edge proxy's Caddyfile                                                                                                                                      |
| `terraform/modules`        | Sandbox providers' build scripts, hashed into the image build key (not applied with Terraform)                                                                  |
| `scripts/`                 | Repo tooling: lint checks, `verify.mjs`, `git-hooks/`, `agent-guard/`, `gen-builtin-skills.mjs`; `scripts/local/` the local stack; `scripts/bench/` benchmarks  |
| `docs/`                    | Docs; `docs/USER_MEMORY.md` is the memory design; `docs/upstream-changelog.md` is Open-Inspect's                                                                |

What was removed from upstream, and the providers and the older Docker stack that were kept on
purpose for switching later, is in [docs/upstream-removals.md](docs/upstream-removals.md); the
removed code is still in Open-Inspect's `4e5c1f3b`, the parent of the first commit.

The root dot-entries are the ones a tool only reads from the root (`.github`, `.husky`, `.claude`,
`.gitleaks.toml`, `.nvmrc`, `.prettierignore`); Prettier's config is in `package.json`.

### Checks

- Node 24 (`.nvmrc`); Node 26 gives false failures. Homebrew `node@24` is keg-only:
  `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- `npm run verify` runs what CI runs, one step after another (never in parallel: each vitest run
  uses every core), and prints a table with a log per step. `-- --level static` takes about a
  minute, `unit` adds the type checks and unit suites, the default (`full`) adds the integration
  tests (about ten minutes). `-- --install` first runs `npm ci` in a fresh worktree; `-- --list`
  shows the steps. `scripts/verify.test.mjs` fails if CI gains a command that `verify` lacks.
- **One version** for the whole repository (root `package.json`, every workspace, the lockfile,
  `CHANGELOG.md`), checked by `scripts/check-version.mjs` as part of `verify`; a release is that
  number plus a git tag (`docs/RELEASING.md`). A change a user would notice goes under
  `## [Unreleased]` in `CHANGELOG.md`.
- `npm run verify` proves the code, not the stack. Before merging a change to the engine, gateway,
  data plane, sandbox runtime, skills or Demo Studio, run the end-to-end check
  (`docs/LOCAL_E2E.md`).
- Sandbox-side changes (`packages/sandbox-runtime`, skill scripts) need a rebuilt base snapshot
  before the deploy. New routes need the frozen route tables updated. D1 migrations are additive
  only: `scripts/check-migrations.mjs` checks names and numbers, and on a pull request that an
  applied migration is not edited and a new one is numbered above the target branch's.

### What enforces the red lines

- **Git hooks** (`.husky`, installed by `npm install`): `commit-msg` wants a conventional English
  subject (`scripts/git-hooks/commit-message.mjs`); `pre-push` lets `main` move only forward, to a
  commit with a release tag (`v<major>.<minor>.<patch>`), and refuses deleting it.
- **Agent guard** (`.claude/settings.json` -> `scripts/agent-guard/`): a Claude Code hook that holds
  even when permission prompts are off. It refuses `git stash`, a force-push or delete of `main`,
  and `--all` / `--mirror`; it refuses `git push`, `gh pr create|merge` and API writes to the
  repository unless the user's message in _this turn_ says "推送" or "push" (the next message resets
  it); it asks before `wrangler delete`, `create-env.sh`, a direct `wrangler deploy` and
  `ALLOW_DIRTY=1`. If it blocks you, tell the user what you wanted to do; do not look for a way
  around it.
- Both are checked by `npm run test:harness`.

## Architecture

```
product backend (signs as `app`, ──► engine (packages/control-plane: Node host, or Worker + Durable Objects + D1 + R2)
relays its users as app:<id>)         │  one Durable Object per session; user memory, user files, spend
        ▲                             ├─► sandbox (local Docker or Vercel; image from packages/sandbox-images,
        │                             │   Claude or OpenCode harness from packages/sandbox-runtime, skills from skills/builtin)
        │                             ├─► LLM gateway (packages/gateway) ──► OpenRouter   (Anthropic traffic only;
        │                             │   OpenAI/xAI go to their providers with the session's own key or subscription)
        └── MCP tools, short-lived ◄──┘   (the product's MCP server, APP_MCP_URL; tokens from APP_TOKEN_URL)
            tokens, credits
```

**Build `@open-inspect/shared` first** whenever you change shared types: the other workspaces import
it built (`npm run build -w @open-inspect/shared`).

## Common Commands

```bash
npm install
npm run build -w @open-inspect/shared            # build first
npm run lint:fix                                 # ESLint + Prettier fix
npm run typecheck                                # tsc across the TypeScript packages
npm test -w @open-inspect/control-plane          # unit tests (node env)
npm run test:integration -w @open-inspect/control-plane  # integration (workerd/Miniflare + real D1)
npm test -w @open-inspect/gateway               # gateway (workerd, then the Node host)
python3 -m unittest discover -s skills/tests -p 'test_*.py'    # the skills' scripts
cd packages/sandbox-runtime && pytest tests/ -v  # sandbox runtime
npm run verify                                   # all of CI, in order (see Checks)
scripts/local/stack.sh up                        # the whole local stack (docs/LOCAL_E2E.md)
npm run e2e:local                                # API end-to-end checks; --no-model costs nothing
npm run e2e:ui                                   # browser end-to-end checks (npx playwright-core install chromium once)
npm run check:version                            # the one-version check
```

## Testing

TypeScript uses **Vitest**; Python uses **pytest** (the skills' scripts use `unittest`).

- **control-plane unit**: co-located as `src/**/*.test.ts`, Node environment.
- **control-plane integration**: `test/integration/*.test.ts`, run in workerd via
  `@cloudflare/vitest-pool-workers` with real D1 bindings. They share one D1 instance: clean up in
  `beforeEach`/`afterEach`. Migrations from `deploy/d1/migrations/` are applied by
  `test/integration/apply-migrations.ts`; helpers are in `test/integration/helpers.ts`.
- **cron and queue parity**: `src/scheduled-jobs.test.ts` and `src/cloudflare/job-queue.test.ts`
  hold the code's jobs to `deploy/cloudflare/wrangler.staging.jsonc`.
- **end to end**: `scripts/local/e2e-demo.mjs` (API) and `e2e-ui.mjs` (Chromium) drive the running
  local stack through Demo Studio. A scenario asserts something a user can see (a reply, a charge, a
  refusal), and one that needs no model does not call one. Procedure: `docs/LOCAL_E2E.md`.
- **Demo Studio's UI** is built from `packages/demo-app/web/ui/` and design tokens, and
  `web/design/design-rules.test.ts` enforces it (`packages/demo-app/DESIGN.md`).

## Coding Conventions

- **Seconds for Python, milliseconds for TypeScript**, with the unit in the name (`timeout_seconds`,
  `timeoutMs`); never a bare `timeout`. Define each default once as a named constant and don't
  restate its value in comments.
- When threading an existing field through new code, check the existing name, type and unit are
  right; fix them in the same change rather than spreading the problem.
- **Commit messages**: conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`),
  English, subject short, the reason in the body. The `commit-msg` hook checks it.

## Key Gotchas

- **PKCS#8 keys**: Cloudflare Workers require PKCS#8 for private keys; convert with
  `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`.
- **Repo owners can be nested namespaces** (`group/subgroup` on GitLab): only `repo_name` is a
  single path segment. Use the shared repository identity helpers; where a full `owner/name` string
  is unavoidable, split on the last `/` and encode the owner as one route segment.

## CI/CD

`.github/workflows`: `ci.yml` (TypeScript, gateway, skills' scripts) and `ci-python.yml` (sandbox
runtime and images), run on pull requests into `dev` and by hand. There is no deploy workflow.

## Further Reading

- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — architecture and session lifecycle (from upstream)
- [deploy/cloudflare/README.md](deploy/cloudflare/README.md) — the dev environment, secrets, deploy
- [packages/control-plane/README.md](packages/control-plane/README.md) — API, WebSocket protocol, D1
  schema
- [docs/USER_MEMORY.md](docs/USER_MEMORY.md) — user memory: layers, rules, routes, the after-turn
  jobs
- [packages/demo-app/README.md](packages/demo-app/README.md) — how a product plugs into the engine
- [packages/demo-app/DESIGN.md](packages/demo-app/DESIGN.md) — Demo Studio's design system: tokens,
  components, rules (read before touching its UI)
- [docs/LOCAL_E2E.md](docs/LOCAL_E2E.md) — the local end-to-end check: what it covers and how to run
  it
- [CHANGELOG.md](CHANGELOG.md) and [docs/RELEASING.md](docs/RELEASING.md) — release notes, and how
  to cut a version (`main` holds the released versions)
- [docs/UPSTREAM.md](docs/UPSTREAM.md) — the relationship to Open-Inspect, and how a fix is taken
  from it
