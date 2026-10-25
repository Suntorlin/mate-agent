import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkCommitMessage } from "./commit-message.mjs";
import { checkPush } from "./push-refs.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));

test("a conventional English subject passes, with or without a scope or a body", () => {
  for (const message of [
    "feat(memory): a session saves its procedure as a workflow",
    "fix: the title keeps its language\n\nWhy: the prompt was Chinese.\n\nCo-Authored-By: A <a@example.com>",
    "refactor(layout)!: the gateways are one package",
    "chore(deploy): the dev environment runs the base snapshot built from dev",
    "Merge branch 'dev' into feat/x",
    'Revert "feat: x"',
    "fixup! feat: x",
  ]) {
    assert.deepEqual(checkCommitMessage(message), [], message);
  }
});

test("a subject without a type, a space after the colon or a reason is refused", () => {
  for (const message of [
    "Add Daytona web terminal support (#1988)",
    "update stuff",
    "feat(memory):no space",
    "Feat: capital",
    "wip",
    "feat(Memory): capital scope",
  ]) {
    assert.equal(checkCommitMessage(message).length, 1, message);
  }
  assert.deepEqual(checkCommitMessage("  \n# only a comment"), ["The commit message is empty."]);
});

test("a subject that has become a paragraph is refused", () => {
  assert.match(checkCommitMessage(`feat: ${"x".repeat(120)}`)[0], /characters/);
});

test("Chinese is refused as the language of a message but fine inside an English one", () => {
  assert.match(checkCommitMessage("fix: 修复会话标题没有跟随语言的问题")[0], /English/);
  assert.deepEqual(
    checkCommitMessage('fix(media): the card says "成片 v2" after a revision, not the prompt text'),
    []
  );
  assert.deepEqual(checkCommitMessage("feat: x\n\nvia [a tool](https://example.com)\n"), []);
});

/** A stand-in for the repository: which tags a commit has, and which commits come after which. */
const facts = ({ tags = {}, descends = [] } = {}) => ({
  tagsAt: (sha) => tags[sha] ?? [],
  isAncestor: (ancestor, descendant) =>
    descends.some(([a, d]) => a === ancestor && d === descendant),
});

test("main takes only a tagged release that moves it forward", () => {
  const zero = "0".repeat(40);
  const [old, released, untagged] = ["a", "b", "c"].map((c) => c.repeat(40));
  const git = facts({
    tags: { [released]: ["v1.2.3"], [untagged]: ["wip", "v1.2"] },
    descends: [[old, released]],
  });
  // Other branches are free.
  assert.deepEqual(checkPush(`refs/heads/feat/x ${untagged} refs/heads/dev ${zero}\n`, git), []);
  assert.deepEqual(checkPush(`refs/heads/dev ${untagged} refs/heads/dev ${old}\n`, git), []);
  // A release that moves main forward, or creates it, is fine.
  assert.deepEqual(checkPush(`refs/heads/dev ${released} refs/heads/main ${old}\n`, git), []);
  assert.deepEqual(checkPush(`refs/heads/dev ${released} refs/heads/main ${zero}\n`, git), []);
  // A commit with no release tag is not a release (a branch-like tag does not count either).
  assert.match(
    checkPush(`refs/heads/dev ${untagged} refs/heads/main ${old}\n`, git)[0],
    /only moves to a released version/
  );
  // A release that does not follow what main has is a rewrite.
  assert.match(
    checkPush(`refs/heads/dev ${released} refs/heads/main ${untagged}\n`, git)[0],
    /not a fast-forward/
  );
  assert.match(
    checkPush(`(delete) ${zero} refs/heads/main ${old}\n`, git)[0],
    /^Deleting refs\/heads\/main/
  );
  assert.equal(
    checkPush(
      `refs/heads/a ${released} refs/heads/dev ${zero}\nrefs/heads/b ${untagged} refs/heads/main ${old}\n`,
      git
    ).length,
    1
  );
  assert.deepEqual(checkPush("", git), []);
});

// The scripts as git runs them: a throwaway repository whose hooks call these files.
test("git itself refuses the commit and the push", () => {
  const base = mkdtempSync(join(tmpdir(), "hooks-"));
  const hooks = join(base, "hooks");
  mkdirSync(hooks);
  const hook = (name, line) => {
    writeFileSync(join(hooks, name), `#!/bin/sh\nnode "${scripts}${line}"\n`);
    chmodSync(join(hooks, name), 0o755);
  };
  hook("commit-msg", 'commit-msg.mjs" "$1');
  hook("pre-push", 'pre-push.mjs" "$@');

  const run = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "dev", remote]);
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "dev", work]);
  for (const [key, value] of [
    ["core.hooksPath", hooks],
    ["user.name", "t"],
    ["user.email", "t@example.com"],
  ]) {
    execFileSync("git", ["config", key, value], { cwd: work });
  }
  run(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "a");
  run(work, "add", ".");

  const bad = run(work, "commit", "-m", "update stuff");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Commit message rejected/);

  const good = run(work, "commit", "-m", "feat: add a file");
  assert.equal(good.status, 0, good.stderr);

  // main takes a release and nothing else.
  const untagged = run(work, "push", "origin", "dev:main");
  assert.notEqual(untagged.status, 0);
  assert.match(untagged.stderr, /only moves to a released version/);
  assert.equal(run(work, "push", "origin", "dev").status, 0);
  run(work, "tag", "-a", "v0.0.1", "-m", "first");
  assert.equal(run(work, "push", "origin", "dev:main").status, 0);

  // A second release that does not descend from the first is refused, a descendant is not.
  run(work, "commit", "--amend", "-q", "-m", "feat: add a file, again");
  run(work, "tag", "-a", "v0.0.2", "-m", "rewritten");
  const rewrite = run(work, "push", "--force", "origin", "dev:main");
  assert.notEqual(rewrite.status, 0);
  assert.match(rewrite.stderr, /not a fast-forward/);
  const gone = run(work, "push", "origin", ":main");
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /Deleting refs\/heads\/main/);
});
