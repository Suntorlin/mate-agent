#!/usr/bin/env node
// .husky/commit-msg: node scripts/git-hooks/commit-msg.mjs <file git wrote the message to>
import { readFileSync } from "node:fs";

import { checkCommitMessage } from "./commit-message.mjs";

const problems = checkCommitMessage(readFileSync(process.argv[2], "utf8"));
if (problems.length > 0) {
  console.error(
    `Commit message rejected:\n- ${problems.join("\n- ")}\n(AGENTS.md, "Commit messages")`
  );
  process.exit(1);
}
