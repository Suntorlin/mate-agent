/**
 * A streaming Anthropic Messages client for the inline runtime.
 *
 * It speaks the Messages API at `${baseUrl}/v1/messages` with `stream: true`, which OpenRouter's
 * Anthropic-compatible endpoint and the engine's LLM gateway both serve, and reports the text as
 * it arrives. Tool calls come back whole once the stream ends.
 */

export interface InlineTextBlock {
  type: "text";
  text: string;
}

export interface InlineToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface InlineToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type InlineContentBlock = InlineTextBlock | InlineToolUseBlock | InlineToolResultBlock;

export interface InlineMessage {
  role: "user" | "assistant";
  content: string | InlineContentBlock[];
}

export interface InlineToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface InlineUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD, when the upstream reports it (OpenRouter does). */
  costUsd: number | null;
}

export interface InlineLlmRequest {
  model: string;
  system: string;
  messages: InlineMessage[];
  tools: InlineToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Called with each piece of text as it streams. */
  onText?: (delta: string) => void;
}

export interface InlineLlmResponse {
  content: Array<InlineTextBlock | InlineToolUseBlock>;
  stopReason: string | null;
  usage: InlineUsage;
}

export type InlineLlm = (request: InlineLlmRequest) => Promise<InlineLlmResponse>;

export interface InlineLlmConfig {
  /** Without the `/v1/messages` suffix, e.g. `https://openrouter.ai/api`. */
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

export class InlineLlmError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "InlineLlmError";
  }
}

interface StreamState {
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; json: string }
    | { type: "other" }
  >;
  stopReason: string | null;
  usage: InlineUsage;
}

function readUsage(value: unknown, usage: InlineUsage): void {
  const u = value as { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } | null;
  if (!u) return;
  if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
  if (typeof u.cost === "number") usage.costUsd = u.cost;
}

/** Apply one server-sent event of the Messages stream to the state. */
export function applyStreamEvent(
  state: StreamState,
  event: Record<string, unknown>,
  onText?: (delta: string) => void
): void {
  switch (event.type) {
    case "message_start":
      readUsage((event.message as { usage?: unknown } | undefined)?.usage, state.usage);
      break;
    case "content_block_start": {
      const block = event.content_block as { type?: string; id?: string; name?: string };
      const index = event.index as number;
      if (block?.type === "text") state.blocks[index] = { type: "text", text: "" };
      else if (block?.type === "tool_use") {
        state.blocks[index] = {
          type: "tool_use",
          id: block.id ?? "",
          name: block.name ?? "",
          json: "",
        };
      } else state.blocks[index] = { type: "other" };
      break;
    }
    case "content_block_delta": {
      const block = state.blocks[event.index as number];
      const delta = event.delta as { type?: string; text?: string; partial_json?: string };
      if (block?.type === "text" && delta?.type === "text_delta" && delta.text) {
        block.text += delta.text;
        onText?.(delta.text);
      } else if (block?.type === "tool_use" && delta?.type === "input_json_delta") {
        block.json += delta.partial_json ?? "";
      }
      break;
    }
    case "message_delta":
      state.stopReason =
        ((event.delta as { stop_reason?: unknown } | undefined)?.stop_reason as string) ?? null;
      readUsage(event.usage, state.usage);
      break;
    case "error":
      throw new InlineLlmError(
        `upstream stream error: ${JSON.stringify(event.error ?? {}).slice(0, 300)}`
      );
  }
}

function finish(state: StreamState): InlineLlmResponse {
  const content: Array<InlineTextBlock | InlineToolUseBlock> = [];
  for (const block of state.blocks) {
    if (!block) continue;
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "tool_use") {
      let input: Record<string, unknown> = {};
      try {
        input = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
      } catch {
        // A truncated call: the runtime reports it to the model as a failed tool call.
        input = { __invalid_json: block.json.slice(0, 200) };
      }
      content.push({ type: "tool_use", id: block.id, name: block.name, input });
    }
  }
  return { content, stopReason: state.stopReason, usage: state.usage };
}

export function createInlineLlm(config: InlineLlmConfig): InlineLlm {
  const fetchFn = config.fetchFn ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  return async (request) => {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.system,
        messages: request.messages,
        ...(request.tools.length > 0 ? { tools: request.tools } : {}),
        max_tokens: request.maxTokens,
        stream: true,
      }),
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new InlineLlmError(`upstream returned ${response.status}: ${detail}`, response.status);
    }

    const state: StreamState = {
      blocks: [],
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    };
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        applyStreamEvent(state, event, request.onText);
      }
    }
    return finish(state);
  };
}
