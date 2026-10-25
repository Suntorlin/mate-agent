// HS256 JWT verification for tokens the control plane mints for sandboxes.
// Contract: signed with GATEWAY_SECRET (its UTF-8 bytes), claims {sub, sid, iat, exp} and an
// optional `scope` and `app`. Sandbox tokens carry no scope; the control plane's short-lived
// `scope: "usage"` tokens may only read the signed-in user's own usage, its `scope: "admin"`
// tokens only reach the admin routes. `app` is the product's own id for the user, on the tokens
// of a session a product's user owns; their calls are reported to the product. WebCrypto checks
// the signature (in constant time).

export interface GatewayClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  scope?: string;
  app?: string;
}

export type VerifyResult = { ok: true; claims: GatewayClaims } | { ok: false; reason: string };

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(secret, key);
  }
  return key;
}

function base64UrlBytes(segment: string): Uint8Array | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function verifyJwt(
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) {
    return { ok: false, reason: "malformed token" };
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeSegment(headerPart);
  if (!header || header.alg !== "HS256")
    return { ok: false, reason: "unsupported token algorithm" };

  const signature = base64UrlBytes(signaturePart);
  const valid =
    signature !== null &&
    (await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signature,
      encoder.encode(`${headerPart}.${payloadPart}`)
    ));
  if (!valid) return { ok: false, reason: "invalid token signature" };

  const claims = decodeSegment(payloadPart);
  const { sub, sid, iat, exp, scope, app } = claims ?? {};
  if (
    typeof sub !== "string" ||
    sub === "" ||
    typeof sid !== "string" ||
    sid === "" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    return { ok: false, reason: "token is missing sub, sid, iat or exp" };
  }
  if (scope !== undefined && typeof scope !== "string") {
    return { ok: false, reason: "token scope must be a string" };
  }
  if (app !== undefined && (typeof app !== "string" || app === "")) {
    return { ok: false, reason: "token app must be a non-empty string" };
  }
  if (exp <= nowSec) return { ok: false, reason: "token expired" };
  return {
    ok: true,
    claims: {
      sub,
      sid,
      iat,
      exp,
      ...(scope === undefined ? {} : { scope }),
      ...(app === undefined ? {} : { app }),
    },
  };
}

/** Claude Code sends ANTHROPIC_API_KEY as x-api-key; other clients use a bearer token. */
export function extractToken(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey;
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
  return match ? match[1] : null;
}
