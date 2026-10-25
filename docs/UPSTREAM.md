# Relationship to Open-Inspect

Mate Agent started from [Open-Inspect](https://github.com/ColeMurray/background-agents) at commit
`4e5c1f3b` (2026-09-29), which is the parent of the engine's first commit. It is not a GitHub fork:
GitHub shows no relation and no compare view. The git history is shared up to `4e5c1f3b`, so
`git cherry-pick` and `git merge-base` work once Open-Inspect is fetched.

## The rule

- **Nothing flows automatically.** This repository decides what it takes from Open-Inspect.
- **Take engine fixes.** A change is a candidate when it fixes code the engine still has: the
  sandbox runtime and harnesses, the session code, the data plane. Code the engine removed
  ([upstream-removals.md](upstream-removals.md)) is not a candidate.
- **Read-only.** Never push to Open-Inspect from here.
- **Migrations are not copied.** Both repositories number D1 migrations on their own. A taken change
  that needs a migration gets the next free number here.

## How to take a change

```bash
git remote add upstream https://github.com/ColeMurray/background-agents.git   # once
git remote set-url --push upstream DISABLED                                   # once: read-only
git fetch upstream --no-tags
git log --no-merges --format='%h %ad %s' --date=short 4e5c1f3b..upstream/main  # what is new there
```

Then, for each candidate, on a branch from `dev`:

1. Try it: `git cherry-pick -x <sha>`. The `-x` records the source commit in the message. If it
   applies cleanly and the tests pass, that is the whole change.
2. If it does not apply (a file was renamed or removed here), port it by hand and say so in the
   commit message with the source commit's id.
3. If the code it fixes does not exist here, skip it.
4. Run `npm run verify`, and the end-to-end check ([LOCAL_E2E.md](LOCAL_E2E.md)) for a sandbox or
   engine change. Put a user-visible change under `## [Unreleased]` in `CHANGELOG.md`.

Open-Inspect's own changelog, up to `4e5c1f3b`, is [upstream-changelog.md](upstream-changelog.md);
what was removed from it is [upstream-removals.md](upstream-removals.md).
