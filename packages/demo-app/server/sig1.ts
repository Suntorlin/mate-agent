/**
 * The engine's `sig1` request signature, as a product outside this repository would write it:
 * an HMAC-SHA256 (hex) of these newline-joined fields, keyed with the engine's
 * SERVICE_AUTH_SECRET_<SERVICE>:
 *
 *   sig1, service, timestamp ms, nonce, METHOD, path, canonical query, sha256(body) hex, actor
 *
 * sent as `X-OpenInspect-Service: <service>`,
 * `X-OpenInspect-Service-Signature: sig1.<timestamp>.<nonce>.<hmac>` and
 * `X-OpenInspect-Actor: <actor>`. The test checks it against the engine's own verifier.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

/** Query parameters sorted by the UTF-8 bytes of `key\0value`, each part percent-encoded. */
function canonicalQuery(search: string): string {
  return [...new URLSearchParams(search).entries()]
    .sort((a, b) =>
      Buffer.compare(Buffer.from(`${a[0]}\0${a[1]}`), Buffer.from(`${b[0]}\0${b[1]}`))
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function sig1Headers(p: {
  service: string;
  secret: string;
  method: string;
  url: string;
  body?: string;
  actor: string;
  timestampMs?: number;
}): Record<string, string> {
  const url = new URL(p.url);
  const timestampMs = p.timestampMs ?? Date.now();
  const nonce = randomBytes(8).toString("hex");
  const canonical = [
    "sig1",
    p.service,
    String(timestampMs),
    nonce,
    p.method.toUpperCase(),
    url.pathname,
    canonicalQuery(url.search),
    createHash("sha256")
      .update(p.body ?? "")
      .digest("hex"),
    p.actor,
  ].join("\n");
  const signature = createHmac("sha256", p.secret).update(canonical).digest("hex");
  return {
    "X-OpenInspect-Service": p.service,
    "X-OpenInspect-Service-Signature": `sig1.${timestampMs}.${nonce}.${signature}`,
    "X-OpenInspect-Actor": p.actor,
  };
}
