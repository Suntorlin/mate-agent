/**
 * The rules for a commit message in this repository (AGENTS.md, "Commit messages"):
 *   - the subject is a conventional commit: `type(scope): what and why`;
 *   - the subject is short. AGENTS.md asks for under 72, which a third of the history does not meet
 *     (some by a dash and a clause), so the hook only stops a subject that has become a paragraph;
 *   - the message is English. Chinese in a UI string or a quoted error is fine, so it is the share
 *     of CJK characters that is capped, not their presence.
 * Merge, revert and autosquash subjects are git's own and pass.
 */
export const TYPES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "chore",
  "test",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
];
export const SUBJECT_LIMIT = 120;
export const CJK_SHARE_LIMIT = 0.2;

const SUBJECT = new RegExp(`^(?:${TYPES.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`);
const GIT_OWN = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/gu;
const TRAILER = /^(?:Co-Authored-By|Signed-off-by|via|Reviewed-by):/i;

/** @param {string} message the message as git hands it to the commit-msg hook */
export function checkCommitMessage(message) {
  const lines = message.split("\n").filter((line) => !line.startsWith("#"));
  const subject = (lines.find((line) => line.trim() !== "") ?? "").trim();
  if (subject === "") return ["The commit message is empty."];
  if (GIT_OWN.test(subject)) return [];

  const problems = [];
  if (!SUBJECT.test(subject)) {
    problems.push(
      `The subject must look like "type(scope): what and why", with type one of ${TYPES.join(", ")}.`
    );
  }
  if (subject.length > SUBJECT_LIMIT) {
    problems.push(`The subject is ${subject.length} characters; keep it under ${SUBJECT_LIMIT}.`);
  }
  const body = lines.filter((line) => !TRAILER.test(line)).join("");
  const letters = body.replace(/\s/g, "");
  const cjk = (letters.match(CJK) ?? []).length;
  if (letters.length > 0 && cjk / letters.length > CJK_SHARE_LIMIT) {
    problems.push(
      "Write the message in English (more than a fifth of it is Chinese, Japanese or Korean)."
    );
  }
  return problems;
}
