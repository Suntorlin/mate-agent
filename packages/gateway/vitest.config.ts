// The core's and the Worker's tests run inside workerd through @cloudflare/vitest-pool-workers,
// against wrangler.jsonc: the Worker and the ledger Durable Object share the tests' isolate, so a
// test's stub of the global fetch stands in for OpenRouter and the alert webhook (nothing goes
// out), and a fake clock reaches the Durable Object too. The secrets and keys below are fakes.
// The Node host's tests run in Node: vitest.node.config.ts.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GATEWAY_SECRET: "test-secret-0123456789abcdef",
          OPENROUTER_API_KEY: "sk-or-test-upstream-key",
          OPENROUTER_BASE_URL: "https://openrouter.test/api",
          LLM_BUDGET_USD: "25",
          LLM_USER_BUDGET_USD: "5",
          CACHE_KEEPALIVE: "true",
          CACHE_KEEPALIVE_TOOL_PINGS: "2",
          CACHE_KEEPALIVE_IDLE_PINGS: "0",
        },
      },
    }),
  ],
  test: {
    include: ["test/core/**/*.test.ts", "test/worker/**/*.test.ts"],
  },
});
