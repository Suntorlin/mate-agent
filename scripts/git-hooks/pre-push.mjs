#!/usr/bin/env node
// .husky/pre-push: node scripts/git-hooks/pre-push.mjs <remote> <url>   (git writes the refs to stdin)
import { readFileSync } from "node:fs";

import { checkPush } from "./push-refs.mjs";

const problems = checkPush(readFileSync(0, "utf8"));
if (problems.length > 0) {
  console.error(`Push rejected:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
