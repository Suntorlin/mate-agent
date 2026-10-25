/**
 * Runs the demo backend on 127.0.0.1:DEMO_PORT and serves the built web app (`vite build`) from
 * the same origin. See README.md for the environment it needs.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { EngineClient } from "./engine.ts";
import { Store } from "./store.ts";

const packageDir = resolve(import.meta.dirname, "..");
const webDir = join(packageDir, "dist");

function log(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : "";
  process.stderr.write(`[demo-app] ${message}${detail}\n`);
}

const config = readConfig();
const dataDir = resolve(packageDir, config.dataDir);
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, "demo.sqlite"));
const engine = new EngineClient({ baseUrl: config.engineUrl, secret: config.engineSecret });
const { app, relay } = createApp({ config, store, engine, log });

app.use("/*", serveStatic({ root: webDir }));
app.get("*", serveStatic({ root: webDir, path: "index.html" }));

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }, (info) =>
  log(`listening on http://localhost:${info.port} (engine ${config.engineUrl})`)
);

function shutdown(): void {
  relay.closeAll();
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
