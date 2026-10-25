// The gateway's Node host: reads the configuration from the environment (the Worker's variable
// names), keeps the ledger in DATA_DIR/gateway.sqlite and listens on HOST:PORT.
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type GatewayConfig, parseConfig } from "../core/config";
import { log } from "../core/log";
import { createNodeGateway } from "./gateway";

/** A process has the memory for larger conversations than a Worker isolate. */
const NODE_MAX_PARSED_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_PORT = 8790;

function fail(message: string): never {
  console.error(`gateway: ${message}`);
  process.exit(1);
}

let config: GatewayConfig;
try {
  config = parseConfig(process.env, { maxParsedBodyBytes: NODE_MAX_PARSED_BODY_BYTES });
} catch (error) {
  fail((error as Error).message);
}
const dataDir = process.env.DATA_DIR || "/data";
const hostname = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || DEFAULT_PORT);

const gateway = createNodeGateway({ config, databasePath: join(dataDir, "gateway.sqlite") });
const server = serve({ fetch: gateway.app.fetch, hostname, port }, () =>
  log({ msg: `gateway listening on ${hostname}:${port}, ledger in ${dataDir}` })
);
void gateway.start();
// Records the key's usage baseline now rather than on the first call.
void gateway.ledger
  .snapshot()
  .then((usage) => log({ msg: "gateway: key usage at start", baseline_usd: usage.baseline_usd }));

process.on("SIGTERM", () => {
  server.close();
  // Lets the ledger record the calls that were still streaming.
  void gateway.idle().finally(() => {
    gateway.close();
    process.exit(0);
  });
});
