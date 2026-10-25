// Forwards an Anthropic Messages request to OpenRouter and relays the response
// byte for byte: status, error bodies, retry headers and SSE chunks (including
// pings) go back to Claude Code as they arrive, never buffered. The relay is a
// TransformStream that reads `usage` from the bytes as they pass.
import type { RequestUsage } from "./budget";

/** An upstream that sends nothing for this long (headers or body) is given up on. */
const UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const KEY_USAGE_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 60_000;
const MAX_JSON_TAP_BYTES = 4 * 1024 * 1024;
// Never relayed back: hop-by-hop headers, the upstream's cookies, and the length of a body the
// relay streams anew.
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "set-cookie",
  "content-length",
]);
// A response with one of these statuses has no body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface ForwardResult {
  status: number;
  bytes: number;
  usage: RequestUsage | null;
  aborted: boolean;
  /** OpenRouter's id for the call (`x-generation-id`), to look its cost up later. */
  generationId?: string;
  /** Why the model stopped (`tool_use` when it went off to run a tool), when the response said. */
  stopReason?: string;
}

/** Only anthropic-* headers (an open list) plus accept travel upstream; credentials never do. */
export function upstreamHeaders(incoming: Headers, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "identity",
    "x-api-key": apiKey,
  };
  incoming.forEach((value, name) => {
    if (name.startsWith("anthropic-")) headers[name] = value;
  });
  const accept = incoming.get("accept");
  if (accept !== null) headers.accept = accept;
  return headers;
}

/** The headers a later ping sends upstream again: what Claude Code sent, credentials left out. */
export function anthropicHeaders(incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  incoming.forEach((value, name) => {
    if (name.startsWith("anthropic-")) headers[name] = value;
  });
  return headers;
}

export function downstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) headers.append(name, value);
  });
  return headers;
}

/**
 * Reads `usage` from a response as it streams past, without holding the stream:
 * SSE message_start carries the input usage, message_delta the cumulative totals
 * (OpenRouter adds `cost` in USD there). Plain JSON responses are parsed at the end.
 */
export function createUsageTap(contentType: string) {
  const isSse = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  let jsonBytes = 0;
  let usage: Record<string, unknown> | null = null;
  let stopReason: string | undefined;

  function readLine(line: string): void {
    if (!line.startsWith("data:") || !line.includes('"usage"')) return;
    try {
      const event = JSON.parse(line.slice(5)) as {
        type?: string;
        usage?: Record<string, unknown>;
        message?: { usage?: Record<string, unknown> };
        delta?: { stop_reason?: unknown };
      };
      if (event.type === "message_start" && event.message?.usage)
        usage = { ...event.message.usage };
      if (event.type === "message_delta" && event.usage) usage = { ...usage, ...event.usage };
      if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
    } catch {
      // not a JSON data line; ignore
    }
  }

  return {
    push(chunk: Uint8Array): void {
      if (!isSse) {
        jsonBytes += chunk.byteLength;
        if (jsonBytes <= MAX_JSON_TAP_BYTES) pending += decoder.decode(chunk, { stream: true });
        return;
      }
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => readLine(line.trimEnd()));
    },
    result(): RequestUsage | null {
      if (isSse) {
        readLine((pending + decoder.decode()).trimEnd());
      } else if (jsonBytes <= MAX_JSON_TAP_BYTES) {
        try {
          const body = JSON.parse(pending + decoder.decode()) as {
            usage?: Record<string, unknown>;
            stop_reason?: unknown;
          };
          usage = body.usage ?? null;
          if (typeof body.stop_reason === "string") stopReason = body.stop_reason;
        } catch {
          usage = null;
        }
      }
      return usage as RequestUsage | null;
    },
    /** Known once `result()` has run. */
    stopReason(): string | undefined {
      return stopReason;
    },
  };
}

export function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface Forwarded {
  /** What goes back to Claude Code: the upstream's status and headers, its body as it arrives. */
  response: Response;
  /** Resolves once the body has gone through, or was cut off (`aborted`). Never rejects. */
  done: Promise<ForwardResult>;
}

export async function forward(options: {
  url: URL;
  body: string;
  incoming: Headers;
  apiKey: string;
  idleTimeoutMs?: number;
}): Promise<Forwarded> {
  const upstreamAbort = new AbortController();
  const idleTimeoutMs = options.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => upstreamAbort.abort(new Error("upstream idle timeout")), idleTimeoutMs);
  };
  touch();

  let upstream: Response;
  try {
    upstream = await fetch(options.url, {
      method: "POST",
      headers: upstreamHeaders(options.incoming, options.apiKey),
      body: options.body,
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    if (idle !== undefined) clearTimeout(idle);
    const response = new Response(
      anthropicError("api_error", `Upstream request failed: ${errorMessage(error)}`),
      { status: 502, headers: { "content-type": "application/json", "x-should-retry": "true" } }
    );
    return {
      response,
      done: Promise.resolve({ status: 502, bytes: 0, usage: null, aborted: true }),
    };
  }

  const { status } = upstream;
  const generationId = upstream.headers.get("x-generation-id") || undefined;
  const tap = createUsageTap(upstream.headers.get("content-type") ?? "");
  let bytes = 0;
  let finished = false;
  let resolveDone: (result: ForwardResult) => void = () => {};
  const done = new Promise<ForwardResult>((resolve) => (resolveDone = resolve));
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    if (idle !== undefined) clearTimeout(idle);
    const usage = tap.result();
    const stopReason = tap.stopReason();
    resolveDone({
      status,
      bytes,
      usage,
      aborted,
      ...(generationId ? { generationId } : {}),
      ...(stopReason ? { stopReason } : {}),
    });
  };
  const headers = downstreamHeaders(upstream.headers);
  if (!upstream.body || NULL_BODY_STATUSES.has(status)) {
    void upstream.body?.cancel();
    finish(false);
    return { response: new Response(null, { status, headers }), done };
  }

  const relay = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      touch();
      bytes += chunk.byteLength;
      tap.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      finish(false);
    },
    // Claude Code went away: stop the upstream generation so it stops costing money.
    cancel() {
      upstreamAbort.abort();
      finish(true);
    },
  });
  // The pipe ends once the body has gone through (flush has run), was cancelled, or failed
  // upstream; in the last cases the call was cut off.
  upstream.body.pipeTo(relay.writable).then(
    () => {
      if (finished) return;
      upstreamAbort.abort();
      finish(true);
    },
    () => {
      upstreamAbort.abort();
      finish(true);
    }
  );
  return { response: new Response(relay.readable, { status, headers }), done };
}

export async function fetchKeyUsage(baseUrl: string, apiKey: string): Promise<number> {
  const response = await fetch(`${baseUrl}/v1/key`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(KEY_USAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET /v1/key returned ${response.status}`);
  const body = (await response.json()) as { data?: { usage?: unknown } };
  const usage = body.data?.usage;
  if (typeof usage !== "number" || !Number.isFinite(usage)) {
    throw new Error("GET /v1/key returned no numeric data.usage");
  }
  return usage;
}

/**
 * A call's cost and tokens as OpenRouter bills them, by generation id: null while OpenRouter does
 * not know the id yet (it answers 404 for a few seconds after a call ends or is cut off).
 */
export async function fetchGeneration(
  baseUrl: string,
  apiKey: string,
  id: string
): Promise<RequestUsage | null> {
  const response = await fetch(`${baseUrl}/v1/generation?id=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(KEY_USAGE_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /v1/generation returned ${response.status}`);
  const body = (await response.json()) as { data?: Record<string, unknown> };
  const data = body.data ?? {};
  const cost = data.total_cost;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  const count = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = data[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const prompt = count("native_tokens_prompt", "tokens_prompt");
  const cached = count("native_tokens_cached") ?? 0;
  const output = count("native_tokens_completion", "tokens_completion");
  return {
    cost,
    ...(prompt === undefined ? {} : { input_tokens: Math.max(0, prompt - cached) }),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
    ...(output === undefined ? {} : { output_tokens: output }),
  };
}

/**
 * A keep-alive ping: the session's last request again, for one token. Resolves to its usage, or
 * null when OpenRouter did not answer 200.
 */
export async function sendPing(
  url: string,
  body: string,
  headers: Record<string, string>,
  apiKey: string
): Promise<{ usage: RequestUsage | null; generationId?: string } | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: upstreamHeaders(new Headers(headers), apiKey),
    body,
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  // The answer comes in the session's own format, usually a stream: read it to its end for the usage.
  const tap = createUsageTap(response.headers.get("content-type") ?? "");
  tap.push(new Uint8Array(await response.arrayBuffer()));
  const generationId = response.headers.get("x-generation-id") ?? undefined;
  return { usage: tap.result(), ...(generationId ? { generationId } : {}) };
}
