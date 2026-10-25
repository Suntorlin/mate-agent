/**
 * A minimal MCP client over Streamable HTTP, for the inline runtime: `initialize`, then
 * `tools/list` and `tools/call` as JSON-RPC POSTs. A response may be plain JSON or a server-sent
 * event stream; the first message answering the request id is taken. The server's
 * `Mcp-Session-Id`, when it sends one, rides on every later request of the same client.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 30_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function readResponse(text: string, contentType: string | null, id: number): JsonRpcResponse {
  if (contentType?.includes("text/event-stream")) {
    for (const frame of text.split("\n\n")) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const message = JSON.parse(data) as JsonRpcResponse;
        if (message.id === id) return message;
      } catch {
        // not a JSON-RPC message
      }
    }
    throw new McpClientError("MCP stream ended without a response");
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new McpClientError("MCP server returned a body that is not JSON");
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized: Promise<void> | null = null;
  /** What the server's `initialize` result says about using it (MCP `instructions`), if anything. */
  instructions: string | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    /** Sent with every request, e.g. the engine session the calls come from. */
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  private async post(body: Record<string, unknown>, expectResponse: boolean): Promise<unknown> {
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new McpClientError(`MCP server returned ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!expectResponse) return undefined;
    const message = readResponse(text, response.headers.get("content-type"), body.id as number);
    if (message.error) {
      throw new McpClientError(
        `MCP error ${message.error.code ?? ""}: ${message.error.message ?? ""}`
      );
    }
    return message.result;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    return this.post({ id: this.nextId++, method, params }, true);
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const result = (await this.post(
        {
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "agent-engine-inline", version: "1" },
          },
        },
        true
      )) as { instructions?: unknown } | undefined;
      if (typeof result?.instructions === "string") this.instructions = result.instructions;
      await this.post({ method: "notifications/initialized" }, false);
    })();
    return this.initialized;
  }

  /** The server's instructions, after initializing if that has not happened yet. */
  async getInstructions(): Promise<string | undefined> {
    await this.initialize();
    return this.instructions;
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  /** The text of the tool's result; a result the server flags as an error throws. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    const text = (result?.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (result?.isError) throw new McpClientError(text || "tool failed");
    return text;
  }
}
