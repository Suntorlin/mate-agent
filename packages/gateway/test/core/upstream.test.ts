// The relay on its own: the upstream that goes quiet, and the usage tap.
import { afterEach, expect, test, vi } from "vitest";
import { createUsageTap, forward } from "../../src/core/upstream";
import { UPSTREAM, fakeFetch, heldStream, sse } from "../helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (idleTimeoutMs: number) =>
  forward({
    url: new URL(`${UPSTREAM}/v1/messages`),
    body: "{}",
    incoming: new Headers({ "anthropic-version": "2023-06-01" }),
    apiKey: "sk-or-test",
    idleTimeoutMs,
  });

test("an upstream that sends nothing for the idle timeout is given up on", async () => {
  const held = heldStream();
  const seen = fakeFetch(({ signal }) => {
    // Like a real fetch body: aborting the request errors the stream.
    signal?.addEventListener("abort", () => held.fail(signal.reason));
    return new Response(held.stream, { headers: { "content-type": "text/event-stream" } });
  });
  const { response, done } = await request(50);
  held.write(sse("message_start", { message: { usage: { input_tokens: 4 } } }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/message_start/);
  // Then silence.
  const result = await done;
  expect(seen[0].signal?.aborted).toBe(true);
  expect(String(seen[0].signal?.reason)).toMatch(/upstream idle timeout/);
  expect(result).toMatchObject({ status: 200, aborted: true, usage: { input_tokens: 4 } });
  await expect(reader.read(), "Claude Code sees the stream break").rejects.toThrow();
});

test("an upstream that never answers is given up on with a 502", async () => {
  fakeFetch(
    ({ signal }) =>
      new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason))
      )
  );
  const { response, done } = await request(50);
  expect(response.status).toBe(502);
  expect(response.headers.get("x-should-retry")).toBe("true");
  expect((await response.json<{ error: { message: string } }>()).error.message).toBe(
    "Upstream request failed: upstream idle timeout"
  );
  expect(await done).toEqual({ status: 502, bytes: 0, usage: null, aborted: true });
});

test("the tap reads usage and the stop reason from SSE split anywhere, and from JSON", () => {
  const events =
    sse("message_start", { message: { usage: { input_tokens: 7, cache_read_input_tokens: 9 } } }) +
    sse("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3, cost: 0.25 },
    });
  const bytes = new TextEncoder().encode(events);
  const tap = createUsageTap("text/event-stream; charset=utf-8");
  // One byte at a time: lines and UTF-8 sequences split across chunks.
  for (let i = 0; i < bytes.length; i++) tap.push(bytes.subarray(i, i + 1));
  expect(tap.result()).toEqual({
    input_tokens: 7,
    cache_read_input_tokens: 9,
    output_tokens: 3,
    cost: 0.25,
  });
  expect(tap.stopReason()).toBe("tool_use");

  const json = createUsageTap("application/json");
  json.push(
    new TextEncoder().encode('{"usage":{"input_tokens":1,"cost":0.5},"stop_reason":"end_turn"}')
  );
  expect(json.result()).toEqual({ input_tokens: 1, cost: 0.5 });
  expect(json.stopReason()).toBe("end_turn");
});
