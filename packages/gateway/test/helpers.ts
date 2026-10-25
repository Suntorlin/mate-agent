// Shared by the workerd tests: signed tokens, a fake OpenRouter behind the global
// fetch, SSE streams to hold open, the log lines, and storage to build a ledger on.
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Alarm, SqlStore } from "../src/core/sql";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { durableSql } from "../src/worker/storage";

export const SECRET = "test-secret-0123456789abcdef";
export const UPSTREAM_KEY = "sk-or-test-upstream-key";
export const UPSTREAM = "https://openrouter.test/api";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

export async function signJwt(
  claims: Record<string, unknown>,
  secret = SECRET,
  alg = "HS256"
): Promise<string> {
  const head = `${encode({ alg, typ: "JWT" })}.${encode(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head));
  return `${head}.${base64Url(new Uint8Array(signature))}`;
}

export function freshClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "user-1", sid: "session-1", iat: now, exp: now + 600, ...overrides };
}

export const token = (overrides: Record<string, unknown> = {}) => signJwt(freshClaims(overrides));

export const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** A response body the test writes to, and can see cancelled. */
export function heldStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resolveCancelled: (reason: unknown) => void = () => {};
  const cancelled = new Promise<unknown>((resolve) => (resolveCancelled = resolve));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      resolveCancelled(reason ?? "cancelled");
    },
  });
  return {
    stream,
    cancelled,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (reason: unknown) => controller.error(reason),
  };
}

export interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | null;
}

/**
 * Replaces the global fetch, for the Worker and the ledger Durable Object alike: `handler`
 * answers every request, and `seen` keeps them. Restored by vi.restoreAllMocks().
 */
export function fakeFetch(handler: (request: SeenRequest) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const entry: SeenRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: init?.signal ?? null,
    };
    seen.push(entry);
    return handler(entry);
  });
  return seen;
}

/** What GET /v1/key answers with: the key's spend in USD. */
export const keyUsage = (usage: number) => Response.json({ data: { usage } });

/** The JSON log lines written while the test runs. */
export function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line !== "string") return;
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not one of ours
    }
  });
  return lines;
}

/** Calls the Worker the way the runtime would; `settled()` waits for its waitUntil work. */
export async function callWorker(
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {}
): Promise<{ response: Response; settled: () => Promise<void> }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, init),
    { ...env, ...overrides },
    ctx
  );
  return { response, settled: () => waitOnExecutionContext(ctx) };
}

/** POSTs a Messages-style body with a gateway token. */
export function post(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  overrides: Partial<Env> = {}
) {
  return callWorker(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    overrides
  );
}

/** The one ledger every request goes through. */
export const ledgerStub = () => env.LEDGER.get(env.LEDGER.idFromName("global"));

/** Runs `fn` on a fresh Durable Object's SQLite: a scratch database per call. */
export function withStorage<T>(fn: (sql: SqlStore) => Promise<T> | T): Promise<T> {
  const stub = env.LEDGER.get(env.LEDGER.newUniqueId());
  return runInDurableObject(stub, (_instance, state) => fn(durableSql(state.storage)));
}

/** A ledger's storage in a test: the alarm is only a value, fired by the test. */
export interface TestStorage {
  sql: SqlStore;
  alarm: Alarm;
  /** Clears the alarm, as the runtime does before it calls `alarm()`. */
  clearAlarm(): void;
}

/**
 * Like withStorage, for a ledger the test builds itself: the same SQLite, but an alarm the test
 * reads, and fires by clearing it and calling `tick`, so the scratch object's own alarm never
 * runs.
 */
export function withLedgerStorage<T>(
  fn: (storage: TestStorage, alarm: () => number | null) => Promise<T> | T
): Promise<T> {
  return withStorage((sql) => {
    let at: number | null = null;
    const storage: TestStorage = {
      sql,
      alarm: {
        get: async () => at,
        set: async (next) => {
          at = next;
        },
      },
      clearAlarm: () => {
        at = null;
      },
    };
    return fn(storage, () => at);
  });
}
