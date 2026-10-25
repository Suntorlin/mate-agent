// Usage reports: each settled call of a product's user is POSTed to the product by the ledger's
// alarm, again after a failure; calls of sessions no product user owns are never sent.
import { expect, test, vi } from "vitest";
import { BACKFILL_MIN_AGE_MS } from "../../src/core/backfill";
import { type RequestUsage } from "../../src/core/budget";
import { createLedger } from "../../src/core/ledger";
import { USAGE_REPORT_MAX_ATTEMPTS, usageReportDelayMs } from "../../src/core/usage-reports";
import { type TestStorage, withLedgerStorage } from "../helpers";

const REPORT_URL = "https://product.test/internal/llm-usage";

function setup(
  storage: TestStorage,
  fetchGeneration: (id: string) => Promise<RequestUsage | null> = async () => null
) {
  let clock = Date.parse("2026-10-18T08:00:00.000Z");
  const posts: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  let answer: () => Response = () => Response.json({ recorded: true });
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return answer();
  });
  const ledger = createLedger({
    ...storage,
    budgetUsd: 100,
    userBudgetUsd: 100,
    monthlyBudgetUsd: null,
    userBudgetPeriod: "month",
    fetchKeyUsage: async () => 0,
    fetchGeneration,
    sendPing: async () => null,
    usageReport: { url: REPORT_URL, token: "product-bearer", fetch: fetchFn as typeof fetch },
    now: () => clock,
    log: () => {},
  });
  return {
    ledger,
    posts,
    answer: (next: () => Response) => {
      answer = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    reports: async () => (await ledger.overview()).usage_reports,
    /** The alarm fires: the host clears it, then runs the ledger's work. */
    fire: async () => {
      storage.clearAlarm();
      await ledger.tick();
    },
  };
}

test("a product user's settled calls are reported once, under the product's user id", () =>
  withLedgerStorage(async (storage, alarm) => {
    const { ledger, fire, posts, now, reports } = setup(storage);
    await ledger.record({
      sid: "s1",
      sub: "engine-user-1",
      app: "acme-uid-1",
      model: "anthropic/claude-sonnet-4.6",
      usage: { cost: 0.01, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      generationId: "gen-1",
    });
    // A session no product user owns: counted in the ledger, never reported.
    await ledger.record({ sid: "s2", sub: "engine-user-2", model: "m", usage: { cost: 0.5 } });
    expect(alarm(), "a waiting report wakes the ledger at once").toBe(now());

    await fire();
    expect(posts).toEqual([
      {
        url: REPORT_URL,
        auth: "Bearer product-bearer",
        body: {
          request_id: "gen-1",
          user_id: "acme-uid-1",
          session_id: "s1",
          model: "anthropic/claude-sonnet-4.6",
          usd_cost: 0.01,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          occurred_at: "2026-10-18T08:00:00.000Z",
        },
      },
    ]);
    await fire();
    expect(posts).toHaveLength(1);
    expect(await reports()).toEqual({ waiting: 0, dead: 0 });
  }));

test("a later call of the session is reported though its own token named no product user", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, fire, posts } = setup(storage);
    await ledger.record({
      sid: "s1",
      sub: "u1",
      app: "acme-uid-1",
      model: "m",
      usage: { cost: 0.01 },
    });
    // The memory jobs' calls carry the session but not the product user.
    await ledger.record({ sid: "s1", sub: "u1", model: "m", usage: { cost: 0.002 } });
    await fire();
    expect(posts.map((p) => p.body.user_id)).toEqual(["acme-uid-1", "acme-uid-1"]);
  }));

test("a cut-off call is reported once the backfill gives it its cost", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, fire, posts, advance } = setup(storage, async () => ({
      cost: 0.2,
      output_tokens: 9,
    }));
    await ledger.record({
      sid: "s1",
      sub: "u1",
      app: "acme-uid-1",
      model: "m",
      usage: { input_tokens: 3 },
      generationId: "gen-cut",
    });
    await fire();
    expect(posts, "no cost yet, nothing to report").toHaveLength(0);

    advance(BACKFILL_MIN_AGE_MS + 1);
    await fire();
    // The backfill settles it on this tick; the report goes out on the next one.
    await fire();
    expect(posts.map((p) => p.body)).toMatchObject([
      { request_id: "gen-cut", usd_cost: 0.2, input_tokens: 3, output_tokens: 9 },
    ]);
  }));

test("a failed report is sent again after its delay; a refused one is dead at once", () =>
  withLedgerStorage(async (storage, alarm) => {
    const { ledger, fire, posts, answer, advance, now, reports } = setup(storage);
    answer(() => new Response("busy", { status: 503 }));
    await ledger.record({
      sid: "s1",
      sub: "u1",
      app: "acme-uid-1",
      model: "m",
      usage: { cost: 0.01 },
      generationId: "gen-1",
    });
    await fire();
    expect(posts).toHaveLength(1);
    expect(alarm()).toBe(now() + usageReportDelayMs(1));
    await fire();
    expect(posts, "not due yet").toHaveLength(1);

    advance(usageReportDelayMs(1));
    answer(() => Response.json({ recorded: false }));
    await fire();
    expect(posts).toHaveLength(2);
    expect(await reports()).toEqual({ waiting: 0, dead: 0 });

    answer(() => new Response("unknown user", { status: 404 }));
    await ledger.record({
      sid: "s1",
      sub: "u1",
      model: "m",
      usage: { cost: 0.03 },
      generationId: "gen-2",
    });
    await fire();
    advance(usageReportDelayMs(USAGE_REPORT_MAX_ATTEMPTS));
    await fire();
    expect(posts, "a refused report is not sent again").toHaveLength(3);
    expect(await reports()).toEqual({ waiting: 0, dead: 1 });
  }));

test("a report that keeps failing is dead after the last attempt", () =>
  withLedgerStorage(async (storage) => {
    const { ledger, fire, posts, answer, advance, reports } = setup(storage);
    answer(() => {
      throw new TypeError("fetch failed");
    });
    await ledger.record({
      sid: "s1",
      sub: "u1",
      app: "acme-uid-1",
      model: "m",
      usage: { cost: 0.01 },
      generationId: "gen-1",
    });
    for (let attempt = 1; attempt <= USAGE_REPORT_MAX_ATTEMPTS + 2; attempt += 1) {
      await fire();
      advance(usageReportDelayMs(attempt));
    }
    expect(posts).toHaveLength(USAGE_REPORT_MAX_ATTEMPTS);
    expect(await reports()).toEqual({ waiting: 0, dead: 1 });
  }));
