// Per-user overrides and the admin API: over HTTP for the control plane (admin-scoped tokens),
// and over RPC through the GatewayAdmin entrypoint.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayAdmin } from "../../src/worker/admin-rpc";
import type { Env } from "../../src/worker/env";
import {
  type SeenRequest,
  UPSTREAM,
  callWorker,
  captureLogs,
  fakeFetch,
  freshClaims,
  keyUsage,
  signJwt,
  token,
} from "../helpers";

let seen: SeenRequest[] = [];

beforeEach(() => {
  seen = fakeFetch((request) =>
    request.url === `${UPSTREAM}/v1/key`
      ? keyUsage(10)
      : Response.json({ usage: { input_tokens: 1, output_tokens: 1, cost: 0.01 } })
  );
  captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PERIOD = new Date().toISOString().slice(0, 7);
const upstreamCalls = () => seen.filter((request) => request.url.includes("/v1/messages"));
const adminToken = () => token({ sub: "admin-1", sid: "control-plane-admin", scope: "admin" });

async function admin(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const { response } = await callWorker(
    `/llm/admin/${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        "content-type": "application/json",
      },
    },
    overrides
  );
  return response;
}

const adminHeaders = async () => ({ authorization: `Bearer ${await adminToken()}` });

async function callModel(sub: string, sid: string) {
  const { response, settled } = await callWorker("/llm/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await token({ sub, sid }), "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
  });
  await response.text();
  await settled();
  return response;
}

test("only admin-scoped tokens reach the admin API, and they cannot call the model", async () => {
  for (const claims of [
    { sub: "u1", sid: "s1" },
    { sub: "u1", sid: "x", scope: "usage" },
  ]) {
    const { response } = await callWorker("/llm/admin/overview", {
      headers: { authorization: `Bearer ${await token(claims)}` },
    });
    expect(response.status).toBe(403);
    expect((await response.json<any>()).error.type).toBe("permission_error");
  }
  const { response } = await callWorker("/llm/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await adminToken(), "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(upstreamCalls()).toHaveLength(0);
});

test("overview lists users with spend, budget and the service-wide figures", async () => {
  expect((await callModel("u1", "s1")).status).toBe(200);
  expect((await callModel("u1", "s2")).status).toBe(200);
  expect((await callModel("u2", "s3")).status).toBe(200);
  const response = await admin("overview");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const overview = await response.json<any>();
  expect(overview.period).toBe(PERIOD);
  expect(overview.periods).toEqual([PERIOD]);
  expect(overview.default_user_budget_usd).toBe(5);
  expect(overview.global.budget_usd).toBe(25);
  expect(overview.global.spent_usd).toBe(0);
  expect(overview.pending_requests).toBe(0);
  expect(
    overview.users.map((user: { sub: string; requests: number }) => [user.sub, user.requests])
  ).toEqual([
    ["u1", 2],
    ["u2", 1],
  ]);
  expect(overview.users[0].remaining_usd).toBe(4.98);
  expect(Date.now() - Date.parse(overview.users[0].last_at)).toBeLessThan(60_000);
  const detail = await (await admin("users/u1")).json<any>();
  expect(detail.sessions.map((session: { sid: string }) => session.sid).sort()).toEqual([
    "s1",
    "s2",
  ]);
  expect(detail.all_time.requests).toBe(2);
});

test("a session's spend over a window: the control plane's turn cost", async () => {
  expect((await callModel("u-win", "s-win")).status).toBe(200);
  expect((await callModel("u-win", "s-win")).status).toBe(200);
  expect((await callModel("u-win", "s-other")).status).toBe(200);

  const response = await admin("sessions/s-win");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const session = await response.json<any>();
  expect(session).toMatchObject({
    sid: "s-win",
    requests: 2,
    unsettled: 0,
    input_tokens: 2,
    output_tokens: 2,
    total: { sub: "u-win", requests: 2 },
  });
  expect(session.usd).toBeCloseTo(0.02);
  expect(session.until).toBeGreaterThan(session.since);

  const later = Date.now() + 60_000;
  const empty = await (
    await admin(`sessions/s-win?since=${later}&until=${later + 1000}`)
  ).json<any>();
  expect(empty).toMatchObject({ sid: "s-win", usd: 0, requests: 0 });
  expect(empty.total.requests, "the session's total does not depend on the window").toBe(2);
  expect(await (await admin("sessions/never-seen")).json<any>()).toMatchObject({
    requests: 0,
    total: null,
  });

  for (const query of ["since=abc", "until=-1", "since=10&until=5", "since=1.5"]) {
    const bad = await admin(`sessions/s-win?${query}`);
    expect(bad.status, query).toBe(400);
    expect((await bad.json<any>()).error.message).toMatch(/whole milliseconds/);
  }
  expect((await admin("sessions/s-win", { method: "PATCH", body: "{}" })).status).toBe(405);

  // An admin token reads it; a session token does not.
  const { response: viaPlatform } = await callWorker("/llm/admin/sessions/s-win", {
    headers: await adminHeaders(),
  });
  expect(viaPlatform.status).toBe(200);
  const { response: forbidden } = await callWorker("/llm/admin/sessions/s-win", {
    headers: { authorization: `Bearer ${await token({ sub: "u-win", sid: "s-win" })}` },
  });
  expect(forbidden.status).toBe(403);
});

test("an admin's budget override and block take effect on the next call", async () => {
  let response = await admin("users/u2", {
    method: "PATCH",
    body: JSON.stringify({ budget_usd: 0.005 }),
  });
  expect(response.status).toBe(200);
  const updated = await response.json<any>();
  expect(updated.budget_usd).toBe(0.005);
  expect(updated.custom_budget).toBe(true);
  expect(updated.limit.updated_by).toBe("admin-1");
  expect(updated.sessions, "a PATCH answers without the sessions").toBeUndefined();
  expect((await callModel("u2", "s3")).status, "over the lowered budget").toBe(429);

  response = await admin("users/u2", {
    method: "PATCH",
    body: JSON.stringify({ budget_usd: null }),
  });
  expect((await response.json<any>()).budget_usd, "null restores the default").toBe(5);
  expect((await callModel("u2", "s3")).status).toBe(200);

  await admin("users/u2", { method: "PATCH", body: JSON.stringify({ blocked: true }) });
  const before = upstreamCalls().length;
  response = await callModel("u2", "s3");
  expect(response.status).toBe(403);
  expect(response.headers.get("x-should-retry")).toBe("false");
  const { response: blocked } = await callWorker("/llm/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await token({ sub: "u2", sid: "s3" }) },
    body: "{}",
  });
  expect(await blocked.json<any>()).toEqual({
    type: "error",
    error: {
      type: "permission_error",
      message: "AI usage is paused for this account. Please contact support. [llm_budget=blocked]",
    },
  });
  expect(upstreamCalls().length, "a blocked user never reaches the upstream").toBe(before);

  await admin("users/u2", { method: "PATCH", body: JSON.stringify({ blocked: false }) });
  expect((await callModel("u2", "s3")).status).toBe(200);
});

test("a user named with escaped characters is addressed by the decoded name", async () => {
  const response = await admin("users/org%3Auser%40example.com", {
    method: "PATCH",
    body: JSON.stringify({ budget_usd: 2 }),
  });
  expect(response.status).toBe(200);
  expect(await response.json<any>()).toMatchObject({ sub: "org:user@example.com", budget_usd: 2 });
  // An escaped route name is no route, as with the Node gateway.
  expect((await admin("%6Fverview")).status).toBe(404);
  await admin("users/org%3Auser%40example.com", {
    method: "PATCH",
    body: JSON.stringify({ budget_usd: null }),
  });
});

test("rejects bad admin input", async () => {
  for (const body of [{}, { budget_usd: -1 }, { budget_usd: "5" }, { blocked: "yes" }]) {
    const response = await admin("users/u1", { method: "PATCH", body: JSON.stringify(body) });
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect((await admin("overview?period=oct")).status).toBe(400);
  expect((await admin("nope")).status).toBe(404);
  const put = await admin("users/u1", { method: "PUT", body: "{}" });
  expect(put.status).toBe(405);
  expect(put.headers.get("allow")).toBe("GET, PATCH");
  expect((await admin("overview", { method: "POST", body: "{}" })).status).toBe(405);
  const huge = await admin("settings", {
    method: "PATCH",
    body: JSON.stringify({ monthly_budget_usd: 1, pad: "x".repeat(20_000) }),
  });
  expect(huge.status).toBe(413);
});

test("an admin token reads and sets budgets, and nothing else", async () => {
  const headers = { ...(await adminHeaders()), "content-type": "application/json" };
  const patched = await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ monthly_budget_usd: 25 }),
  });
  expect(patched.response.status).toBe(200);
  const body = await patched.response.json<any>();
  expect(body.monthly_budget_usd).toBe(25);
  expect(body.updated_by).toBe("admin-1");
  const keyPatched = await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ key_budget_usd: 2000 }),
  });
  expect(keyPatched.response.status).toBe(200);
  const keyBody = await keyPatched.response.json<any>();
  expect(keyBody.key_budget_usd).toBe(2000);
  expect(keyBody.deployment_key_budget_usd).toBe(25);
  expect(keyBody.key_spent_usd).toBe(0);
  expect((await callWorker("/llm/admin/overview", { headers })).response.status).toBe(200);
  const settings = await (
    await callWorker("/llm/admin/settings", { headers })
  ).response.json<any>();
  expect(settings).toMatchObject({ monthly_budget_usd: 25, key_budget_usd: 2000 });

  const bad = await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ monthly_budget_usd: -1 }),
  });
  expect(bad.response.status).toBe(400);
  const forged = await signJwt(
    freshClaims({ sub: "admin-1", scope: "admin" }),
    "not-the-gateway-secret"
  );
  const wrong = await callWorker("/llm/admin/settings", {
    headers: { ...headers, authorization: `Bearer ${forged}` },
  });
  expect(wrong.response.status).toBe(401);
  // A bearer that is not a signed token (the old platform bearer) is refused.
  const plain = await callWorker("/llm/admin/settings", {
    headers: { ...headers, authorization: "Bearer platform-admin-token-0123456789" },
  });
  expect(plain.response.status).toBe(401);
  // The admin token is not a model-call credential.
  const llm = await callWorker("/llm/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
  });
  expect(llm.response.status).toBe(403);

  await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ monthly_budget_usd: null, key_budget_usd: null }),
  });
});

test("a monthly budget an admin sets stops everyone once the month's spend reaches it", async () => {
  const headers = { ...(await adminHeaders()), "content-type": "application/json" };
  const spent = (await (await callWorker("/llm/admin/settings", { headers })).response.json<any>())
    .month_spent_usd;
  await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ monthly_budget_usd: spent }),
  });
  const { response } = await callWorker("/llm/v1/messages", {
    method: "POST",
    headers: { "x-api-key": await token({ sub: "fresh-user", sid: "s9" }) },
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  expect((await response.json<any>()).error).toEqual({
    type: "rate_limit_error",
    message: `AI usage is paused for everyone because the service-wide limit has been reached. Please try again later. [llm_budget=global resets_at=${nextMonth.toISOString()}]`,
  });
  expect(response.headers.get("x-llm-budget")).toBe("global");
  expect(response.headers.get("x-llm-budget-resets-at")).toBe(nextMonth.toISOString());
  const settings = await (
    await callWorker("/llm/admin/settings", { headers })
  ).response.json<any>();
  expect(settings.alerts_sent, "both thresholds crossed at once").toEqual([0.8, 1]);
  await callWorker("/llm/admin/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ monthly_budget_usd: null }),
  });
});

test("/admin/usage is the whole ledger, for admins only", async () => {
  expect((await callWorker("/admin/usage")).response.status).toBe(401);
  const sandbox = await token({ sub: "u1", sid: "s1" });
  expect(
    (await callWorker("/admin/usage", { headers: { authorization: `Bearer ${sandbox}` } })).response
      .status
  ).toBe(403);
  const usage = await (
    await callWorker("/admin/usage", { headers: { authorization: `Bearer ${await adminToken()}` } })
  ).response.json<any>();
  expect(usage).toMatchObject({ budget_usd: 25, user_budget_usd: 5, baseline_usd: 10 });
  expect(usage.ledger.by_user.u1.requests).toBe(2);
  const viaBearer = await callWorker("/admin/usage", { headers: await adminHeaders() });
  expect(viaBearer.response.status).toBe(200);
  expect(
    (await callWorker("/admin/usage", { method: "POST", headers: await adminHeaders() })).response
      .status
  ).toBe(404);
});

test("ADMIN_HTTP_ENABLED=false takes the admin routes off HTTP, and nothing else", async () => {
  const off = { ADMIN_HTTP_ENABLED: "false" } as Partial<Env>;
  expect((await admin("overview", {}, off)).status).toBe(404);
  expect(
    (await callWorker("/admin/usage", { headers: await adminHeaders() }, off)).response.status
  ).toBe(404);
  const usage = await callWorker(
    "/llm/usage",
    { headers: { authorization: `Bearer ${await token({ sub: "u1", scope: "usage" })}` } },
    off
  );
  expect(usage.response.status).toBe(200);
});

test("GatewayAdmin answers over RPC as the HTTP routes do", async () => {
  const rpc = exports.GatewayAdmin;
  const overview = await rpc.overview();
  const http = await (await admin("overview")).json<any>();
  expect(overview.users).toEqual(http.users);
  expect(overview.period).toBe(PERIOD);
  const user = await rpc.user("u1");
  expect(user.sessions.map((session) => session.sid).sort()).toEqual(["s1", "s2"]);
  const httpSession = await (await admin("sessions/s-win")).json<any>();
  const rpcSession = await rpc.session("s-win", httpSession.since, httpSession.until);
  expect(rpcSession).toEqual(httpSession);

  const updated = await rpc.setUser("u1", { budget_usd: 1 }, "rpc-admin");
  expect(updated).toMatchObject({ sub: "u1", budget_usd: 1, custom_budget: true });
  expect(updated.limit?.updated_by).toBe("rpc-admin");
  const settings = await rpc.setSettings({ user_budget_usd: 7 }, "rpc-admin");
  expect(settings).toMatchObject({ user_budget_usd: 7, updated_by: "rpc-admin" });
  expect(await rpc.settings()).toEqual(settings);
  expect((await rpc.usage()).ledger.by_user.u1.requests).toBe(2);

  // Bad input throws with the HTTP route's message (called directly: the test pool's RPC proxy
  // reports a rejected call as uncaught as well).
  const direct = new GatewayAdmin(createExecutionContext(), env);
  const failure = async (call: () => unknown) => {
    try {
      await call();
      return "resolved";
    } catch (caught) {
      return (caught as Error).message;
    }
  };
  expect(await failure(() => direct.setUser("u1", { budget_usd: -1 }, "rpc-admin"))).toBe(
    "budget_usd must be null or >= 0"
  );
  expect(await failure(() => direct.setSettings({}, "rpc-admin"))).toBe(
    "Send monthly_budget_usd, user_budget_usd and/or key_budget_usd"
  );
  expect(await failure(() => direct.overview("oct"))).toBe("period must look like 2026-10");
  expect(await failure(() => direct.session("s1", 10, 5))).toMatch(/whole milliseconds/);
  expect(await failure(() => direct.setUser("u1", { blocked: true }, " "))).toBe(
    "by must name the admin"
  );

  await rpc.setUser("u1", { budget_usd: null }, "rpc-admin");
  await rpc.setSettings({ user_budget_usd: null }, "rpc-admin");
  // Still served over RPC with the HTTP routes off.
  expect((await rpc.user("u1")).budget_usd).toBe(5);
});
