# Contributing

Thank you for helping. This page says how a change gets in.

## Before you start

1. Read [AGENTS.md](../AGENTS.md). It holds the red lines, the layout and the checks, for people and
   agents alike.
2. For a large change, open an issue first, so we can agree on the approach.

## Set up

Node 24 is required (`.nvmrc`). Then:

```bash
npm ci
npm run build -w @open-inspect/shared
npm run verify -- --level static   # about a minute
```

To run the whole engine on your machine, see "Run it on this machine" in the [README](../README.md).

## Make a change

1. Branch from `dev`. `main` holds released versions only.
2. Keep one change per pull request.
3. Add or change tests with the code.
4. Run `npm run verify` before you open the pull request. It runs what CI runs.
5. For a change to the engine, the gateway, the data plane, the sandbox runtime, the skills or Demo
   Studio, also run the end-to-end check ([docs/LOCAL_E2E.md](../docs/LOCAL_E2E.md)).
6. Put a change that a user notices under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).

## Rules the checks enforce

- **Commit messages** are conventional and in English: `feat:`, `fix:`, `docs:`, `refactor:`,
  `chore:`, `test:`. The `commit-msg` hook checks them.
- **D1 migrations** are additive only. Never edit a migration that is on `dev`. A new one takes the
  next free number (`scripts/check-migrations.mjs`).
- **The root** keeps only the entries listed in `scripts/check-layout.mjs`.
- **Secrets** never go into files, docs or logs. Local secrets live in ignored `.env*` files.
  `scripts/check-public-safety.ts` checks every commit (the pre-commit hook and CI) for secrets,
  personal paths and private addresses. If a line really must stay, end it with the comment
  `public-safety: allow`.

## Open the pull request

Open it into `dev`. Say what changed, why, and how you tested it. CI must pass before a merge.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](../LICENSE).
