import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appInlineTools,
  appSandboxMcpServer,
  appUserId,
  clearAppTokenCache,
  mintAppToken,
  readAppConfig,
} from "./product";

const config = {
  mcpUrl: "https://product.test/mcp",
  tokenUrl: "https://product.test/engine/mcp-token",
  engineToken: "engine-bearer",
  mcpName: "app",
};

/** A product backend: mints tokens and serves an MCP server (one answer as SSE). */
function fakeProduct() {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(url), auth, body });
    if (String(url) === config.tokenUrl) {
      return Response.json({ access_token: `tok-${String(body.user_id)}`, expires_in: 3600 });
    }
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: body.id, result });
    switch (body.method) {
      case "initialize":
        return Response.json(
          reply({ protocolVersion: "2025-06-18", capabilities: {}, instructions: "persona" }),
          {
            headers: { "Mcp-Session-Id": "mcp-1" },
          }
        );
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return Response.json(
          reply({
            tools: [
              { name: "list_tasks", description: "Today's tasks", inputSchema: { type: "object" } },
            ],
          })
        );
      case "tools/call":
        return new Response(
          `event: message\ndata: ${JSON.stringify(reply({ content: [{ type: "text", text: "3 tasks" }] }))}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
    }
    return new Response("unknown", { status: 400 });
  });
  return { fetchFn, calls };
}

beforeEach(() => clearAppTokenCache());

describe("app product", () => {
  it("is configured only with all three variables", () => {
    expect(readAppConfig({ APP_MCP_URL: "u", APP_TOKEN_URL: "t", APP_ENGINE_TOKEN: "k" })).toEqual({
      mcpUrl: "u",
      tokenUrl: "t",
      engineToken: "k",
      mcpName: "app",
    });
    expect(readAppConfig({ APP_MCP_URL: "u", APP_TOKEN_URL: "t" })).toBeNull();
  });

  it("names the product's MCP server from APP_MCP_NAME, and refuses a name that breaks mcp__<name>__", () => {
    const set = { APP_MCP_URL: "u", APP_TOKEN_URL: "t", APP_ENGINE_TOKEN: "k" };
    expect(readAppConfig({ ...set, APP_MCP_NAME: " acme " })?.mcpName).toBe("acme");
    expect(readAppConfig({ ...set, APP_MCP_NAME: "" })?.mcpName).toBe("app");
    for (const bad of ["my_tools", "Acme", "1acme", "a".repeat(32)]) {
      expect(() => readAppConfig({ ...set, APP_MCP_NAME: bad })).toThrow(/APP_MCP_NAME/);
    }
  });

  it("reads the product's user only from app participants", () => {
    expect(appUserId("app:space-1")).toBe("space-1");
    expect(appUserId("slack:U1")).toBeNull();
    expect(appUserId("app:")).toBeNull();
    expect(appUserId(null)).toBeNull();
  });

  it("mints with the engine's bearer and reuses a token with life left", async () => {
    const { fetchFn, calls } = fakeProduct();
    let now = 1_000_000;
    const first = await mintAppToken(config, "space-1", fetchFn, () => now);
    now += 30 * 60 * 1000;
    const second = await mintAppToken(config, "space-1", fetchFn, () => now);
    now += 26 * 60 * 1000;
    await mintAppToken(config, "space-1", fetchFn, () => now);

    expect(first.token).toBe("tok-space-1");
    expect(second).toBe(first);
    expect(calls.filter((c) => c.url === config.tokenUrl)).toHaveLength(2);
    expect(calls[0]).toMatchObject({ auth: "Bearer engine-bearer", body: { user_id: "space-1" } });
  });

  it("turns the product's MCP tools into inline tools that call back with the user's token", async () => {
    const { fetchFn, calls } = fakeProduct();
    const { tools, instructions } = await appInlineTools(config, "space-1", fetchFn);
    expect(instructions).toBe("persona");

    expect(tools.map((t) => t.definition)).toEqual([
      { name: "list_tasks", description: "Today's tasks", input_schema: { type: "object" } },
    ]);
    // Recorded as a sandbox's agent would record the same call.
    expect(tools.map((t) => t.eventName)).toEqual(["mcp__app__list_tasks"]);
    await expect(tools[0].execute({ day: "today" })).resolves.toBe("3 tasks");
    const call = calls.find((c) => c.body.method === "tools/call");
    expect(call).toMatchObject({
      auth: "Bearer tok-space-1",
      body: { params: { name: "list_tasks", arguments: { day: "today" } } },
    });
    expect(calls.map((c) => c.body.method).filter(Boolean)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });

  it("names the engine session on every call to the product's tools", async () => {
    const seen: Array<string | null> = [];
    const { fetchFn } = fakeProduct();
    const watched = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === config.mcpUrl)
        seen.push(new Headers(init?.headers).get("x-agent-session"));
      return fetchFn(url, init);
    });
    const { tools } = await appInlineTools(config, "space-1", watched, "sess-1");
    await tools[0].execute({});
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set(["sess-1"]));
  });

  it("hands a sandbox the product's server with the user's token", async () => {
    const { fetchFn } = fakeProduct();
    await expect(appSandboxMcpServer(config, "space-1", fetchFn)).resolves.toMatchObject({
      name: "app",
      type: "remote",
      url: config.mcpUrl,
      headers: { Authorization: "Bearer tok-space-1" },
      enabled: true,
    });
    await expect(
      appSandboxMcpServer({ ...config, mcpName: "acme" }, "space-2", fetchFn)
    ).resolves.toMatchObject({ id: "app", name: "acme" });
  });
});
