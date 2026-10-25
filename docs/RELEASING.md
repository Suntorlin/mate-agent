# Releasing

A version is one number, in the root `package.json`, shared by every workspace, plus the git tag
`v<version>` on the commit that carries it. `scripts/check-version.mjs` (part of `npm run verify`
and CI) fails if the workspaces, `package-lock.json` or `CHANGELOG.md` disagree.

Versions follow [semantic versioning](https://semver.org). While the major version is 0, a change
that breaks a stored format, a route or an environment variable raises the minor number, and
everything else the patch number.

## Cut a version

Start from an up-to-date `dev` with a clean tree. Never push without the maintainer asking in that
turn (AGENTS.md, "Red lines"); a tag is a push.

1. **Move `## [Unreleased]` in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD`** and leave an
   empty `## [Unreleased]` above it. Write what a user of the engine notices (Added, Changed, Fixed,
   Removed, Known limits), not a commit list. Update the compare links at the bottom.
2. **Raise the number everywhere:**
   `npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root`
3. **Check it all, in this order** (each is a few minutes; never in parallel):
   - `npm run verify`: everything CI runs, with the integration tests.
   - `scripts/local/stack.sh up`, then `npm run e2e:local` and `npm run e2e:ui` (a few cents of
     model spend), then `scripts/local/stack.sh down`. Both must end with their `OK` line; see
     [LOCAL_E2E.md](LOCAL_E2E.md).
4. **Commit** as `chore: release x.y.z`, then **tag** it: `git tag -a vx.y.z -m "Mate Agent x.y.z"`.
5. **Move `main` to the release:** `git branch -f main vx.y.z` (or create it the first time). `main`
   holds the released versions only: the `pre-push` hook accepts it only on a commit with a release
   tag, only as a fast-forward of the remote `main`, and never deleted.
6. **Publish** only when the maintainer says so: push `dev`, the tag and `main` together
   (`git push origin dev vx.y.z main`). Pushing `main` starts the CI workflows on GitHub. No cloud
   environment is touched by a release.

## After the tag

A fix to a released version is a normal commit on `dev` with a new patch number, released the same
way (`main` follows `dev` only through a tag). Do not move or delete a tag that has been pushed; cut
the next version instead.
