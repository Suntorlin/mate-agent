// The Node host end to end: a real HTTP server in front of the core app, a ledger in a SQLite
// file, the alarm on a timer, and a fake OpenRouter on a local port. What the core does on its
// own is tested in workerd (test/core, test/worker); here it is what the host adds.
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { BACKFILL_MIN_AGE_MS } from "../../src/core/backfill";
import { parseConfig } from "../../src/core/config";
import { type NodeGateway, createNodeGateway } from "../../src/node/gateway";

const SECRET = "test-secret-0123456789abcdef";

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "user-1", sid: "session-1", iat: now, exp: now + 600, ...claims })}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}

const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
  aborted: boolean;
}

let upstream: Server;
let upstreamBase = "";
const seen: Seen[] = [];
/** Answers each upstream request by its first message's content. */
function answer(entry: Seen, res: ServerResponse): void {
  if (entry.url === "/api/v1/key") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { usage: 10 } }));
    return;
  }
  if (entry.url.startsWith("/api/v1/generation")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { total_cost: 0.05, native_tokens_completion: 40 } }));
    return;
  }
  const scenario = JSON.parse(entry.body).messages?.[0]?.content;
  if (scenario === "cut") {
    // Starts a stream and never finishes it: the client goes away first.
    res.writeHead(200, { "content-type": "text/event-stream", "x-generation-id": "gen-cut" });
    res.write(sse("message_start", { message: { usage: { input_tokens: 3 } } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "cf=1" });
  res.write(sse("message_start", { message: { usage: { input_tokens: 11 } } }));
  res.end(
    sse("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3, cost: 0.25 },
    })
  );
}

let dir = "";
let gateway: NodeGateway;
let server: ReturnType<typeof serve>;
let base = "";

function startGateway(): Promise<void> {
  const config = parseConfig({
    GATEWAY_SECRET: SECRET,
    OPENROUTER_API_KEY: "sk-or-test-upstream-key",
    OPENROUTER_BASE_URL: upstreamBase,
    LLM_USER_BUDGET_USD: "1",
  });
  gateway = createNodeGateway({ config, databasePath: join(dir, "gateway.sqlite") });
  return new Promise((resolve) => {
    server = serve({ fetch: gateway.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
}

async function stopGateway(): Promise<void> {
  await new Promise((resolve) => server.close(resolve));
  await gateway.idle();
  gateway.close();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gateway-node-"));
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const entry: Seen = { url: req.url ?? "", headers: req.headers, body, aborted: false };
      res.on("close", () => (entry.aborted = !res.writableFinished));
      seen.push(entry);
      answer(entry, res);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api`;
  await startGateway();
});

afterAll(async () => {
  await stopGateway();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const messages = (content: string, sub = "user-1", sid = "session-1") =>
  fetch(`${base}/llm/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": token({ sub, sid }),
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ content }] }),
  });

const usage = async (sub: string) =>
  (
    await fetch(`${base}/llm/usage`, {
      headers: { authorization: `Bearer ${token({ sub, scope: "usage" })}` },
    })
  ).json() as Promise<{ spent_usd: number; requests: number }>;

test("streams a call through, swaps the credential, and the ledger counts its cost", async () => {
  const response = await messages("hello");
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  const text = await response.text();
  expect(text).toContain("message_delta");
  await gateway.idle();
  const call = seen.findLast((entry) => entry.url === "/api/v1/messages")!;
  expect(call.headers["x-api-key"]).toBe("sk-or-test-upstream-key");
  expect(call.headers["anthropic-version"]).toBe("2023-06-01");
  expect(JSON.parse(call.body).model).toBe("anthropic/claude-opus-5.5");
  expect(await usage("user-1")).toMatchObject({ spent_usd: 0.25, requests: 1 });
});

test("a client that goes away stops the upstream; the call waits as pending", async () => {
  const response = await messages("cut", "user-cut", "session-cut");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/message_start/);
  await reader.cancel();
  await vi.waitFor(() =>
    expect(seen.findLast((entry) => entry.body.includes('"cut"'))?.aborted).toBe(true)
  );
  await vi.waitFor(async () => {
    await gateway.idle();
    expect((await gateway.ledger.snapshot()).pending_requests).toBe(1);
  });
  expect((await usage("user-cut")).requests, "not counted at $0").toBe(0);
});

test(
  "the alarm timer runs the backfill, which settles the pending call",
  { timeout: BACKFILL_MIN_AGE_MS * 4 },
  async () => {
    // The pending call set the alarm for BACKFILL_MIN_AGE_MS after it; the timer fires then.
    await vi.waitFor(
      async () => expect((await gateway.ledger.snapshot()).pending_requests).toBe(0),
      { timeout: BACKFILL_MIN_AGE_MS * 3, interval: 200 }
    );
    expect(gateway.ledger.usage("user-cut")).toMatchObject({ spent_usd: 0.05, requests: 1 });
    expect(seen.some((entry) => entry.url === "/api/v1/generation?id=gen-cut")).toBe(true);
  }
);

test("a user over budget is refused with the tag and headers, before the upstream", async () => {
  await gateway.ledger.record({
    sid: "s-heavy",
    sub: "user-heavy",
    model: "m",
    usage: { cost: 1 },
  });
  const before = seen.length;
  const refused = await messages("hello", "user-heavy", "s-heavy");
  expect(refused.status).toBe(429);
  const body = (await refused.json()) as { error: { message: string } };
  const resetsAt = gateway.ledger.usage("user-heavy").resets_at;
  expect(body.error.message.endsWith(` [llm_budget=user resets_at=${resetsAt}]`)).toBe(true);
  expect(refused.headers.get("x-llm-budget")).toBe("user");
  expect(refused.headers.get("x-llm-budget-resets-at")).toBe(resetsAt);
  expect(seen.length).toBe(before);
});

test("health, the admin routes on the one port, and a restart that keeps the ledger", async () => {
  expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  expect((await fetch(`${base}/admin/usage`)).status).toBe(401);
  const admin = { authorization: `Bearer ${token({ sub: "admin-1", scope: "admin" })}` };
  const snapshot = (await (await fetch(`${base}/admin/usage`, { headers: admin })).json()) as {
    baseline_usd: number;
  };
  expect(snapshot.baseline_usd).toBe(10);
  const overview = (await (
    await fetch(`${base}/llm/admin/overview`, { headers: admin })
  ).json()) as { users: Array<{ sub: string }> };
  expect(overview.users.map((user) => user.sub)).toContain("user-1");

  await stopGateway();
  await startGateway();
  expect(await usage("user-1")).toMatchObject({ spent_usd: 0.25, requests: 1 });
  expect(await usage("user-cut")).toMatchObject({ spent_usd: 0.05, requests: 1 });
});
