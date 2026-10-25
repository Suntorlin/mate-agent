/**
 * A sandbox data plane on the local Docker daemon.
 *
 * It answers the endpoints the control plane's Modal client calls (`api-create-sandbox`,
 * `api-restore-sandbox`, `api-snapshot-sandbox`, `api-stop-sandbox`) by running the sandbox image
 * as a container, so a session runs end to end on one machine with no cloud. The control plane is
 * pointed at it with SANDBOX_PROVIDER=modal and MODAL_API_URL=http://localhost:<PORT>.
 *
 * Secrets never reach a command line: every value goes to `docker run` through the child's
 * environment and is named with `-e NAME` only.
 *
 * Environment:
 *   PORT                     listen port (default 9910), bound to 127.0.0.1
 *   MODAL_API_SECRET         the HMAC secret the control plane signs its calls with
 *   DATAPLANE_IMAGE          sandbox image (default agent-engine-sandbox:local)
 *   DATAPLANE_RUNTIME_ENV    JSON object: the image's runtime environment (PATH, HOME, ...)
 *   DATAPLANE_SANDBOX_ENV    comma-separated names copied from this process into every sandbox
 *                            (e.g. ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN)
 *   DATAPLANE_CPUS / DATAPLANE_MEMORY   container limits (default 2 / 4g)
 *   DATAPLANE_PLATFORM       e.g. linux/amd64 for the full image; empty runs the host's architecture
 */

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);

const PORT = Number(process.env.PORT ?? 9910);
const SECRET = process.env.MODAL_API_SECRET ?? "";
const IMAGE = process.env.DATAPLANE_IMAGE ?? "agent-engine-sandbox:local";
const CPUS = process.env.DATAPLANE_CPUS ?? "2";
const MEMORY = process.env.DATAPLANE_MEMORY ?? "4g";
/** Empty: the host's own architecture (the slim local image is built natively). */
const PLATFORM = process.env.DATAPLANE_PLATFORM ?? "";
const RUNTIME_ENV = JSON.parse(process.env.DATAPLANE_RUNTIME_ENV ?? "{}");
const PASS_ENV = (process.env.DATAPLANE_SANDBOX_ENV ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const LABEL = "agent-engine.sandbox";
const TOKEN_VALIDITY_MS = 5 * 60 * 1000;
/** Keys the launch sets itself; a user's env var cannot override them (as on Modal). */
const RESERVED = new Set([
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "SANDBOX_TIMEOUT_SECONDS",
  "REPO_OWNER",
  "REPO_NAME",
]);
/** URL-valued variables a sandbox dials; on the host's loopback they need the host's name. */
const LOOPBACK_URL_ENV = ["GATEWAY_URL", "ANTHROPIC_BASE_URL"];
/** SessionConfig fields the create request carries flat (see sandbox_runtime/types.py). */
const SESSION_FIELDS = [
  "session_id",
  "repo_owner",
  "repo_name",
  "branch",
  "agent_session_id",
  "harness",
  "provider",
  "model",
  "reasoning_effort",
  "mcp_servers",
  "repositories",
  "bridge_early_connect",
];

function log(event, fields = {}) {
  console.log(JSON.stringify({ component: "docker-dataplane", event, ...fields }));
}

export function isValidInternalToken(header, secret = SECRET, now = Date.now()) {
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token || !secret) return false;
  const [timestamp, signature] = token.split(".");
  if (!timestamp || !signature) return false;
  if (Math.abs(now - Number(timestamp)) > TOKEN_VALIDITY_MS) return false;
  const expected = createHmac("sha256", secret).update(timestamp).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** A container reaches the host's loopback through host.docker.internal, not localhost. */
export function reachableFromContainer(url) {
  const parsed = new URL(url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.toString().replace(/\/$/, "");
}

/** Remote MCP servers on the host's loopback (a local product backend) as the container reaches them. */
export function withReachableMcpServers(sessionConfig) {
  if (!Array.isArray(sessionConfig.mcp_servers)) return sessionConfig;
  return {
    ...sessionConfig,
    mcp_servers: sessionConfig.mcp_servers.map((server) =>
      server?.type === "remote" && typeof server.url === "string"
        ? { ...server, url: reachableFromContainer(server.url) }
        : server
    ),
  };
}

export function containerName(sandboxId) {
  return `ae-${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`.slice(0, 120);
}

/**
 * The environment a sandbox starts with, and the `docker run` arguments that name it. Values stay
 * in the returned env (the child's environment); the arguments carry names only.
 */
export function launchSpec({ sandboxId, body, sessionConfig, restored, image }) {
  const env = {};
  for (const [key, value] of Object.entries(body.user_env_vars ?? {})) {
    if (!RESERVED.has(key) && typeof value === "string") env[key] = value;
  }
  for (const name of PASS_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of LOOPBACK_URL_ENV) {
    if (env[name]) env[name] = reachableFromContainer(env[name]);
  }
  Object.assign(env, RUNTIME_ENV, {
    PYTHONUNBUFFERED: "1",
    SANDBOX_ID: sandboxId,
    CONTROL_PLANE_URL: reachableFromContainer(body.control_plane_url),
    SANDBOX_AUTH_TOKEN: body.sandbox_auth_token,
    SANDBOX_TIMEOUT_SECONDS: String(body.timeout_seconds ?? 7200),
    REPO_OWNER: sessionConfig.repo_owner ?? "",
    REPO_NAME: sessionConfig.repo_name ?? "",
    SESSION_CONFIG: JSON.stringify(withReachableMcpServers(sessionConfig)),
  });
  if (restored) env.RESTORED_FROM_SNAPSHOT = "true";

  const args = [
    "run",
    "--detach",
    ...(PLATFORM ? [`--platform=${PLATFORM}`] : []),
    `--name=${containerName(sandboxId)}`,
    `--label=${LABEL}=${sandboxId}`,
    `--label=agent-engine.session=${sessionConfig.session_id}`,
    // Which data plane started it, so a stack can clean up its own sandboxes and no one else's.
    `--label=agent-engine.dataplane=${PORT}`,
    `--cpus=${CPUS}`,
    `--memory=${MEMORY}`,
    "--add-host=host.docker.internal:host-gateway",
    "--workdir=/workspace",
    ...Object.keys(env).flatMap((name) => ["-e", name]),
    image,
    "python",
    "-m",
    "sandbox_runtime.entrypoint",
  ];
  return { args, env };
}

async function docker(args, env) {
  const { stdout } = await run("docker", args, {
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function startContainer(spec) {
  // A retried create for the same sandbox replaces the earlier container.
  await docker(["rm", "--force", spec.args.find((a) => a.startsWith("--name=")).slice(7)]).catch(
    () => {}
  );
  return docker(spec.args, spec.env);
}

function sessionConfigFromCreate(body) {
  const config = {};
  for (const field of SESSION_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) config[field] = body[field];
  }
  return config;
}

async function handleCreate(body) {
  const sandboxId = body.sandbox_id ?? `sandbox-${Date.now()}`;
  const sessionConfig = sessionConfigFromCreate(body);
  const containerId = await startContainer(
    launchSpec({ sandboxId, body, sessionConfig, restored: false, image: IMAGE })
  );
  log("sandbox.created", { session_id: body.session_id, sandbox_id: sandboxId });
  return {
    sandbox_id: sandboxId,
    modal_object_id: containerId,
    created_at: Date.now(),
  };
}

async function handleRestore(body) {
  const sandboxId = body.sandbox_id ?? `sandbox-${Date.now()}`;
  const sessionConfig = body.session_config;
  if (!sessionConfig?.session_id) throw new Error("restore carried no session_config.session_id");
  const containerId = await startContainer(
    launchSpec({ sandboxId, body, sessionConfig, restored: true, image: body.snapshot_image_id })
  );
  log("sandbox.restored", { session_id: sessionConfig.session_id, sandbox_id: sandboxId });
  return { sandbox_id: sandboxId, modal_object_id: containerId };
}

/** Snapshots a session keeps; older ones are removed (a restore uses the latest). */
const SNAPSHOTS_KEPT = 2;

async function handleSnapshot(body) {
  const tag = `agent-engine-snapshot:${Date.now()}`;
  const session = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "agent-engine.session"}}',
    body.sandbox_id,
  ]);
  await docker([
    "commit",
    `--change=LABEL agent-engine.snapshot-of=${session}`,
    body.sandbox_id,
    tag,
  ]);
  log("sandbox.snapshotted", { container: body.sandbox_id.slice(0, 12), image: tag });
  await pruneSnapshots(session).catch((error) =>
    log("snapshot.prune_failed", { error: error.message.slice(0, 200) })
  );
  return { image_id: tag, source_stopped: false };
}

async function pruneSnapshots(session) {
  // Newest first; tags are creation times in milliseconds.
  const tags = (
    await docker([
      "images",
      "--filter",
      `label=agent-engine.snapshot-of=${session}`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ])
  )
    .split("\n")
    .filter(Boolean)
    .sort()
    .reverse();
  for (const old of tags.slice(SNAPSHOTS_KEPT)) await docker(["rmi", old]).catch(() => {});
}

async function handleStop(body) {
  await docker(["rm", "--force", body.sandbox_id]).catch(() => {});
  log("sandbox.stopped", { container: body.sandbox_id.slice(0, 12) });
  return undefined;
}

const ROUTES = {
  "/api-create-sandbox": handleCreate,
  "/api-restore-sandbox": handleRestore,
  "/api-snapshot-sandbox": handleSnapshot,
  "/api-stop-sandbox": handleStop,
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

export function createDataplaneServer() {
  return createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/healthz") return sendJson(res, 200, { ok: true });
    const handler = ROUTES[path];
    if (!handler) return sendJson(res, 404, { success: false, error: `not served: ${path}` });
    if (!isValidInternalToken(req.headers.authorization)) {
      return sendJson(res, 401, { success: false, error: "invalid internal token" });
    }
    readJsonBody(req)
      .then(async (body) => {
        const data = await handler(body);
        sendJson(res, 200, data === undefined ? { success: true } : { success: true, data });
      })
      .catch((error) => {
        log("request.failed", { path, error: error.message.slice(0, 500) });
        sendJson(res, 500, { success: false, error: "dataplane request failed" });
      });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!SECRET) throw new Error("MODAL_API_SECRET must be set");
  createDataplaneServer().listen(PORT, "127.0.0.1", () =>
    log("listening", { port: PORT, image: IMAGE })
  );
}
