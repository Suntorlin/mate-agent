// The cache keep-alive: when it pings, what it sends, and when it stays quiet. The schedule is
// the ledger's SQLite plus its alarm; large bodies go to the Worker's R2 bucket here. Through
// the Worker itself: worker/keepalive.test.ts.
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_MAX_BODY_BYTES,
  KEEPALIVE_MAX_ROW_BODY_BYTES,
  KEEPALIVE_PINGS_PER_PASS,
  type StashedPing,
  pingBody,
  pingsAfter,
  stashPing,
} from "../../src/core/keepalive";
import { type FinishedCall, createLedger } from "../../src/core/ledger";
import type { BlobStore } from "../../src/core/sql";
import { r2Blobs } from "../../src/worker/storage";
import { type TestStorage, UPSTREAM, withLedgerStorage } from "../helpers";

const bucket = r2Blobs(env.KEEPALIVE_BUCKET);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const MODEL = "anthropic/claude-opus-5.5";
const URL_ = `${UPSTREAM}/v1/messages`;

/** A call that left its session silent, asking for `pings` pings of `body` (or of `stashed`). */
function silent(
  pings: number,
  overrides: {
    sid?: string;
    sub?: string;
    model?: string;
    body?: unknown;
    stashed?: StashedPing;
  } = {}
): FinishedCall {
  const model = overrides.model ?? MODEL;
  const stashed = overrides.stashed ?? {
    body: pingBody({ model, max_tokens: 64000, stream: true, messages: overrides.body ?? [] }),
  };
  return {
    sid: overrides.sid ?? "session-1",
    sub: overrides.sub ?? "user-1",
    model,
    usage: { cost: 0.1, cache_read_input_tokens: 50_000 },
    keepAlive: {
      ...stashed,
      url: URL_,
      headers: { "anthropic-version": "2023-06-01" },
      pings,
    },
  };
}

function harness(storage: TestStorage, options: { fail?: boolean; bucket?: BlobStore } = {}) {
  // A year on: an alarm the scratch object might still hold is never due during the test.
  let clock = Date.now() + 365 * 86_400_000;
  const sent: Array<{ sid: string; model: string; body: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const ledger = createLedger({
    ...storage,
    budgetUsd: 100,
    userBudgetUsd: 100,
    monthlyBudgetUsd: null,
    userBudgetPeriod: "month",
    bucket: options.bucket,
    fetchKeyUsage: async () => 0,
    fetchGeneration: async () => null,
    sendPing: async (ping, body) => {
      sent.push({ sid: ping.sid, model: ping.model, body: JSON.parse(body) });
      return options.fail ? null : { usage: { cache_read_input_tokens: 100, cost: 0.01 } };
    },
    now: () => clock,
    log: (fields) => logs.push(fields),
  });
  return {
    ledger,
    sent,
    logs,
    now: () => clock,
    /** Moves the clock on and fires the alarm. */
    after: async (ms: number) => {
      clock += ms;
      storage.clearAlarm();
      await ledger.tick();
    },
  };
}

test("the ping is the same request for one token, streamed or not as the session's was", () => {
  const body = JSON.parse(
    pingBody({ model: MODEL, max_tokens: 64000, stream: true, messages: [] })
  );
  expect(body).toEqual({ model: MODEL, max_tokens: 1, stream: true, messages: [] });
});

test("an hour of pings while a tool runs, a few after the turn ended, none for a small cache", () => {
  expect(pingsAfter("tool_use", 120_000)).toBe(13);
  expect(pingsAfter("end_turn", 120_000)).toBe(3);
  expect(pingsAfter("tool_use", 5_000)).toBe(0);
  expect(pingsAfter("max_tokens", 120_000)).toBe(0);
  expect(pingsAfter(undefined, 120_000)).toBe(0);
  expect(pingsAfter("end_turn", 120_000, { idlePings: 0 })).toBe(0);
  expect(pingsAfter("tool_use", 120_000, { toolPings: 4 })).toBe(4);
});

test("a silent session is pinged on the alarm, at most maxPings times, and the ping is spend", () =>
  withLedgerStorage(async (storage, alarm) => {
    const { ledger, sent, logs, now, after } = harness(storage);
    await ledger.record(silent(2));
    expect(alarm(), "the alarm is set for the first ping").toBe(now() + KEEPALIVE_INTERVAL_MS);
    await after(KEEPALIVE_INTERVAL_MS - 1);
    expect(sent, "not before its time").toHaveLength(0);
    await after(1);
    expect(sent).toHaveLength(1);
    expect(alarm(), "and again for the next").toBe(now() + KEEPALIVE_INTERVAL_MS);
    await after(KEEPALIVE_INTERVAL_MS);
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect(sent[0].body.max_tokens).toBe(1);
    expect(logs.filter((line) => "keepalive" in line).map((line) => line.keepalive)).toEqual([
      1, 2,
    ]);
    expect(logs.find((line) => line.keepalive === 1)).toMatchObject({
      sid: "session-1",
      sub: "user-1",
      path: "/api/v1/messages",
      model: MODEL,
      status: 200,
      cost: 0.01,
      cache_read: 100,
    });
    expect(ledger.usage("user-1").requests, "the call and its two pings").toBe(3);
    expect(ledger.usage("user-1").spent_usd).toBeCloseTo(0.12);
  }));

test("the session's next call cancels the ping", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, sent, after } = harness(storage);
    await ledger.record(silent(2));
    await ledger.check("user-1", { sid: "session-1", model: MODEL });
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent).toHaveLength(0);
  }));

test("a side call on another model leaves the main model's ping alone", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, sent, after } = harness(storage);
    await ledger.record(silent(1));
    await ledger.check("user-1", { sid: "session-1", model: "anthropic/claude-haiku-4.5" });
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent.map((ping) => ping.model)).toEqual([MODEL]);
  }));

test("a newer waiting call replaces the older one", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, sent, after } = harness(storage);
    await ledger.record(silent(1, { body: ["old"] }));
    await ledger.record(silent(1, { body: ["new"] }));
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent.map((ping) => ping.body.messages)).toEqual([["new"]]);
  }));

test("no ping for a user who may not spend, and none after a failed one", () =>
  withLedgerStorage(async (storage) => {
    const blocked = harness(storage);
    await blocked.ledger.record(silent(2, { sid: "s-blocked", sub: "u-blocked" }));
    blocked.ledger.setUser("u-blocked", { blocked: true }, "admin-1");
    await blocked.after(KEEPALIVE_INTERVAL_MS);
    expect(blocked.sent).toHaveLength(0);

    const failing = harness(storage, { fail: true });
    await failing.ledger.record(silent(2, { sid: "s-failing" }));
    await failing.after(KEEPALIVE_INTERVAL_MS);
    await failing.after(KEEPALIVE_INTERVAL_MS);
    expect(failing.sent).toHaveLength(1);
    expect(failing.logs.find((line) => line.keepalive === 1)?.status).toBe(502);
  }));

test("the schedule outlives the object: a restarted ledger sends the ping that was due", () =>
  withLedgerStorage(async (storage) => {
    const first = harness(storage);
    await first.ledger.record(silent(1));
    const restarted = harness(storage);
    await restarted.after(KEEPALIVE_INTERVAL_MS);
    expect(restarted.sent).toHaveLength(1);
  }));

/** A ping body of a conversation about `bytes` long. */
const conversation = (bytes: number) =>
  pingBody({ model: MODEL, max_tokens: 64000, stream: true, messages: ["x".repeat(bytes)] });

test("a ping body that fits in a row stays in it; a larger one goes to R2", async () => {
  const small = conversation(KEEPALIVE_MAX_ROW_BODY_BYTES - 200);
  expect(await stashPing(small, bucket)).toEqual({ body: small });
  const large = conversation(KEEPALIVE_MAX_ROW_BODY_BYTES);
  const stashed = await stashPing(large, bucket);
  if (!("bodyKey" in stashed)) throw new Error(`not in R2: ${JSON.stringify(stashed)}`);
  expect(stashed.bodyKey).toMatch(/^keepalive\//);
  expect(await (await env.KEEPALIVE_BUCKET?.get(stashed.bodyKey))?.text()).toBe(large);
  await env.KEEPALIVE_BUCKET?.delete(stashed.bodyKey);
});

test("a host whose rows hold any size keeps every body in its row", async () => {
  const large = conversation(KEEPALIVE_MAX_ROW_BODY_BYTES);
  expect(await stashPing(large, undefined, KEEPALIVE_MAX_BODY_BYTES)).toEqual({ body: large });
  expect(
    await stashPing(conversation(KEEPALIVE_MAX_BODY_BYTES), undefined, KEEPALIVE_MAX_BODY_BYTES)
  ).toMatchObject({ skipped: "body over KEEPALIVE_MAX_BODY_BYTES" });
});

test("without a bucket, over the size limit, or when R2 fails, the reason is given", async () => {
  const large = conversation(KEEPALIVE_MAX_ROW_BODY_BYTES);
  expect(await stashPing(large, undefined)).toMatchObject({
    skipped: "body too large for a row and no bucket",
  });
  expect(await stashPing(conversation(KEEPALIVE_MAX_BODY_BYTES), bucket)).toMatchObject({
    skipped: "body over KEEPALIVE_MAX_BODY_BYTES",
  });
  const failing = {
    put: async () => {
      throw new Error("R2 unavailable");
    },
  } as unknown as BlobStore;
  expect(await stashPing(large, failing)).toMatchObject({
    skipped: "storing the body in the bucket failed: Error: R2 unavailable",
  });
});

test("a body in R2 is pinged from there, and leaves R2 with its session's last ping", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, sent, after } = harness(storage, { bucket });
    const stashed = await stashPing(conversation(KEEPALIVE_MAX_ROW_BODY_BYTES), bucket);
    if (!("bodyKey" in stashed)) throw new Error("not in R2");
    await ledger.record(silent(1, { stashed }));
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent).toHaveLength(1);
    expect((sent[0].body.messages as string[])[0]).toHaveLength(KEEPALIVE_MAX_ROW_BODY_BYTES);
    await vi.waitFor(async () =>
      expect(await env.KEEPALIVE_BUCKET?.head(stashed.bodyKey)).toBeNull()
    );
  }));

test("a session that talks again takes its body out of R2 too", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, sent, after } = harness(storage, { bucket });
    const stashed = await stashPing(conversation(KEEPALIVE_MAX_ROW_BODY_BYTES), bucket);
    if (!("bodyKey" in stashed)) throw new Error("not in R2");
    await ledger.record(silent(2, { stashed }));
    await ledger.check("user-1", { sid: "session-1", model: MODEL });
    await vi.waitFor(async () =>
      expect(await env.KEEPALIVE_BUCKET?.head(stashed.bodyKey)).toBeNull()
    );
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent).toHaveLength(0);
  }));

test("an alarm pass sends at most KEEPALIVE_PINGS_PER_PASS pings, the next pass the rest", () =>
  withLedgerStorage(async (storage, alarm) => {
    const { ledger, sent, now, after } = harness(storage);
    for (let i = 0; i < KEEPALIVE_PINGS_PER_PASS + 2; i++) {
      await ledger.record(silent(1, { sid: `session-${i}` }));
    }
    await after(KEEPALIVE_INTERVAL_MS);
    expect(sent).toHaveLength(KEEPALIVE_PINGS_PER_PASS);
    expect(alarm(), "the next pass is due at once").toBeLessThanOrEqual(now());
    await after(0);
    expect(sent).toHaveLength(KEEPALIVE_PINGS_PER_PASS + 2);
    expect(new Set(sent.map((ping) => ping.sid)).size).toBe(KEEPALIVE_PINGS_PER_PASS + 2);
  }));
