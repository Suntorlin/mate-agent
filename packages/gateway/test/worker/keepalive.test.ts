import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { KEEPALIVE_INTERVAL_MS, KEEPALIVE_MAX_ROW_BODY_BYTES } from "../../src/core/keepalive";
import {
  UPSTREAM,
  UPSTREAM_KEY,
  captureLogs,
  fakeFetch,
  keyUsage,
  ledgerStub,
  post,
  sse,
  token,
} from "../helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Through the Worker and the ledger object, against a fake OpenRouter: which calls arm a ping,
// what the ping is, and how often the alarm sends it (CACHE_KEEPALIVE_TOOL_PINGS=2 and
// CACHE_KEEPALIVE_IDLE_PINGS=0 in vitest.config.ts).
test("the gateway pings a silent session by how its last call ended and how much it cached", async () => {
  const seen = fakeFetch((request) => {
    if (request.url === `${UPSTREAM}/v1/key`) return keyUsage(0);
    const body = JSON.parse(request.body);
    const scenario = body.messages[0].content;
    const stopReason = scenario === "done" ? "end_turn" : "tool_use";
    const cached = scenario === "small" ? 100 : 50_000;
    const headers = { "content-type": "text/event-stream", "x-generation-id": "gen-ping" };
    if (body.max_tokens === 1) {
      return new Response(
        sse("message_start", {
          message: { usage: { input_tokens: 2, cache_read_input_tokens: cached } },
        }) +
          sse("message_delta", {
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 1, cost: 0.02 },
          }),
        { headers }
      );
    }
    return new Response(
      sse("message_start", {
        message: { usage: { input_tokens: 5, cache_read_input_tokens: cached } },
      }) +
        sse("message_delta", {
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 3, cost: 0.1 },
        }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  const logs = captureLogs();
  const send = async (sid: string, content: string) => {
    const { response, settled } = await post(
      "/llm/v1/messages",
      {
        model: "claude-opus-5-5",
        max_tokens: 64000,
        stream: true,
        messages: [{ role: "user", content }],
      },
      {
        authorization: `Bearer ${await token({ sub: "user-9", sid })}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "some-beta",
      }
    );
    await response.text();
    await settled();
  };
  await send("sess-done", "done");
  await send("sess-small", "small");
  await send("sess-tool", "tool");
  const stub = ledgerStub();
  const scheduled = await runInDurableObject(stub, (_object, state) => state.storage.getAlarm());
  expect(scheduled, "one ping is due, in KEEPALIVE_INTERVAL_MS").toBeGreaterThan(Date.now());
  expect(scheduled).toBeLessThanOrEqual(Date.now() + KEEPALIVE_INTERVAL_MS);
  const pings = () => seen.filter((request) => JSON.parse(request.body || "{}").max_tokens === 1);
  expect(pings()).toHaveLength(0);

  // The alarm's time comes, twice: two pings, then nothing is left to schedule.
  let clock = Date.now();
  for (const expected of [1, 2]) {
    clock += KEEPALIVE_INTERVAL_MS;
    vi.setSystemTime(clock);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pings()).toHaveLength(expected);
  }
  expect(await runDurableObjectAlarm(stub), "no alarm after the last ping").toBe(false);

  const [ping] = pings();
  const body = JSON.parse(ping.body);
  const toolCall = seen.find(
    (request) => request.body.includes('"tool"') && !request.body.includes('"max_tokens":1')
  );
  expect(body.stream).toBe(true);
  expect(body.model).toBe(JSON.parse(toolCall?.body ?? "{}").model);
  expect(body.messages).toEqual([{ role: "user", content: "tool" }]);
  expect(ping.headers.get("anthropic-beta")).toBe("some-beta");
  expect(ping.headers.get("x-api-key")).toBe(UPSTREAM_KEY);
  expect(ping.headers.get("authorization")).toBeNull();
  const logged = logs.find((entry) => entry.keepalive === 1);
  expect(logged?.sid).toBe("sess-tool");
  expect(logged?.cost).toBe(0.02);
  expect(logged?.cache_read).toBe(50_000);
  // The pings are spend like any other call.
  const usage = await stub.usage("user-9");
  expect(Math.round(usage.spent_usd * 100)).toBe(34);
});

test("a long conversation's ping body goes to R2 from the Worker, and the alarm pings from there", async () => {
  const seen = fakeFetch((request) => {
    if (request.url === `${UPSTREAM}/v1/key`) return keyUsage(0);
    const ping = JSON.parse(request.body).max_tokens === 1;
    return new Response(
      sse("message_start", {
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 90_000 } },
      }) +
        sse("message_delta", {
          delta: { stop_reason: ping ? "max_tokens" : "tool_use" },
          usage: { output_tokens: 1, cost: ping ? 0.01 : 0.2 },
        }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  captureLogs();
  const content = "y".repeat(KEEPALIVE_MAX_ROW_BODY_BYTES);
  const { response, settled } = await post(
    "/llm/v1/messages",
    { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content }] },
    { "x-api-key": await token({ sub: "user-long", sid: "sess-long" }) }
  );
  await response.text();
  await settled();
  const stub = ledgerStub();
  const row = await runInDurableObject(stub, (_object, state) =>
    state.storage.sql
      .exec<{
        body: string | null;
        body_key: string | null;
      }>("SELECT body, body_key FROM keepalive WHERE sid = 'sess-long'")
      .toArray()
  );
  expect(row).toHaveLength(1);
  expect(row[0].body, "not in the object's SQLite").toBeNull();
  const bodyKey = row[0].body_key ?? "";
  expect(await env.KEEPALIVE_BUCKET?.head(bodyKey)).not.toBeNull();

  let clock = Date.now();
  for (let ping = 1; ping <= 2; ping++) {
    clock += KEEPALIVE_INTERVAL_MS;
    vi.setSystemTime(clock);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  }
  const pings = seen.filter((request) => request.body.includes('"max_tokens":1'));
  expect(pings).toHaveLength(2);
  expect(JSON.parse(pings[0].body).messages[0].content).toBe(content);
  await vi.waitFor(async () => expect(await env.KEEPALIVE_BUCKET?.head(bodyKey)).toBeNull());
});
