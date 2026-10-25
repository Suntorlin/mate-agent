import { describe, expect, it, vi } from "vitest";
import type { InlineLlmError } from "./llm";
import { createInlineLlm } from "./llm";

function sse(events: unknown[], chunkSize = 7): Response {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Split mid-frame so the parser has to buffer across reads.
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const STREAM = [
  { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的，" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我来查。" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t1", name: "list_tasks" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"day":' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"today"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 20, cost: 0.0004 },
  },
  { type: "message_stop" },
];

describe("createInlineLlm", () => {
  it("streams text, assembles tool calls and reads usage", async () => {
    const fetchFn = vi.fn(async () => sse(STREAM));
    const llm = createInlineLlm({ baseUrl: "https://llm.test/api/", apiKey: "key", fetchFn });
    const deltas: string[] = [];

    const response = await llm({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 100,
      onText: (d) => deltas.push(d),
    });

    expect(deltas.join("")).toBe("好的，我来查。");
    expect(response.content).toEqual([
      { type: "text", text: "好的，我来查。" },
      { type: "tool_use", id: "t1", name: "list_tasks", input: { day: "today" } },
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 20, costUsd: 0.0004 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.test/api/v1/messages");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("tools");
  });

  it("throws with the status when the upstream refuses", async () => {
    const llm = createInlineLlm({
      baseUrl: "https://llm.test/api",
      apiKey: "key",
      fetchFn: vi.fn(async () => new Response("quota", { status: 429 })),
    });
    await expect(
      llm({ model: "m", system: "s", messages: [], tools: [], maxTokens: 1 })
    ).rejects.toMatchObject({
      name: "InlineLlmError",
      status: 429,
    } satisfies Partial<InlineLlmError>);
  });

  it("surfaces an error event inside the stream", async () => {
    const llm = createInlineLlm({
      baseUrl: "https://llm.test/api",
      apiKey: "key",
      fetchFn: vi.fn(async () => sse([{ type: "error", error: { type: "overloaded_error" } }])),
    });
    await expect(
      llm({ model: "m", system: "s", messages: [], tools: [], maxTokens: 1 })
    ).rejects.toThrow(/overloaded_error/);
  });
});
