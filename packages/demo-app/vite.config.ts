import { resolve } from "node:path";
import { defineConfig } from "vite";

/** The web app and its design-system showcase (`/design.html`); `npm run dev:web` proxies /api to the backend on DEMO_PORT. */
export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        design: resolve(import.meta.dirname, "web/design.html"),
      },
    },
  },
  oxc: { jsx: { runtime: "automatic" } },
  server: {
    port: 5180,
    proxy: { "/api": `http://127.0.0.1:${process.env.DEMO_PORT ?? 9320}` },
  },
});
