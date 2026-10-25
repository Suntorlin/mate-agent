/**
 * Which pushes the repository refuses (AGENTS.md, red lines). `dev` is the trunk. `main` holds
 * released versions only: it moves forward, never backward, and only to a commit that carries a
 * release tag (`v<major>.<minor>.<patch>`, docs/RELEASING.md). No other branch is restricted.
 */
import { execFileSync, spawnSync } from "node:child_process";

const MAIN = "refs/heads/main";
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ZERO_SHA = /^0+$/;

/** The two questions the rule asks of the repository; tests pass a stand-in. */
export const gitFacts = {
  /** Tags that point exactly at a commit. */
  tagsAt: (sha) =>
    execFileSync("git", ["tag", "--points-at", sha], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  /** Whether `ancestor` is reachable from `descendant` (false too when it is not here at all). */
  isAncestor: (ancestor, descendant) =>
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0,
};

/**
 * @param {string} stdin the lines git feeds a pre-push hook: `<local ref> <local sha> <remote ref> <remote sha>`
 * @param {typeof gitFacts} [git]
 * @returns {string[]} one message per refused ref
 */
export function checkPush(stdin, git = gitFacts) {
  const problems = [];
  for (const line of stdin.split("\n").filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
    if (remoteRef !== MAIN) continue;
    if (localRef === "(delete)") {
      problems.push(`Deleting ${MAIN} is refused: it holds the released versions.`);
      continue;
    }
    if (!git.tagsAt(localSha).some((tag) => RELEASE_TAG.test(tag))) {
      problems.push(
        `Pushing to ${MAIN} is refused: it only moves to a released version. Tag the commit v<major>.<minor>.<patch> first (docs/RELEASING.md).`
      );
    } else if (!ZERO_SHA.test(remoteSha ?? "") && !git.isAncestor(remoteSha, localSha)) {
      problems.push(
        `Pushing to ${MAIN} is refused: it is not a fast-forward of the remote ${MAIN} (fetch, and release from dev).`
      );
    }
  }
  return problems;
}
