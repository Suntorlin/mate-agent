import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DevWranglerConfig {
  triggers?: { crons?: string[] };
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: { queue: string; max_retries: number; retry_delay: number }[];
  };
}

/** The value of a JSONC file: `//` comments and trailing commas removed outside of strings. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * The dev environment's Worker config, which declares the crons and queues the Worker is deployed
 * with. Tests hold the code's job tables to it so a new job cannot ship without its trigger.
 */
export function readDevWranglerConfig(): DevWranglerConfig {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../deploy/cloudflare/wrangler.staging.jsonc"
  );
  return parseJsonc(readFileSync(path, "utf8")) as DevWranglerConfig;
}
