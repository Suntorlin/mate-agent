import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  containerName,
  isValidInternalToken,
  launchSpec,
  reachableFromContainer,
  withReachableMcpServers,
} from "./server.mjs";

const SECRET = "s".repeat(32);
const sign = (timestamp) =>
  `Bearer ${timestamp}.${createHmac("sha256", SECRET).update(String(timestamp)).digest("hex")}`;

test("accepts a fresh internal token and refuses stale, forged or missing ones", () => {
  const now = 1_800_000_000_000;
  assert.equal(isValidInternalToken(sign(now), SECRET, now), true);
  assert.equal(isValidInternalToken(sign(now - 10 * 60 * 1000), SECRET, now), false);
  assert.equal(isValidInternalToken(`Bearer ${now}.deadbeef`, SECRET, now), false);
  assert.equal(isValidInternalToken(undefined, SECRET, now), false);
  assert.equal(isValidInternalToken(sign(now), "", now), false);
});

test("points loopback control-plane URLs at the host from inside a container", () => {
  assert.equal(reachableFromContainer("http://localhost:8797"), "http://host.docker.internal:8797");
  assert.equal(
    reachableFromContainer("http://127.0.0.1:8797/"),
    "http://host.docker.internal:8797"
  );
  assert.equal(reachableFromContainer("https://engine.example.com"), "https://engine.example.com");
});

test("names containers from the sandbox id with only safe characters", () => {
  assert.equal(containerName("sandbox/a b:1"), "ae-sandbox-a-b-1");
});

test("launch arguments name every variable but carry no value", () => {
  const body = {
    control_plane_url: "http://localhost:8797",
    sandbox_auth_token: "token-value-123",
    user_env_vars: { MY_KEY: "user-secret-456", SANDBOX_ID: "override-attempt" },
  };
  const { args, env } = launchSpec({
    sandboxId: "sb-1",
    body,
    sessionConfig: { session_id: "sess-1" },
    restored: true,
    image: "img:1",
  });
  const joined = args.join(" ");
  assert.doesNotMatch(joined, /token-value-123|user-secret-456/);
  assert.equal(env.SANDBOX_AUTH_TOKEN, "token-value-123");
  assert.equal(env.MY_KEY, "user-secret-456");
  assert.equal(env.SANDBOX_ID, "sb-1", "a user variable cannot override a launch variable");
  assert.equal(env.CONTROL_PLANE_URL, "http://host.docker.internal:8797");
  assert.equal(env.RESTORED_FROM_SNAPSHOT, "true");
  assert.deepEqual(JSON.parse(env.SESSION_CONFIG), { session_id: "sess-1" });
  assert.ok(args.includes("img:1"));
  assert.ok(
    args.includes("--label=agent-engine.dataplane=9910"),
    "a sandbox names the data plane that started it, so stack.sh down removes only its own"
  );
});

test("points loopback MCP servers at the host and leaves the rest", () => {
  const config = withReachableMcpServers({
    session_id: "s",
    mcp_servers: [
      { name: "app", type: "remote", url: "http://localhost:9312/api/mcp", headers: { A: "b" } },
      { name: "far", type: "remote", url: "https://mcp.example.com" },
      { name: "cli", type: "local", command: ["npx", "x"] },
    ],
  });
  assert.deepEqual(
    config.mcp_servers.map((s) => s.url ?? s.command),
    ["http://host.docker.internal:9312/api/mcp", "https://mcp.example.com", ["npx", "x"]]
  );
  assert.deepEqual(config.mcp_servers[0].headers, { A: "b" });
});

test("points a loopback LLM gateway at the host and leaves a remote one alone", () => {
  const launch = (userEnv) =>
    launchSpec({
      sandboxId: "sb-1",
      body: { control_plane_url: "http://localhost:8797", user_env_vars: userEnv },
      sessionConfig: { session_id: "sess-1" },
      restored: false,
      image: "img:1",
    }).env;
  const local = launch({
    GATEWAY_URL: "http://127.0.0.1:8795",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8795/llm",
  });
  assert.equal(local.GATEWAY_URL, "http://host.docker.internal:8795");
  assert.equal(local.ANTHROPIC_BASE_URL, "http://host.docker.internal:8795/llm");
  const remote = launch({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api" });
  assert.equal(remote.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
});
