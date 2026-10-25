import { expect, test } from "vitest";
import { extractToken, verifyJwt } from "../../src/core/jwt";
import { SECRET, freshClaims, signJwt } from "../helpers";

const base64Url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("accepts a valid token and returns its claims", async () => {
  const result = await verifyJwt(await signJwt(freshClaims()), SECRET);
  expect(result.ok).toBe(true);
  expect(result.ok && result.claims.sub).toBe("user-1");
  expect(result.ok && result.claims.sid).toBe("session-1");
});

test("rejects an expired token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const result = await verifyJwt(await signJwt(freshClaims({ exp: now - 1 })), SECRET, now);
  expect(result).toEqual({ ok: false, reason: "token expired" });
});

test("rejects a token signed with another secret", async () => {
  const result = await verifyJwt(await signJwt(freshClaims(), "other-secret"), SECRET);
  expect(result).toEqual({ ok: false, reason: "invalid token signature" });
});

test("rejects a tampered payload", async () => {
  const [head, , sig] = (await signJwt(freshClaims())).split(".");
  const forged = base64Url(JSON.stringify(freshClaims({ sub: "admin" })));
  expect((await verifyJwt(`${head}.${forged}.${sig}`, SECRET)).ok).toBe(false);
});

test("rejects alg none and other algorithms", async () => {
  const [, payload] = (await signJwt(freshClaims())).split(".");
  const none = `${base64Url('{"alg":"none"}')}.${payload}.`;
  expect((await verifyJwt(none, SECRET)).ok).toBe(false);
  expect(await verifyJwt(await signJwt(freshClaims(), SECRET, "HS512"), SECRET)).toEqual({
    ok: false,
    reason: "unsupported token algorithm",
  });
});

test("rejects tokens missing sub or sid, and malformed tokens", async () => {
  expect((await verifyJwt(await signJwt(freshClaims({ sub: "" })), SECRET)).ok).toBe(false);
  expect((await verifyJwt(await signJwt(freshClaims({ sid: undefined })), SECRET)).ok).toBe(false);
  expect(await verifyJwt("not-a-jwt", SECRET)).toEqual({ ok: false, reason: "malformed token" });
});

test("extracts the token from x-api-key first, then a bearer header", () => {
  expect(extractToken(new Headers({ "x-api-key": "a", authorization: "Bearer b" }))).toBe("a");
  expect(extractToken(new Headers({ authorization: "Bearer b" }))).toBe("b");
  expect(extractToken(new Headers({ authorization: "Basic b" }))).toBeNull();
  expect(extractToken(new Headers())).toBeNull();
});

test("passes an optional string scope through and rejects any other scope value", async () => {
  const scoped = await verifyJwt(await signJwt(freshClaims({ scope: "usage" })), SECRET);
  expect(scoped.ok && scoped.claims.scope).toBe("usage");
  const plain = await verifyJwt(await signJwt(freshClaims()), SECRET);
  expect(plain.ok && "scope" in plain.claims).toBe(false);
  expect(await verifyJwt(await signJwt(freshClaims({ scope: 1 })), SECRET)).toEqual({
    ok: false,
    reason: "token scope must be a string",
  });
});

test("passes the product's user id (app) through, and rejects an empty or non-string one", async () => {
  const owned = await verifyJwt(await signJwt(freshClaims({ app: "acme-uid-1" })), SECRET);
  expect(owned.ok && owned.claims.app).toBe("acme-uid-1");
  const plain = await verifyJwt(await signJwt(freshClaims()), SECRET);
  expect(plain.ok && "app" in plain.claims).toBe(false);
  for (const app of ["", 7]) {
    expect(await verifyJwt(await signJwt(freshClaims({ app })), SECRET)).toEqual({
      ok: false,
      reason: "token app must be a non-empty string",
    });
  }
});
