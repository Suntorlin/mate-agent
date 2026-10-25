/**
 * User-memory extraction eval (docs/USER_MEMORY.md): replays scripted users through the same
 * extraction the after-turn job runs (prompt, model, parsing, service rules) against a throwaway
 * database, then grades the memory each user ends with:
 *
 * - must:        assertions judged by a stronger model against the final memory
 * - must_not:    keywords that may not appear in current memory, or in the listed layers
 *                (tool errors anywhere; a one-off setting outside its project)
 * - superseded:  a corrected preference must have replaced the old value
 *
 * Calls the LLM gateway: Haiku for extraction (as in production), Sonnet for grading.
 *
 *   npx esbuild scripts/memory-eval.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/memory-eval.mjs --external:node:* \
 *     --banner:js="import { createRequire as r } from 'node:module'; const require = r(import.meta.url);"
 *   GATEWAY_URL=http://127.0.0.1:8790 GATEWAY_SECRET=… \
 *     node /tmp/memory-eval.mjs <scenarios.json> [--limit N] [--concurrency N] [--out results.json]
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyUserMemoryExtraction,
  parseExtraction,
  userMemoryExtractBatchId,
  userMemoryExtractionPrompt,
  userMemoryExtractionSystemPrompt,
} from "../src/memory/extract";
import { askUserMemoryModel, type UserMemoryModelReply } from "../src/memory/llm";
import { UserMemoryService } from "../src/memory/service";
import { UserMemoryStore } from "../src/memory/store";
import { openNodeSqlDatabase } from "../src/node/sqlite-database";

interface Scenario {
  id: string;
  lang: string;
  today: string;
  name: string;
  turns: { creator: string; agent: string }[];
  gold: {
    must: string[];
    must_not: { any: string[]; label: string; layers?: string[] }[];
    superseded: { old: string[]; new: string[] };
    date: { any: string[] };
  };
}

const JUDGE_MODEL = "claude-sonnet-5-5";
const PRICES = {
  extract: { input: 1, output: 5 }, // Haiku 4.5, USD per million tokens
  judge: { input: 2, output: 10 }, // Sonnet 5.5
};

const args = process.argv.slice(2);
const scenarioPath = args.find((arg) => !arg.startsWith("--"));
const limit = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const concurrency = Number(args[args.indexOf("--concurrency") + 1]) || 1;
if (!scenarioPath) {
  console.error(
    "usage: node memory-eval.mjs <scenarios.json> [--limit N] [--concurrency N] [--out results.json]"
  );
  process.exit(64);
}
const gatewayUrl = process.env.GATEWAY_URL?.replace(/\/+$/, "");
const gatewaySecret = process.env.GATEWAY_SECRET;
if (!gatewayUrl || !gatewaySecret) {
  console.error("GATEWAY_URL and GATEWAY_SECRET are required");
  process.exit(64);
}
const gateway = { kind: "gateway", gateway: { url: gatewayUrl, secret: gatewaySecret } } as const;

/** Matches a keyword: whole words for Latin text, substrings for CJK. */
function mentions(text: string, keyword: string): boolean {
  if (/^[\x20-\x7e]+$/.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z])${escaped}($|[^A-Za-z])`, "i").test(text);
  }
  return text.includes(keyword);
}

const judgeFetch: typeof fetch = (input, init) => {
  const body = JSON.parse(String(init?.body));
  return fetch(input, { ...init, body: JSON.stringify({ ...body, model: JUDGE_MODEL }) });
};

/** The judge's last `{"results": …}` object (it sometimes answers twice, correcting itself). */
function lastResults(text: string): { results: { n: number; ok: boolean }[] } {
  const starts = [...text.matchAll(/\{\s*"results"/g)].map((match) => match.index!);
  for (const start of starts.reverse()) {
    for (let end = text.indexOf("}", start); end !== -1; end = text.indexOf("}", end + 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // not closed yet
      }
    }
  }
  throw new Error(`the judge did not answer with results: ${text.slice(0, 200)}`);
}

async function judge(
  memoryText: string,
  assertions: string[]
): Promise<{
  results: boolean[];
  reply: UserMemoryModelReply;
}> {
  const system =
    "You grade whether a user's memory store contains specific facts. Judge the meaning, not the wording: a fact counts when an entry captures its gist, even if it is phrased differently, shortened, or combined with other facts in one entry. Entries marked pending count. Answer with JSON only.";
  const prompt = [
    "<memory>",
    memoryText,
    "</memory>",
    "<assertions>",
    ...assertions.map((assertion, index) => `${index + 1}. ${assertion}`),
    "</assertions>",
    'For each assertion say whether the memory holds that fact. Answer {"results":[{"n":1,"ok":true,"why":"…"},…]}.',
  ].join("\n");
  const reply = await askUserMemoryModel(gateway, {
    userId: "memory-eval",
    sessionId: "memory-eval-judge",
    system,
    prompt,
    maxTokens: 900,
    nowMs: Date.now(),
    fetch: judgeFetch,
  });
  const parsed = lastResults(reply.text);
  const results = assertions.map(
    (_, index) => parsed.results.find((result) => result.n === index + 1)?.ok === true
  );
  return { results, reply };
}

const scenarios = (JSON.parse(readFileSync(resolve(scenarioPath), "utf8")) as Scenario[]).slice(
  0,
  limit
);
// Run from packages/control-plane, or point MIGRATIONS_DIR at deploy/d1/migrations.
const migrationsDir = resolve(process.env.MIGRATIONS_DIR ?? "../../deploy/d1/migrations");
const dbDir = mkdtempSync(join(tmpdir(), "memory-eval-"));
const db = openNodeSqlDatabase(join(dbDir, "eval.db"), { migrationsDir });
let ids = 0;
const store = new UserMemoryStore(db);

const report: Record<string, unknown>[] = [];
const latencies: number[] = [];
const tokens = { extractIn: 0, extractOut: 0, judgeIn: 0, judgeOut: 0 };
let unparsed = 0;
let turnsRun = 0;

async function runScenario(scenario: Scenario): Promise<void> {
  const owner = `eval-${scenario.id}-${Date.now()}`;
  await db
    .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 0, 0)")
    .bind(owner)
    .run();
  const base = Date.parse(`${scenario.today}T10:00:00Z`);
  let clock = base;
  const service = new UserMemoryService({
    store,
    now: () => clock,
    generateId: () => `e${String(++ids).padStart(6, "0")}`,
  });
  const sessionId = `eval-${scenario.id}`;
  const turnLog: Record<string, unknown>[] = [];
  for (const [index, turn] of scenario.turns.entries()) {
    clock = base + index * 3_600_000;
    const rows = await store.listCurrent(owner, clock);
    const reply = await askUserMemoryModel(gateway, {
      userId: "memory-eval",
      sessionId,
      system: userMemoryExtractionSystemPrompt(scenario.today),
      prompt: userMemoryExtractionPrompt(rows, { user: turn.creator, agent: turn.agent }),
      maxTokens: 1200,
      nowMs: Date.now(),
    });
    turnsRun += 1;
    latencies.push(reply.latencyMs);
    tokens.extractIn += reply.inputTokens ?? 0;
    tokens.extractOut += reply.outputTokens ?? 0;
    const extraction = parseExtraction(reply.text);
    if (!extraction) unparsed += 1;
    const messageId = `${scenario.id}-m${index + 1}`;
    const { ops, applied } = await applyUserMemoryExtraction(
      service,
      owner,
      extraction ?? { ops: [] },
      { kind: "extractor", sessionId, messageId },
      userMemoryExtractBatchId(messageId)
    );
    turnLog.push({
      turn: index + 1,
      latencyMs: reply.latencyMs,
      proposed: extraction?.ops.length ?? null,
      valid: ops.length,
      outcomes: applied?.results.map((result) => `${result.key}:${result.outcome}`) ?? [],
      reply: reply.text,
    });
  }

  const memory = await service.list(owner);
  const current = memory.entries;
  const lines = current.map(
    (entry) => `${entry.key}${entry.status === "pending" ? " (pending)" : ""}: ${entry.content}`
  );
  const memoryText = lines.length > 0 ? lines.join("\n") : "(empty)";
  const textOf = (entries: typeof current) =>
    entries.map((entry) => `${entry.key} ${entry.content}`).join("\n");
  const everything = textOf(current);
  const violations = scenario.gold.must_not
    .filter((rule) => {
      const text = rule.layers
        ? textOf(current.filter((entry) => rule.layers!.includes(entry.layer)))
        : everything;
      return rule.any.some((keyword) => mentions(text, keyword));
    })
    .map((rule) => rule.label);
  const preferences = current
    .filter((entry) => entry.layer === "preference")
    .map((entry) => entry.content)
    .join("\n");
  const hasNew = scenario.gold.superseded.new.some((keyword) => mentions(preferences, keyword));
  const hasOld = scenario.gold.superseded.old.some((keyword) => mentions(preferences, keyword));
  const judged = await judge(memoryText, scenario.gold.must);
  tokens.judgeIn += judged.reply.inputTokens ?? 0;
  tokens.judgeOut += judged.reply.outputTokens ?? 0;

  const result = {
    id: scenario.id,
    lang: scenario.lang,
    entries: current.length,
    pending: current.filter((entry) => entry.status === "pending").length,
    must: judged.results,
    mustHit: judged.results.filter(Boolean).length,
    violations,
    superseded: hasNew && !hasOld,
    dateResolved: scenario.gold.date.any.some((keyword) => everything.includes(keyword)),
    turns: turnLog,
    memory: lines,
  };
  report.push(result);
  console.log(
    `${scenario.id} ${scenario.lang} must ${result.mustHit}/${scenario.gold.must.length}` +
      ` violations=${violations.length ? violations.join("|") : "0"}` +
      ` superseded=${result.superseded} entries=${result.entries}` +
      ` pending=${result.pending}`
  );
}

// Users are independent: run a few at once (each one's turns stay in order).
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, scenarios.length) }, async () => {
    while (next < scenarios.length) await runScenario(scenarios[next++]!);
  })
);
report.sort((a, b) => String(a.id).localeCompare(String(b.id)));

const n = report.length;
const sum = (pick: (row: Record<string, unknown>) => number) =>
  report.reduce((total, row) => total + pick(row), 0);
latencies.sort((a, b) => a - b);
const percentile = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
const mustTotal = sum((row) => (row.must as boolean[]).length);
const entriesTotal = sum((row) => row.entries as number);
const summary = {
  users: n,
  turns: turnsRun,
  mustRecall: Number((sum((row) => row.mustHit as number) / mustTotal).toFixed(3)),
  usersWithViolations: report.filter((row) => (row.violations as string[]).length > 0).length,
  junkEntries: sum((row) => (row.violations as string[]).length),
  junkRate: Number(
    (sum((row) => (row.violations as string[]).length) / Math.max(1, entriesTotal)).toFixed(3)
  ),
  supersededRate: Number((report.filter((row) => row.superseded).length / n).toFixed(3)),
  dateResolvedRate: Number((report.filter((row) => row.dateResolved).length / n).toFixed(3)),
  pendingShare: Number(
    (sum((row) => row.pending as number) / Math.max(1, entriesTotal)).toFixed(3)
  ),
  avgEntries: Number((entriesTotal / n).toFixed(1)),
  unparsedReplies: unparsed,
  extractLatencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
  costUsd: {
    extractPerTurn: Number(
      (
        (tokens.extractIn * PRICES.extract.input + tokens.extractOut * PRICES.extract.output) /
        1e6 /
        Math.max(1, turnsRun)
      ).toFixed(5)
    ),
    judgeTotal: Number(
      ((tokens.judgeIn * PRICES.judge.input + tokens.judgeOut * PRICES.judge.output) / 1e6).toFixed(
        4
      )
    ),
  },
  tokens,
};
console.log(JSON.stringify(summary, null, 2));
if (outPath) writeFileSync(resolve(outPath), JSON.stringify({ summary, report }, null, 2));
db.close?.();
