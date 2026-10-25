// What a /v1/messages request is made of, in characters, for the request log. Sizes only, never
// content: enough to see which part of the context (system prompt, built-in tool definitions, each
// MCP server's definitions, the conversation, images) a session keeps paying to re-read, and the
// thinking effort it was sent at.

export interface RequestShape {
  /** System prompt text. */
  sys: number;
  /** Built-in tool definitions: how many, and their JSON size. */
  tools: [count: number, chars: number];
  /** MCP tool definitions per server (`mcp__<server>__<tool>`): how many, and their JSON size. */
  mcp: Record<string, [count: number, chars: number]>;
  /** Conversation: messages, their text and tool-call JSON, and how much of that is tool results. */
  msgs: [count: number, chars: number, toolResultChars: number];
  /** Image blocks anywhere in the conversation. */
  images: number;
  /** `output_config.effort`, when the request names one. */
  effort?: string;
}

const MCP_TOOL_NAME = /^mcp__(.+?)__/;

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const block of value) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      total += (block as { text: string }).text.length;
    }
  }
  return total;
}

export function requestShape(body: Record<string, unknown>): RequestShape {
  const shape: RequestShape = {
    sys: textLength(body.system),
    tools: [0, 0],
    mcp: {},
    msgs: [0, 0, 0],
    images: 0,
  };
  const effort = (body.output_config as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === "string") shape.effort = effort;
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const size = JSON.stringify(tool).length;
      const name = (tool as { name?: unknown } | null)?.name;
      const server = typeof name === "string" ? MCP_TOOL_NAME.exec(name)?.[1] : undefined;
      const bucket = server ? (shape.mcp[server] ??= [0, 0]) : shape.tools;
      bucket[0] += 1;
      bucket[1] += size;
    }
  }
  if (Array.isArray(body.messages)) {
    shape.msgs[0] = body.messages.length;
    for (const message of body.messages) {
      const content = (message as { content?: unknown } | null)?.content;
      if (typeof content === "string") {
        shape.msgs[1] += content.length;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const { type, text, input, content: inner } = block as Record<string, unknown>;
        if (type === "image") shape.images += 1;
        else if (type === "tool_result") {
          const size = textLength(inner);
          shape.msgs[1] += size;
          shape.msgs[2] += size;
          if (Array.isArray(inner)) {
            shape.images += inner.filter(
              (part) => (part as { type?: unknown } | null)?.type === "image"
            ).length;
          }
        } else if (type === "tool_use") shape.msgs[1] += JSON.stringify(input ?? {}).length;
        else if (typeof text === "string") shape.msgs[1] += text.length;
      }
    }
  }
  return shape;
}
