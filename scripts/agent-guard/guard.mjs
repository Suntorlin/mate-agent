#!/usr/bin/env node
/**
 * Claude Code hook that holds an agent session to the red lines in AGENTS.md. Registered for two
 * events in .claude/settings.json:
 *
 *   UserPromptSubmit  records whether the user's message tells the agent to push. The record is for
 *                     that turn only: the next message replaces it, so an earlier "推送" does not
 *                     carry over to the next task.
 *   PreToolUse (Bash) refuses or asks about the commands in rules.mjs.
 *
 * Hooks run even when the session skips permission prompts. A hook that fails on its own account
 * (bad input, an unreadable state file) lets the command through: a guard that breaks the agent
 * gets switched off, and the git hooks in .husky stand behind this one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { approvesPush, classify } from "./rules.mjs";

const stateDir = () => process.env.AGENT_GUARD_STATE_DIR ?? join(tmpdir(), "agent-engine-guard");
const stateFile = (sessionId) =>
  join(stateDir(), `${String(sessionId).replace(/[^\w-]/g, "_")}.json`);

function readApproval(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8")).pushApproved === true;
  } catch {
    return false;
  }
}

/** @returns {object | null} the hook output to print, or null to stay silent */
export function handle(input) {
  if (input.hook_event_name === "UserPromptSubmit") {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      stateFile(input.session_id),
      JSON.stringify({ pushApproved: approvesPush(String(input.prompt ?? "")), at: Date.now() })
    );
    return null;
  }
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return null;

  const findings = classify(String(input.tool_input?.command ?? ""));
  const pushApproved = readApproval(input.session_id);
  const blocking = findings.filter((f) => f.action !== "push" || !pushApproved);
  if (blocking.length === 0) return null;

  const denied = blocking.some((f) => f.action === "deny");
  const asks = blocking.every((f) => f.action === "ask");
  const needsPush = blocking.some((f) => f.action === "push");
  const reason = [
    ...new Set(blocking.map((f) => f.message)),
    needsPush
      ? 'If the user wants this, they say "推送" (or "push") in their message; then retry.'
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: !denied && asks ? "ask" : "deny",
      permissionDecisionReason: `agent-guard: ${reason}`,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const output = handle(JSON.parse(readFileSync(0, "utf8")));
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`agent-guard: ignored an error (${error.message})\n`);
  }
}
