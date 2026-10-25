// End-to-end tests of the gateway's HTTP surface: the Worker, the ledger Durable Object and a
// fake OpenRouter behind the global fetch. The tests share the one ledger and run in order.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { USAGE_CACHE_MS } from "../../src/core/budget";
import type { Env } from "../../src/worker/env";
import type { FinishedCall } from "../../src/core/ledger";
import {
  type SeenRequest,
  UPSTREAM,
  UPSTREAM_KEY,
  callWorker,
  captureLogs,
  fakeFetch,
  freshClaims,
  heldStream,
  keyUsage,
  ledgerStub,
  post as postTo,
  signJwt,
  sse,
  token,
} from "../helpers";

let seen: SeenRequest[] = [];
let logs: Array<Record<string, unknown>> = [];
let releaseStream: () => void = () => {};
let cutStream: ReturnType<typeof heldStream> | null = null;
let currentKeyUsage = 10;
let generation: Record<string, unknown> | null = null;
let generationHeader: string | null = null;

// What the upstream streams: the head at once, the tail once the test releases it.
const STREAM_HEAD = [
  sse("message_start", { message: { usage: { input_tokens: 11, output_tokens: 1 } } }),
  sse("ping", {}),
];
const STREAM_TAIL = [
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", {
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 11, output_tokens: 3, cost: 0.0042 },
  }),
  sse("message_stop", {}),
];

function fakeOpenRouter(request: SeenRequest): Response {
  if (request.url === `${UPSTREAM}/v1/key`) return keyUsage(currentKeyUsage);
  if (request.url.startsWith(`${UPSTREAM}/v1/generation`)) {
    return generation ? Response.json({ data: generation }) : new Response("", { status: 404 });
  }
  const scenario = JSON.parse(request.body).messages?.[0]?.content;
  if (scenario === "upstream-error") {
    return new Response(
      '{"type":"error","error":{"type":"rate_limit_error","message":"upstream says slow down"}}',
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "7",
          "x-should-retry": "true",
        },
      }
    );
  }
  if (scenario === "unreachable") throw new TypeError("connect ECONNREFUSED");
  if (scenario === "cut") {
    // Starts a stream and never finishes it: the client goes away first.
    cutStream = heldStream();
    cutStream.write(
      sse("message_start", {
        message: { usage: { input_tokens: 3, cache_read_input_tokens: 900, output_tokens: 1 } },
      })
    );
    return new Response(cutStream.stream, {
      headers: { "content-type": "text/event-stream", "x-generation-id": "gen-cut-1" },
    });
  }
  if (scenario === "stream") {
    const held = heldStream();
    STREAM_HEAD.forEach(held.write);
    // The rest is held back until the client proves it already received the first events.
    releaseStream = () => {
      STREAM_TAIL.forEach(held.write);
      held.end();
    };
    return new Response(held.stream, {
      headers: { "content-type": "text/event-stream", "set-cookie": "cf=1" },
    });
  }
  return new Response(
    JSON.stringify({ id: "msg_1", usage: { input_tokens: 5, output_tokens: 2, cost: 0.001 } }),
    {
      headers: {
        "content-type": "application/json",
        "request-id": "req_1",
        ...(generationHeader ? { "x-generation-id": generationHeader } : {}),
      },
    }
  );
}

beforeEach(() => {
  seen = fakeFetch(fakeOpenRouter);
  logs = captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sandbox = () => token({ sub: "user-7", sid: "sess-7" });

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const { response, settled } = await postTo(path, body, {
    "x-api-key": await sandbox(),
    ...headers,
  });
  return { response, settled };
}

/** Sends, reads the whole answer, and waits for what the gateway does after it. */
async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const { response, settled } = await post(path, body, headers);
  const text = await response.text();
  await settled();
  return { response, text };
}

const upstreamCalls = () => seen.filter((request) => request.url.includes("/v1/messages"));

test("forwards anthropic headers and the body unchanged except model, and swaps credentials", async () => {
  const body = {
    model: "claude-opus-4-8",
    max_tokens: 10,
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1" },
      { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } },
    ],
    thinking: { type: "adaptive" },
    context_management: { edits: [] },
    messages: [{ role: "user", content: "json" }],
  };
  const sandboxToken = await sandbox();
  const { response } = await call("/llm/v1/messages?beta=true", body, {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,context-management-2025-06-27",
    "anthropic-future-header": "kept",
    authorization: `Bearer ${sandboxToken}`,
    "x-claude-code-session-id": "cc-1",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("request-id")).toBe("req_1");
  const forwarded = upstreamCalls().at(-1)!;
  expect(forwarded.url).toBe(`${UPSTREAM}/v1/messages?beta=true`);
  expect(forwarded.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(forwarded.headers.get("anthropic-beta")).toBe(
    "claude-code-20250219,context-management-2025-06-27"
  );
  expect(forwarded.headers.get("anthropic-future-header")).toBe("kept");
  expect(forwarded.headers.get("x-api-key")).toBe(UPSTREAM_KEY);
  expect(forwarded.headers.get("authorization")).toBeNull();
  expect(forwarded.headers.get("x-claude-code-session-id")).toBeNull();
  expect(
    JSON.stringify([...forwarded.headers]).includes(sandboxToken),
    "the sandbox JWT never goes upstream"
  ).toBe(false);
  expect(JSON.parse(forwarded.body)).toEqual({ ...body, model: "anthropic/claude-opus-4.8" });
});

test("streams SSE through chunk by chunk without waiting for the upstream to finish", async () => {
  const { response, settled } = await post("/llm/v1/messages", {
    model: "claude-sonnet-5-5",
    stream: true,
    messages: [{ role: "user", content: "stream" }],
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("set-cookie")).toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("event: ping")) {
    const { value } = await reader.read();
    received += decoder.decode(value, { stream: true });
  }
  expect(
    received.includes("message_stop"),
    "first events arrived while upstream was still open"
  ).toBe(false);
  releaseStream();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += decoder.decode(chunk.value, { stream: true });
  }
  expect(received, "the bytes as the upstream sent them").toBe(
    [...STREAM_HEAD, ...STREAM_TAIL].join("")
  );
  expect(JSON.parse(upstreamCalls().at(-1)!.body).model).toBe("anthropic/claude-sonnet-5.5");
  await settled();
  const line = logs.findLast((entry) => entry.sid === "sess-7" && entry.stream === true)!;
  expect(line.sub).toBe("user-7");
  expect(line.model).toBe("anthropic/claude-sonnet-5.5");
  expect(line.status).toBe(200);
  expect(line.cost).toBe(0.0042);
  expect(line.bytes).toBe(new TextEncoder().encode(received).byteLength);
  expect(line.shape).toMatchObject({ msgs: [1, 6, 0] });
  expect(line.aborted).toBeUndefined();
  // The usage read from the stream, cost included, is what the ledger counts.
  const session = (await ledgerStub().snapshot()).ledger.by_session["sess-7"];
  expect(session.usd).toBeCloseTo(0.001 + 0.0042);
  expect(session.output_tokens).toBe(2 + 3);
});

test("a stream cut off before its cost is aborted upstream, recorded as pending, then settled by the alarm", async () => {
  const cutToken = await token({ sub: "user-cut", sid: "sess-cut" });
  const { response, settled } = await postTo(
    "/llm/v1/messages",
    { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "cut" }] },
    { "x-api-key": cutToken }
  );
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toMatch(/message_start/);
  await reader.cancel("the client went away");
  await settled();
  // Claude Code went away: the upstream generation is stopped.
  expect(await cutStream?.cancelled).toBeDefined();
  expect(upstreamCalls().at(-1)?.signal?.aborted).toBe(true);
  const line = logs.find((entry) => entry.sid === "sess-cut")!;
  expect(line.aborted).toBe(true);
  expect(line.pending).toBe(true);
  expect(line.generation).toBe("gen-cut-1");
  const stub = ledgerStub();
  let snap = await stub.snapshot();
  expect(snap.ledger.by_user["user-cut"], "not counted at $0").toBeUndefined();
  expect(snap.pending_requests).toBeGreaterThanOrEqual(1);

  // OpenRouter knows the call now; the backfill alarm reads its cost.
  generation = { total_cost: 0.05, native_tokens_prompt: 3, native_tokens_completion: 40 };
  vi.setSystemTime(Date.now() + 10_000);
  await runDurableObjectAlarm(stub);
  generation = null;
  snap = await stub.snapshot();
  expect(snap.ledger.by_user["user-cut"].usd).toBe(0.05);
  expect(snap.ledger.by_user["user-cut"].output_tokens).toBe(40);
  expect(snap.ledger.by_user["user-cut"].cache_read_input_tokens).toBe(900);
  expect(snap.ledger.by_session["sess-cut"].requests).toBe(1);
  expect(snap.pending_requests).toBe(0);
});

test("passes upstream errors through with status, body and retry headers", async () => {
  const { response, text } = await call("/llm/v1/messages", {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "upstream-error" }],
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("7");
  expect(response.headers.get("x-should-retry")).toBe("true");
  expect(text).toBe(
    '{"type":"error","error":{"type":"rate_limit_error","message":"upstream says slow down"}}'
  );
});

test("an upstream it cannot reach answers 502 with x-should-retry true", async () => {
  const { response, text } = await call("/llm/v1/messages", {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "unreachable" }],
  });
  expect(response.status).toBe(502);
  expect(response.headers.get("x-should-retry")).toBe("true");
  expect(JSON.parse(text).error).toEqual({
    type: "api_error",
    message: "Upstream request failed: connect ECONNREFUSED",
  });
  expect(logs.findLast((entry) => entry.sid === "sess-7")).toMatchObject({
    status: 502,
    aborted: true,
  });
});

test("forwards count_tokens to the upstream path, without the ledger", async () => {
  const before = (await ledgerStub().usage("user-7")).requests;
  const { response } = await call("/llm/v1/messages/count_tokens", {
    model: "claude-haiku-4-5",
    messages: [],
  });
  expect(response.status).toBe(200);
  expect(upstreamCalls().at(-1)!.url).toBe(`${UPSTREAM}/v1/messages/count_tokens`);
  expect(JSON.parse(upstreamCalls().at(-1)!.body).model).toBe("anthropic/claude-haiku-4.5");
  expect((await ledgerStub().usage("user-7")).requests).toBe(before);
});

test("rejects missing, expired and forged tokens with an Anthropic 401", async () => {
  const expired = await signJwt(freshClaims({ exp: Math.floor(Date.now() / 1000) - 5 }));
  const forged = await signJwt(freshClaims(), "wrong-secret");
  const reasons: string[] = [];
  for (const key of ["", expired, forged]) {
    const { response, text } = await call(
      "/llm/v1/messages",
      { messages: [] },
      { "x-api-key": key }
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-should-retry")).toBe("false");
    const body = JSON.parse(text);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
    reasons.push(body.error.message);
  }
  expect(reasons).toEqual([
    "Invalid gateway token: missing gateway token",
    "Invalid gateway token: token expired",
    "Invalid gateway token: invalid token signature",
  ]);
  expect(upstreamCalls(), "nothing reached the upstream").toHaveLength(0);
  expect(logs.at(-1)).toMatchObject({ path: "/llm/v1/messages", status: 401 });
});

test("answers the warm-up probe and health check, 404s unknown routes and 405s wrong methods", async () => {
  expect((await callWorker("/llm/api/hello", { method: "HEAD" })).response.status).toBe(200);
  const health = (await callWorker("/healthz")).response;
  expect(health.status).toBe(200);
  expect(await health.json<any>()).toEqual({ ok: true });
  const models = (await callWorker("/llm/v1/models", { headers: { "x-api-key": await sandbox() } }))
    .response;
  expect(models.status).toBe(404);
  expect(await models.json<any>()).toEqual({
    type: "error",
    error: { type: "not_found_error", message: "No route for GET /llm/v1/models" },
  });
  // There is no memory store.
  expect(
    (await callWorker("/memory", { headers: { "x-api-key": await sandbox() } })).response.status
  ).toBe(404);
  const get = (await callWorker("/llm/v1/messages")).response;
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
  expect((await get.json<any>()).error.message).toBe("GET not allowed on /llm/v1/messages");
});

test("a percent-encoded path is no route: no way around the budget", async () => {
  for (const path of ["/llm/v1/%6Dessages", "/llm/v1/messages%2Fcount_tokens", "/llm/%75sage"]) {
    const { response } = await postTo(path, { messages: [] }, { "x-api-key": await sandbox() });
    expect(response.status, path).toBe(404);
    expect((await response.json<any>()).error).toEqual({
      type: "not_found_error",
      message: `No route for POST ${path}`,
    });
  }
  expect(upstreamCalls()).toHaveLength(0);
});

test("a misconfigured gateway answers 500 and says why in the log", async () => {
  const broken = { LLM_USER_BUDGET_PERIOD: "week" } as Partial<Env>;
  const health = (await callWorker("/healthz", {}, broken)).response;
  expect(health.status).toBe(500);
  expect((await health.json<any>()).error.type).toBe("api_error");
  expect(logs.at(-1)?.error).toBe("Error: LLM_USER_BUDGET_PERIOD must be one of month, day");
});

test("a body over MAX_PARSED_BODY_BYTES is refused with 413 before anything else", async () => {
  const small = { MAX_PARSED_BODY_BYTES: "1024" } as Partial<Env>;
  const big = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "x".repeat(2048) }],
  };
  const { response } = await postTo(
    "/llm/v1/messages",
    big,
    { "x-api-key": await sandbox() },
    small
  );
  expect(response.status).toBe(413);
  expect(await response.json<any>()).toEqual({
    type: "error",
    error: { type: "request_too_large", message: "request body exceeds 1024 bytes" },
  });
  // Also when the length is not declared up front.
  const chunks = new TextEncoder().encode(JSON.stringify(big));
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunks.slice(0, 1000));
      controller.enqueue(chunks.slice(1000));
      controller.close();
    },
  });
  const chunked = await callWorker(
    "/llm/v1/messages",
    {
      method: "POST",
      headers: { "x-api-key": await sandbox() },
      body: streamed,
      duplex: "half",
    } as RequestInit,
    small
  );
  expect(chunked.response.status).toBe(413);
  expect(upstreamCalls()).toHaveLength(0);
  const invalid = await call("/llm/v1/messages", "[1, 2]");
  expect(invalid.response.status).toBe(400);
  expect(JSON.parse(invalid.text).error.message).toBe("Request body must be a JSON object");
});

test("refuses new requests with 429 and x-should-retry false once the key's budget is spent", async () => {
  currentKeyUsage = 10 + 25; // the baseline was 10
  vi.setSystemTime(Date.now() + USAGE_CACHE_MS);
  const admin = `Bearer ${await token({ sub: "admin-1", scope: "admin" })}`;
  // The admin view reads the key again.
  await callWorker("/admin/usage", { headers: { authorization: admin } });
  const { response, text } = await call("/llm/v1/messages", {
    model: "claude-sonnet-5-5",
    messages: [],
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
  const body = JSON.parse(text);
  expect(body.error.type).toBe("rate_limit_error");
  expect(body.error.message).toMatch(/service-wide limit/);
  // The key's safety net has no reset date of its own.
  expect(body.error.message).toMatch(/ \[llm_budget=global\]$/);
  expect(response.headers.get("x-llm-budget")).toBe("global");
  expect(response.headers.get("x-llm-budget-resets-at")).toBeNull();
  expect(upstreamCalls()).toHaveLength(0);
  expect(logs.findLast((entry) => entry.sid === "sess-7")).toMatchObject({
    status: 429,
    budget: "global",
  });
  const usage = await (
    await callWorker("/admin/usage", { headers: { authorization: admin } })
  ).response.json<any>();
  expect(usage.baseline_usd).toBe(10);
  expect(usage.spent_usd).toBe(25);
  expect(usage.remaining_usd).toBe(0);
  expect(usage.ledger.by_session["sess-7"].requests).toBe(2);
  currentKeyUsage = 10;
  await callWorker("/admin/usage", { headers: { authorization: admin } });
});

test("a user over their own budget gets 429 while another user's request goes through", async () => {
  await ledgerStub().record({
    sid: "sess-heavy",
    sub: "user-heavy",
    model: "m",
    usage: { cost: 5 },
  });
  const heavy = await token({ sub: "user-heavy", sid: "sess-heavy" });
  const light = await token({ sub: "user-light", sid: "sess-light" });

  const refused = await call("/llm/v1/messages", { messages: [] }, { "x-api-key": heavy });
  expect(refused.response.status).toBe(429);
  expect(refused.response.headers.get("x-should-retry")).toBe("false");
  const body = JSON.parse(refused.text);
  expect(body.error.type).toBe("rate_limit_error");
  expect(body.error.message).toMatch(
    /^You've used this month's AI budget \(\$5\.00 of \$5\.00\)\./
  );
  // The tag is the part of the refusal Claude Code passes on to the agent runtime.
  const resetsAt = (await ledgerStub().usage("user-heavy")).resets_at;
  expect(body.error.message.endsWith(` [llm_budget=user resets_at=${resetsAt}]`)).toBe(true);
  expect(refused.response.headers.get("x-llm-budget")).toBe("user");
  expect(refused.response.headers.get("x-llm-budget-resets-at")).toBe(resetsAt);
  expect(upstreamCalls(), "nothing reached the upstream").toHaveLength(0);

  const allowed = await call(
    "/llm/v1/messages",
    { messages: [{ role: "user", content: "json" }] },
    { "x-api-key": light }
  );
  expect(allowed.response.status).toBe(200);
  expect(upstreamCalls()).toHaveLength(1);
});

test("an unreachable ledger fails closed with 503 and x-should-retry true", async () => {
  const unreachable = {
    LEDGER: {
      idFromName: () => env.LEDGER.idFromName("global"),
      get: () => ({
        check: async () => {
          throw new Error("Durable Object reset because its code was updated.");
        },
      }),
    },
  } as unknown as Partial<Env>;
  const { response } = await postTo(
    "/llm/v1/messages",
    { messages: [] },
    { "x-api-key": await sandbox() },
    unreachable
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("x-should-retry")).toBe("true");
  expect((await response.json<any>()).error).toEqual({
    type: "api_error",
    message: "AI usage could not be checked right now. Please try again in a moment.",
  });
  expect(upstreamCalls()).toHaveLength(0);
});

test("a record lost to an object reset is sent again and counted once", async () => {
  const stub = ledgerStub();
  let failures = 1;
  const resetting = {
    LEDGER: {
      idFromName: (name: string) => env.LEDGER.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.LEDGER.get(id);
        return {
          check: (sub: string, session?: { sid: string; model: string }) =>
            real.check(sub, session),
          record: async (call: FinishedCall) => {
            // The first send lands, but its answer is lost to the reset.
            await real.record(call);
            if (failures-- > 0) {
              throw Object.assign(new Error("Durable Object reset because its code was updated."), {
                retryable: true,
              });
            }
          },
        };
      },
    },
  } as unknown as Partial<Env>;
  generationHeader = "gen-reset-1";
  const { response, settled } = await postTo(
    "/llm/v1/messages",
    { messages: [{ role: "user", content: "json" }] },
    { "x-api-key": await token({ sub: "user-reset", sid: "sess-reset" }) },
    resetting
  );
  await response.text();
  await settled();
  generationHeader = null;
  expect(failures).toBe(-1);
  const usage = await stub.usage("user-reset");
  expect(usage.requests, "counted once").toBe(1);
  expect(usage.spent_usd).toBe(0.001);
  expect(logs.some((entry) => String(entry.error ?? "").includes("ledger record failed"))).toBe(
    false
  );
});

test("a record the ledger refuses for good is logged with what it takes to settle it by hand", async () => {
  const refusing = {
    LEDGER: {
      idFromName: (name: string) => env.LEDGER.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.LEDGER.get(id);
        return {
          check: (sub: string, session?: { sid: string; model: string }) =>
            real.check(sub, session),
          record: async () => {
            throw new Error("Durable Object storage limit exceeded");
          },
        };
      },
    },
  } as unknown as Partial<Env>;
  const { response, settled } = await postTo(
    "/llm/v1/messages",
    { messages: [{ role: "user", content: "json" }] },
    { "x-api-key": await token({ sub: "user-refused", sid: "sess-refused" }) },
    refusing
  );
  await response.text();
  await settled();
  expect(logs.find((entry) => entry.sid === "sess-refused" && entry.status === 500)).toMatchObject({
    error: "ledger record failed: Error: Durable Object storage limit exceeded",
    lost: {
      model: "anthropic/claude-sonnet-5.5",
      usage: { input_tokens: 5, output_tokens: 2, cost: 0.001 },
    },
  });
  expect((await ledgerStub().usage("user-refused")).requests).toBe(0);
});

test("usage: a token reads its own user's spend and nobody else's", async () => {
  await ledgerStub().record({
    sid: "sess-u",
    sub: "user-usage",
    model: "m",
    usage: { cost: 1.25 },
  });
  const usage = async (claims: Record<string, unknown>, query = "") =>
    (
      await callWorker(`/llm/usage${query}`, {
        headers: { authorization: `Bearer ${await signJwt(freshClaims(claims))}` },
      })
    ).response;

  const own = await usage({ sub: "user-usage", sid: "usage", scope: "usage" });
  expect(own.status).toBe(200);
  expect(own.headers.get("cache-control")).toBe("private, no-store");
  const body = await own.json<any>();
  expect(body.spent_usd).toBe(1.25);
  expect(body.budget_usd).toBe(5);
  expect(body.remaining_usd).toBe(3.75);
  expect(body.period).toBe("month");
  expect(Date.parse(body.resets_at)).toBeGreaterThan(Date.now());

  // Another user's token only ever sees that user's row; there is no way to name a user.
  const other = await (
    await usage({ sub: "someone-else", sid: "usage", scope: "usage" })
  ).json<any>();
  expect(other.spent_usd).toBe(0);
  const named = await usage({ sub: "someone-else", scope: "usage" }, "?sub=user-usage");
  expect((await named.json<any>()).spent_usd).toBe(0);

  // A sandbox token (no scope) may read its own user's usage too.
  expect((await (await usage({ sub: "user-usage" })).json<any>()).spent_usd).toBe(1.25);

  expect((await callWorker("/llm/usage")).response.status).toBe(401);
  const forged = await callWorker("/llm/usage", {
    headers: { authorization: `Bearer ${await signJwt(freshClaims(), "wrong-secret")}` },
  });
  expect(forged.response.status).toBe(401);
  const posted = await callWorker("/llm/usage", { method: "POST" });
  expect(posted.response.status).toBe(405);
  expect(posted.response.headers.get("allow")).toBe("GET");
});

test("usage- and admin-scoped tokens cannot call the model", async () => {
  const scoped = await token({ sub: "user-usage", scope: "usage" });
  const llm = await call("/llm/v1/messages", { messages: [] }, { "x-api-key": scoped });
  expect(llm.response.status).toBe(403);
  expect(JSON.parse(llm.text).error.type).toBe("permission_error");
  const admin = await token({ scope: "admin" });
  expect(
    (await call("/llm/v1/messages", { messages: [] }, { "x-api-key": admin })).response.status
  ).toBe(403);
  const usage = await callWorker("/llm/usage", { headers: { authorization: `Bearer ${admin}` } });
  expect(usage.response.status).toBe(403);
  expect(upstreamCalls()).toHaveLength(0);
});

test("serves a model the map names from OpenRouter on the same Messages endpoint", async () => {
  const body = {
    model: "gpt-5.6-luna",
    max_tokens: 10,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: "json" }],
  };
  const mapped = {
    LLM_MODEL_MAP: '{"gpt-5.6-luna":"openai/gpt-5.6-luna","default":"anthropic/claude-sonnet-5.5"}',
  } as Partial<Env>;
  // Its own session, so the ledger counts the earlier tests rely on stay as they were.
  const luna = await token({ sub: "user-luna", sid: "sess-luna" });
  const { response, settled } = await postTo(
    "/llm/v1/messages?beta=true",
    body,
    { "x-api-key": luna },
    mapped
  );
  await response.text();
  await settled();
  expect(response.status).toBe(200);
  expect(logs.findLast((entry) => entry.sid === "sess-luna")?.shape).toMatchObject({
    effort: "medium",
  });
  const forwarded = upstreamCalls().at(-1)!;
  expect(forwarded.url).toBe(`${UPSTREAM}/v1/messages?beta=true`);
  expect(JSON.parse(forwarded.body)).toEqual({ ...body, model: "openai/gpt-5.6-luna" });
});
