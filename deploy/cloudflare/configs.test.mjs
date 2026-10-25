// The environments' Worker configs are copies of each other with their resource names changed, and a
// copy drifts: a binding or a variable added to one environment and forgotten in the next shows up
// as a bug in the next deploy. This holds them to the same shape, and each to its own names.
//
//   node --test deploy/cloudflare/configs.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const DIRECTORY = new URL("./", import.meta.url);

/** The value of a JSONC file: `//` comments and trailing commas removed outside of strings. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const read = (name) => parseJsonc(readFileSync(new URL(name, DIRECTORY), "utf8"));
const ENVIRONMENTS = readdirSync(DIRECTORY)
  .map((name) => /^wrangler\.([a-z0-9]+)\.jsonc$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();

/** Variables whose value belongs to the environment (where it points, what it may spend). */
const PER_ENVIRONMENT_VARS = new Set([
  "VERCEL_BASE_SNAPSHOT_ID",
  "WEB_APP_URL",
  "OBJECT_STORE_ENDPOINT",
  "OBJECT_STORE_PUBLIC_ENDPOINT",
  "OBJECT_STORE_CORS_ORIGINS",
  "LLM_BUDGET_USD",
  "LLM_USER_BUDGET_USD",
  "LLM_MONTHLY_BUDGET_USD",
  "LLM_ALERT_WEBHOOK_URL",
]);

/** The config with the environment's name replaced by ENV in every string, and its ids removed. */
function normalized(config, env) {
  // The resource prefix, a queue's trailing -env, and a bare name: not the ".dev" of workers.dev.
  const prefix = new RegExp(`agent-engine-${env}(?=$|[-./])`, "g");
  const suffix = new RegExp(`-${env}$`);
  const walk = (value) => {
    if (typeof value === "string") {
      if (value === env) return "ENV";
      return value.replace(prefix, "agent-engine-ENV").replace(suffix, "-ENV");
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const copy = walk(structuredClone(config));
  for (const database of copy.d1_databases ?? []) delete database.database_id;
  for (const namespace of copy.kv_namespaces ?? []) delete namespace.id;
  for (const key of PER_ENVIRONMENT_VARS) {
    if (copy.vars && key in copy.vars) copy.vars[key] = "(per environment)";
  }
  return copy;
}

test("each environment has its engine, gateway and bucket rules", () => {
  assert.ok(ENVIRONMENTS.length >= 1, `environments found: ${ENVIRONMENTS}`);
  const files = new Set(readdirSync(DIRECTORY));
  for (const env of ENVIRONMENTS) {
    for (const name of [`gateway.${env}.jsonc`, `r2-cors.${env}.json`]) {
      assert.ok(files.has(name), `${env} has no ${name}`);
    }
  }
});

test("every resource an environment names says which environment it is", () => {
  for (const env of ENVIRONMENTS) {
    const engine = read(`wrangler.${env}.jsonc`);
    const gateway = read(`gateway.${env}.jsonc`);
    const bucket = `agent-engine-${env}`;

    assert.equal(engine.name, `agent-engine-${env}-engine`);
    assert.equal(engine.d1_databases[0].database_name, bucket);
    assert.equal(engine.r2_buckets[0].bucket_name, bucket);
    assert.equal(engine.services[0].service, `agent-engine-${env}-gateway`);
    assert.equal(engine.vars.DEPLOYMENT_NAME, env);
    assert.equal(engine.vars.OBJECT_STORE_BUCKET, bucket);
    assert.equal(engine.vars.WORKER_URL.split(".")[0], `https://agent-engine-${env}-engine`);
    assert.equal(engine.vars.GATEWAY_URL.split(".")[0], `https://agent-engine-${env}-gateway`);
    const engineQueues = [
      ...engine.queues.producers.map((q) => q.queue),
      ...engine.queues.consumers.flatMap((q) => [q.queue, q.dead_letter_queue]),
    ];
    for (const queue of engineQueues)
      assert.ok(queue.endsWith(`-${env}`), `${env}: queue ${queue}`);

    assert.equal(gateway.name, `agent-engine-${env}-gateway`);
    assert.equal(gateway.r2_buckets[0].bucket_name, bucket);
  }
});

test("no environment is left with a placeholder id", () => {
  for (const env of ENVIRONMENTS) {
    const text = readFileSync(new URL(`wrangler.${env}.jsonc`, DIRECTORY), "utf8");
    assert.doesNotMatch(
      text,
      /__[A-Z0-9]+_ID__/,
      `${env} still has a placeholder: run create-env.sh ${env}`
    );
  }
});

// Every environment is held to the first one (alphabetically) in everything but names and ids, so
// that a binding or a variable added to one cannot be forgotten in the next, production included.
test("the environments' configs differ only in names, ids and the variables that point somewhere", () => {
  const [first, ...rest] = ENVIRONMENTS;
  for (const file of ["wrangler", "gateway"]) {
    const base = normalized(read(`${file}.${first}.jsonc`), first);
    for (const env of rest) {
      assert.deepEqual(
        normalized(read(`${file}.${env}.jsonc`), env),
        base,
        `${file}.${env}.jsonc and ${file}.${first}.jsonc differ (bindings, crons, migrations or variables)`
      );
    }
  }
});

test("the parser reads what wrangler reads: comments, trailing commas and slashes inside strings", () => {
  assert.deepEqual(parseJsonc('{ // note\n "a": "https://x.y/z", "b": [1, 2,], }'), {
    a: "https://x.y/z",
    b: [1, 2],
  });
});
