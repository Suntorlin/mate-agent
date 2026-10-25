import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { simpleCommands } from "./commands.mjs";
import { handle } from "./guard.mjs";
import { approvesPush, classify } from "./rules.mjs";

const actions = (command) => classify(command).map((finding) => finding.action);

test("reads the commands in a line, past quotes, operators and substitutions", () => {
  assert.deepEqual(simpleCommands('cd x && git commit -m "a; git push" | cat'), [
    ["cd", "x"],
    ["git", "commit", "-m", "a; git push"],
    ["cat"],
  ]);
  assert.deepEqual(
    simpleCommands("echo $(git stash) `git push`").map((c) => c[0]),
    ["git", "git", "echo"]
  );
  assert.deepEqual(
    simpleCommands("bash -c 'git push origin dev'").map((c) => c[1]),
    ["-c", "push"]
  );
});

test("a push needs the user's word; main only moves forward, to a release", () => {
  assert.deepEqual(actions("git push"), ["push"]);
  assert.deepEqual(actions("git push -u origin feat/x"), ["push"]);
  assert.deepEqual(actions("git -C /tmp/x push origin dev"), ["push"]);
  assert.deepEqual(actions("cd repo && FOO=1 git push origin HEAD:dev"), ["push"]);
  assert.deepEqual(actions("git push origin dev:main"), ["push"]);
  assert.deepEqual(actions("git push origin dev v0.1.0 main"), ["push"]);
  assert.deepEqual(actions("sudo bash -c 'git push origin main'"), ["push"]);
  assert.deepEqual(actions("git push origin +HEAD:refs/heads/main"), ["deny"]);
  assert.deepEqual(actions("git push --delete origin main"), ["deny"]);
  assert.deepEqual(actions("git push origin :main"), ["deny"]);
  assert.deepEqual(actions("git push --force origin dev:main"), ["deny"]);
  assert.deepEqual(actions("git push -f origin main"), ["deny"]);
  assert.deepEqual(actions("git push --force-with-lease origin main"), ["deny"]);
  assert.deepEqual(actions("git push --all"), ["deny"]);
  assert.deepEqual(actions("git push --mirror"), ["deny"]);
  assert.deepEqual(actions("git push --dry-run origin main"), []);
});

test("pull requests and writes to the repository through the API need the user's word", () => {
  assert.deepEqual(actions("gh pr create --title x"), ["push"]);
  assert.deepEqual(actions("gh pr merge 12 --squash"), ["push"]);
  assert.deepEqual(actions("gh api -X PUT repos/o/r/pulls/3/merge"), ["push"]);
  assert.deepEqual(actions("gh api repos/o/r/merges -f base=dev -f head=x"), ["push"]);
  assert.deepEqual(actions("gh pr view 12"), []);
  assert.deepEqual(actions("gh pr list"), []);
  assert.deepEqual(actions("gh api repos/o/r/pulls/3"), []);
  assert.deepEqual(actions("gh run list"), []);
});

test("git stash is refused except to look at it", () => {
  assert.deepEqual(actions("git stash"), ["deny"]);
  assert.deepEqual(actions("git stash pop"), ["deny"]);
  assert.deepEqual(actions("git stash -u"), ["deny"]);
  assert.deepEqual(actions("git stash list"), []);
  assert.deepEqual(actions("git stash show -p"), []);
});

test("Cloudflare deletes, direct deploys and the dirty-checkout switch ask", () => {
  assert.deepEqual(actions("npx wrangler delete agent-engine-staging-engine"), ["ask"]);
  assert.deepEqual(actions("wrangler d1 delete agent-engine-staging"), ["ask"]);
  assert.deepEqual(actions("npx --no-install wrangler r2 bucket delete b"), ["ask"]);
  assert.deepEqual(actions("npx wrangler deploy -c deploy/cloudflare/wrangler.staging.jsonc"), [
    "ask",
  ]);
  assert.deepEqual(actions("npx wrangler deploy --dry-run"), []);
  assert.deepEqual(actions("npx wrangler tail agent-engine-staging-engine --format json"), []);
  assert.deepEqual(actions("npx wrangler deployments list"), []);
  assert.deepEqual(actions("deploy/cloudflare/create-env.sh prod"), ["ask"]);
  assert.deepEqual(actions("ALLOW_DIRTY=1 ./cf-env-deploy.sh staging"), ["ask"]);
});

test("text that only mentions a command is left alone", () => {
  for (const command of [
    'echo "git push origin main"',
    'git commit -m "never git stash here, and do not git push"',
    "grep -rn 'git stash' docs",
    "cat scripts/agent-guard/rules.mjs",
    "git status && git log --oneline -3",
    "git fetch origin && git rebase origin/dev",
    "git worktree add -b feat/x ../x dev",
    "npm run verify",
  ]) {
    assert.deepEqual(actions(command), [], command);
  }
});

test("a message approves a push only when it tells the agent to push", () => {
  for (const prompt of [
    "推送",
    "好，推送吧",
    "测试通过后推送",
    "push",
    "Please push it to dev.",
    "合并后推送一次",
  ]) {
    assert.equal(approvesPush(prompt), true, prompt);
  }
  for (const prompt of [
    "",
    "继续",
    "不要推送",
    "先别推送，等我看完",
    "完成后不要自动推送",
    "禁止推送到 main",
    "要推送吗？",
    "能不能先推送",
    "don't push yet",
    "is it OK to push?",
    "run git push origin dev and tell me what it says",
  ]) {
    assert.equal(approvesPush(prompt), false, prompt);
  }
});

function session() {
  process.env.AGENT_GUARD_STATE_DIR = mkdtempSync(join(tmpdir(), "guard-"));
  const id = `s-${Math.random().toString(36).slice(2)}`;
  return {
    say: (prompt) => handle({ hook_event_name: "UserPromptSubmit", session_id: id, prompt }),
    run: (command) =>
      handle({
        hook_event_name: "PreToolUse",
        session_id: id,
        tool_name: "Bash",
        tool_input: { command },
      }),
  };
}

test("approval lasts for the turn it was given in and no longer", () => {
  const { say, run } = session();
  say("修一下这个 bug");
  assert.equal(run("git push origin dev").hookSpecificOutput.permissionDecision, "deny");
  say("推送");
  assert.equal(run("git push origin dev"), null);
  assert.equal(run("gh pr create --title x"), null);
  assert.equal(
    run("git push origin dev:main"),
    null,
    "main takes a release once the user said push"
  );
  assert.equal(
    run("git push --force origin dev:main").hookSpecificOutput.permissionDecision,
    "deny",
    "but never a rewrite"
  );
  assert.equal(run("git stash").hookSpecificOutput.permissionDecision, "deny", "so does stash");
  say("再改一处");
  assert.equal(run("git push origin dev").hookSpecificOutput.permissionDecision, "deny");
});

test("a session nobody spoke in has no approval, and other tools are none of the guard's business", () => {
  const { run } = session();
  assert.equal(run("git push").hookSpecificOutput.permissionDecision, "deny");
  assert.equal(handle({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }), null);
  assert.equal(run("ls -la"), null);
});

test("an ask stays an ask, and the reason says how to proceed", () => {
  const { run } = session();
  const ask = run("npx wrangler delete x").hookSpecificOutput;
  assert.equal(ask.permissionDecision, "ask");
  const push = run("git push origin dev").hookSpecificOutput;
  assert.match(push.permissionDecisionReason, /^agent-guard: .*推送/);
});

test("as the hook runs: JSON in on stdin, a decision out on stdout, silence when allowed", () => {
  const env = { ...process.env, AGENT_GUARD_STATE_DIR: mkdtempSync(join(tmpdir(), "guard-")) };
  const script = fileURLToPath(new URL("./guard.mjs", import.meta.url));
  const call = (input) =>
    spawnSync("node", [script], { input: JSON.stringify(input), env, encoding: "utf8" });

  const blocked = call({
    hook_event_name: "PreToolUse",
    session_id: "x",
    tool_name: "Bash",
    tool_input: { command: "git stash" },
  });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })
      .stdout,
    ""
  );
  assert.equal(spawnSync("node", [script], { input: "not json", env, encoding: "utf8" }).status, 0);
});
