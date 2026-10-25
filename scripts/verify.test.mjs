import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { STEPS, selectSteps } from "./verify.mjs";

const ids = (options) => selectSteps(options).map((step) => step.id);

test("a level includes the levels below it, in the order the steps are written", () => {
  assert.ok(ids({ level: "static" }).every((id) => !["typecheck", "integration"].includes(id)));
  assert.ok(ids({ level: "unit" }).includes("typecheck"));
  assert.ok(!ids({ level: "unit" }).includes("integration"));
  assert.deepEqual(
    ids({ level: "full" }),
    STEPS.map((step) => step.id)
  );
  assert.deepEqual(ids({}), ids({ level: "full" }));
});

test("--only and --skip pick steps by name and reject a name that does not exist", () => {
  assert.deepEqual(ids({ only: ["lint", "gateway"] }), ["lint", "gateway"]);
  assert.ok(!ids({ skip: ["integration"] }).includes("integration"));
  assert.throws(() => selectSteps({ only: ["nope"] }), /no step called nope/);
  assert.throws(() => selectSteps({ level: "huge" }), /--level must be one of/);
});

test("--install puts the installs first", () => {
  assert.equal(ids({ level: "static", install: true })[0], "install");
});

test("step ids are unique", () => {
  assert.equal(new Set(STEPS.map((step) => step.id)).size, STEPS.length);
});

test("verify runs every command CI's TypeScript workflow runs", () => {
  const verifies = new Set(
    STEPS.flatMap((step) => (Array.isArray(step.commands) ? step.commands : [])).map((c) =>
      c.join(" ")
    )
  );
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const ci = [...workflow.matchAll(/^\s+run: (?!\|)(.+)$/gm)]
    .map((match) =>
      match[1]
        .replace(/ -- --shard=\$\{\{[^}]*\}\}$/, "") // verify does not shard
        .replace(/ --base origin\/\$\{\{[^}]*\}\}$/, "") // it compares with origin/dev itself
        .replace(/'/g, "")
        .trim()
    )
    .filter((command) => !/^npm ci( |$)/.test(command));
  const missing = ci.filter((command) => !verifies.has(command));
  assert.deepEqual(
    missing,
    [],
    "CI runs these and verify does not; add them to STEPS in scripts/verify.mjs"
  );
});
