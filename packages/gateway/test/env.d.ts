import type { Env as GatewayEnv } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    // `env` from "cloudflare:workers" is typed as Cloudflare.Env: the Worker's own bindings.
    interface Env extends GatewayEnv {}
    // `exports` from "cloudflare:workers": the Worker's entrypoints, GatewayAdmin among them.
    interface GlobalProps {
      mainModule: typeof import("../src/worker/index");
      durableNamespaces: "LedgerDO";
    }
  }
}
