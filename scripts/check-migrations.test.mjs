import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkAgainstBase, checkNames } from "./check-migrations.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("a migration name must be a number and snake_case words", () => {
  assert.deepEqual(
    checkNames(["0001_create_repo_secrets.sql", "0099_workflow_run_session.sql"]),
    []
  );
  assert.deepEqual(
    checkNames(["001_short.sql", "0002_Caps.sql", "0003-dash.sql", "0004_ok.sql"]).map(
      (p) => p.split(":")[0]
    ),
    ["0002_Caps.sql", "0003-dash.sql", "001_short.sql"]
  );
});

test("two migrations may not share a number", () => {
  assert.deepEqual(checkNames(["0099_a.sql", "0099_b.sql"]), [
    "0099_b.sql: number 0099 is also used by 0099_a.sql",
  ]);
});

test("gaps in the numbering are fine", () => {
  assert.deepEqual(checkNames(["0045_a.sql", "0047_b.sql"]), []);
});

test("a new migration must come after everything on the base branch", () => {
  const baseNames = ["0098_skill_locales.sql", "0099_workflow_run_session.sql"];
  assert.deepEqual(
    checkAgainstBase({ baseNames, changes: [{ status: "A", path: "0100_next.sql" }] }),
    []
  );
  const behind = checkAgainstBase({
    baseNames,
    changes: [{ status: "A", path: "0099_other.sql" }],
  });
  assert.equal(behind.length, 1);
  assert.match(behind[0], /^0099_other\.sql: the base branch already has 0099; renumber/);
  assert.equal(
    checkAgainstBase({ baseNames, changes: [{ status: "A", path: "0050_gap.sql" }] }).length,
    1,
    "a free number below the highest is still out of order"
  );
});

test("a migration the base branch has may not be edited, deleted or renamed", () => {
  const baseNames = ["0001_a.sql", "0002_b.sql"];
  const changes = [
    { status: "M", path: "0001_a.sql" },
    { status: "D", path: "0002_b.sql" },
    { status: "R", path: "0002_b.sql" },
  ];
  const problems = checkAgainstBase({ baseNames, changes });
  assert.match(problems[0], /0001_a\.sql: .* edited here/);
  assert.match(problems[1], /0002_b\.sql: .* deleted here/);
  assert.match(problems[2], /0002_b\.sql: .* renamed here/);
});

test("a migration the base branch lacks may be edited while the branch is open", () => {
  assert.deepEqual(
    checkAgainstBase({
      baseNames: ["0001_a.sql"],
      changes: [{ status: "M", path: "0002_mine.sql" }],
    }),
    []
  );
});

test("this repository's migrations pass", () => {
  const out = execFileSync("node", ["scripts/check-migrations.mjs"], { cwd: repoRoot }).toString();
  assert.match(out, /^migrations ok/);
});
