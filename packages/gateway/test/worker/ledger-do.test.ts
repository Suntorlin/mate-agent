// The ledger Durable Object: what it keeps across instances, and what its alarm does.
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import {
  BACKFILL_INTERVAL_MS,
  BACKFILL_MAX_AGE_MS,
  BACKFILL_MIN_AGE_MS,
} from "../../src/core/backfill";
import { LedgerDO } from "../../src/worker/ledger-do";
import { UPSTREAM, captureLogs, fakeFetch, keyUsage } from "../helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const named = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(name));

test("the ledger outlives its object: a new instance reads the same spend back", async () => {
  fakeFetch(() => keyUsage(0));
  captureLogs();
  const before = named("persistence");
  await before.record({ sid: "s1", sub: "u1", model: "m", usage: { cost: 1.25 } });
  await before.setUser("u2", { blocked: true }, "admin-1");
  const first = await runInDurableObject(before, (object) => object);

  await abortAllDurableObjects();
  const after = named("persistence");
  expect(await runInDurableObject(after, (object) => object), "a new instance").not.toBe(first);
  expect((await after.usage("u1")).spent_usd).toBe(1.25);
  expect((await after.user("u2")).blocked).toBe(true);
  expect(await after.check("u2")).toMatchObject({ allowed: false, status: 403 });
  const snapshot = await after.snapshot();
  expect(snapshot.ledger.by_session.s1.usd).toBe(1.25);
});

test("a cut-off call waits as pending, and the alarm settles it at the real cost", async () => {
  const lookups: string[] = [];
  let known = false;
  fakeFetch((request) => {
    if (request.url === `${UPSTREAM}/v1/key`) return keyUsage(0);
    if (request.url.startsWith(`${UPSTREAM}/v1/generation`)) {
      lookups.push(new URL(request.url).searchParams.get("id") ?? "");
      if (!known) return new Response("not found", { status: 404 });
      return Response.json({
        data: {
          total_cost: 0.07,
          native_tokens_prompt: 900,
          native_tokens_cached: 800,
          native_tokens_completion: 40,
        },
      });
    }
    throw new Error(`unexpected ${request.url}`);
  });
  const logs = captureLogs();
  const stub = named("backfill");
  const start = Date.now();
  await stub.record({
    sid: "s-cut",
    sub: "u-cut",
    model: "m",
    usage: { input_tokens: 100 },
    generationId: "gen-cut",
  });
  expect((await stub.usage("u-cut")).requests, "not counted at $0").toBe(0);
  const alarm = await runInDurableObject(stub, (_object, state) => state.storage.getAlarm());
  expect(alarm).toBeGreaterThanOrEqual(start + BACKFILL_INTERVAL_MS);

  // OpenRouter does not know the id yet: it stays pending, and the alarm comes again.
  const due = start + BACKFILL_MIN_AGE_MS + 1_000;
  vi.setSystemTime(due);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(lookups).toEqual(["gen-cut"]);
  expect((await stub.snapshot()).pending_requests).toBe(1);

  known = true;
  vi.setSystemTime(due + BACKFILL_INTERVAL_MS);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const usage = await stub.usage("u-cut");
  expect(usage.spent_usd).toBe(0.07);
  expect(usage.requests).toBe(1);
  const { ledger, pending_requests } = await stub.snapshot();
  expect(pending_requests).toBe(0);
  expect(ledger.by_user["u-cut"].input_tokens, "the stream's own count wins").toBe(100);
  expect(ledger.by_user["u-cut"].output_tokens).toBe(40);
  expect(ledger.by_user["u-cut"].cache_read_input_tokens).toBe(800);
  expect(logs.some((line) => String(line.msg).includes("backfill: settled gen-cut"))).toBe(true);
  expect(await runDurableObjectAlarm(stub), "nothing left to look up").toBe(false);
});

test("a call OpenRouter never knows is given up on after BACKFILL_MAX_AGE_MS, never billed", async () => {
  fakeFetch((request) =>
    request.url === `${UPSTREAM}/v1/key` ? keyUsage(0) : new Response("", { status: 404 })
  );
  captureLogs();
  const stub = named("give-up");
  const start = Date.now();
  await stub.record({ sid: "s", sub: "u-never", model: "m", usage: {}, generationId: "gen-never" });
  vi.setSystemTime(start + BACKFILL_MAX_AGE_MS + BACKFILL_MIN_AGE_MS);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect((await stub.snapshot()).pending_requests).toBe(0);
  expect((await stub.usage("u-never")).requests).toBe(0);
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});

test("a call sent again under the same generation id is counted once", async () => {
  fakeFetch(() => keyUsage(0));
  captureLogs();
  const stub = named("dedupe");
  const call = {
    sid: "s",
    sub: "u-twice",
    model: "m",
    usage: { cost: 0.5 },
    generationId: "gen-twice",
  };
  await stub.record(call);
  await stub.record(call);
  expect(await stub.usage("u-twice")).toMatchObject({ requests: 1, spent_usd: 0.5 });
  // A pending call sent again stays one pending call.
  const cut = {
    sid: "s",
    sub: "u-cut-twice",
    model: "m",
    usage: {},
    generationId: "gen-cut-twice",
  };
  await stub.record(cut);
  await stub.record(cut);
  expect((await stub.snapshot()).pending_requests).toBe(1);
});

test("the object sends alerts to the webhook its bindings name, and logs its settings", async () => {
  const seen = fakeFetch((request) =>
    request.url === `${UPSTREAM}/v1/key` ? keyUsage(0) : new Response("ok")
  );
  const logs = captureLogs();
  await runInDurableObject(named("wiring"), async (_object, state) => {
    const ledger = new LedgerDO(state, {
      ...env,
      LLM_MONTHLY_BUDGET_USD: "1",
      LLM_ALERT_WEBHOOK_URL: "https://hooks.test/bot",
    });
    await ledger.record({
      sid: "s",
      sub: "u",
      model: "m",
      usage: { cost: 0.9 },
      generationId: "gen-w",
    });
  });
  expect(logs.map((line) => line.msg)).toContain(
    "gateway ledger: budget $25, monthly $1, alerts on, per user $5 a month, cache keep-alive on, usage reports off"
  );
  await vi.waitFor(() =>
    expect(seen.some((request) => request.url === "https://hooks.test/bot")).toBe(true)
  );
  const hook = seen.find((request) => request.url === "https://hooks.test/bot")!;
  expect(hook.method).toBe("POST");
  expect(JSON.parse(hook.body)).toEqual({
    msg_type: "text",
    content: {
      text: `Mate Agent: AI spend this month (${new Date().toISOString().slice(0, 7)}) is $0.90 of the $1.00 monthly budget and is at 90% of it.`,
    },
  });
});
