# Changelog

One section per version, newest first; the format follows
[Keep a Changelog](https://keepachangelog.com) and the version is [semantic](https://semver.org).
The number lives in the root `package.json`, every workspace carries the same one, and
`scripts/check-version.mjs` fails `npm run verify` and CI if the workspaces, `package-lock.json` or
this file disagree. How to cut one: [docs/RELEASING.md](docs/RELEASING.md).

Open-Inspect's own history, from before the fork, is in
[docs/upstream-changelog.md](docs/upstream-changelog.md).

## [Unreleased]

## [0.2.1] - 2026-10-25

No code changed.

### Changed

- Dependency updates come as one grouped pull request per ecosystem a week, into `dev`
  (`.github/dependabot.yml`): npm, uv for the sandbox runtime, and GitHub Actions. Dependabot's
  automatic security pull requests are off, because they always target `main`; the security alerts
  stay on.

## [0.2.0] - 2026-10-25

The first public version of Mate Agent: a general-purpose agent runtime built on Open-Inspect
(`ColeMurray/background-agents`, commit `4e5c1f3b`), with a reference product, a local stack and an
end-to-end check. Local only: there is no cloud environment (see [AGENTS.md](AGENTS.md), "Red
lines"). Versions 0.1.0 to 0.1.2 were not published.

### Added

- **Demo Studio** (`packages/demo-app`), the reference product on the engine: accounts, credits, its
  own MCP server (balance, notes, a priced mock image tool), chat with a live stream, and a
  sandboxed preview of what the agent publishes. The engine reports each turn's cost and runtime so
  the product can settle credits.
- **A design system for Demo Studio's web app**: tokens, a component library (`web/ui/`), a showcase
  page (`/design.html`), the rules as a test, and [DESIGN.md](packages/demo-app/DESIGN.md). Light
  and dark themes.
- **An app shell** for it: a bottom tab bar and full screens on a phone, an icon rail with the chat
  list, the chat and the preview side by side on a desktop; location in the URL hash.
- **A one-command local stack** (`scripts/local/stack.sh up|status|logs|down`) with configurable
  ports, and **local end-to-end checks**: `npm run e2e:local` (14 API scenarios, 7 of which cost
  nothing) and `npm run e2e:ui` (16 browser scenarios on Chromium, desktop and phone). The procedure
  is [docs/LOCAL_E2E.md](docs/LOCAL_E2E.md).
- **User memory** ([docs/USER_MEMORY.md](docs/USER_MEMORY.md)), with a profile layer the user owns;
  inline turns see the user's memory.
- The local stack's models run through the LLM gateway; the local sandbox image includes OpenCode.
- `scripts/check-version.mjs`: one version for the whole repository.
- `scripts/check-public-safety.ts` (from Matemind): the pre-commit hook, `npm run verify` and CI
  refuse secrets, private names, personal paths and private addresses.
- **`main` is the release branch.** It holds released versions only: the `pre-push` hook accepts it
  on a commit that carries a `v<major>.<minor>.<patch>` tag, as a fast-forward, never deleted; the
  agent guard refuses a force-push or delete of it. `dev` is the trunk. See
  [docs/RELEASING.md](docs/RELEASING.md).
- The sandbox reads the documents users attach: PDF (`pdftotext`), `.doc` (`catdoc`), `.ppt`
  (`catppt`), `.xls` (`xlrd`), `.xlsx` (`openpyxl`), `.pptx` (`python-pptx`), and the note that
  names the attached files says which tool reads which.
- `APP_MCP_NAME` names the product's MCP server (default `app`), so a product's tools can keep their
  own namespace, e.g. `mcp__acme__text_to_speech`.
- Usage reports: with `LLM_USAGE_REPORT_URL` and `LLM_USAGE_REPORT_TOKEN` set, the gateway POSTs
  each settled LLM call of a product's user to the product, so it can bill per call (including cache
  keep-alive pings and the memory jobs' calls). The control plane names the product's user in the
  gateway token of an `app:<id>` session. Reports wait in the ledger and its alarm sends them, again
  after a failure (30 s doubling to an hour, 12 attempts); the admin overview counts the waiting and
  the dead ones. The inline runtime calls its model directly, not through the gateway, so a product
  that bills per call leaves `INLINE_LLM_BASE_URL` unset.
- Media generations on the timeline: `POST /sessions/:id/media-generations` takes a report of an
  image, video or voiceover the product made for the session (from the session owner's product, or
  the session's sandbox) and merges it into the generation's one `media_generation` event, which
  shows it running, then succeeded or failed. A generation's `costUsd` counts against the session's
  budget, beside the model's cost; `credits` is what the product shows for it.
- Every call to the product's MCP server names the engine session it comes from (`X-Agent-Session`),
  from a sandbox's proxy and from the inline runtime alike, so the product can file what a tool
  makes under the session. The proxy drops the header when the agent sends one itself.

### Changed

- What was removed from Open-Inspect, and what was kept for switching providers later, is in
  [docs/upstream-removals.md](docs/upstream-removals.md).
- The LLM gateway is one package (`packages/gateway`) with a Worker host and a Node host, and the
  Docker data plane is `packages/docker-dataplane`.
- Sessions run on the Claude harness; OpenAI and xAI sessions run on OpenCode.
- The inline runtime records a call to one of the product's tools as `mcp__<name>__<tool>`, the name
  a sandbox's agent records for the same call. It used to record the bare tool name.

### Fixed

- Claude Code's own auto memory is off in sandboxes, so the engine's user memory is the only one.
- The mock image's caption stays inside the picture.
- Page titles in Demo Studio are headings, and every control is at least 44px on a phone.
- The Docker service tests no longer overflow macOS's unix-socket path limit.
- The agent's text no longer carries U+FFFD (the replacement character) where a multi-byte character
  was split across two reads.
- A product's persona reaches a sandbox's agent whole. Claude Code cut an MCP server's instructions
  (and each tool description) at 2,048 characters without a word; the harness now raises the cap to
  16,384 (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`).
- The sandbox finds the product's MCP server by its id (`app`) rather than its name, so a product
  that names it with `APP_MCP_NAME` keeps the token renewal and the spending cap of the proxy.
- A Claude session no longer stops working after the user stops it four times. A stop does not count
  against the agent's restart budget, and a finished turn resets it, so only three failed restarts
  in a row end the session.
- A turn whose sandbox bridge process crashed and restarted fails within seconds, with a message to
  send it again. It used to stay "running" until the execution timeout (two hours by default). The
  control plane asks the bridge about the processing message (`reconcile_prompt`) after every
  `ready`, and a bridge process that never received it answers with a failed `execution_complete`. A
  bridge that only reconnected received it and ignores the question.

### Known limits

- Nothing is deployed; `deploy/cloudflare` holds templates with placeholder ids.
- OpenCode sessions are not covered by the end-to-end checks.
- A service restarted in the middle of a turn, real-phone safe areas and pixel-level appearance are
  not tested.
- Package names keep the `@open-inspect/*` scope from upstream.

[Unreleased]: https://github.com/Suntorlin/mate-agent/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Suntorlin/mate-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Suntorlin/mate-agent/releases/tag/v0.2.0
