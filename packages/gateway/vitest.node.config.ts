// The Node host's tests: node:sqlite and a real HTTP server, in Node.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/node/**/*.test.ts"],
  },
});
