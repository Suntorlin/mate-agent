// Request routing for the gateway, on either host: the LLM proxy, the caller's own usage, and
// the admin API (/llm/admin/* and /admin/usage, unless ADMIN_HTTP_ENABLED turns them off).
// Errors are Anthropic-style JSON. The host hands each request its configuration, the ledger,
// a way to keep work going after the response, and where a keep-alive ping body is kept.
import { type Context, type Env as HonoEnv, Hono } from "hono";
import {
  PERIOD_KEY,
  PERIOD_MESSAGE,
  parseSettingsPatch,
  parseUserPatch,
  parseWindow,
} from "./admin";
import { type BudgetDecision, UNAVAILABLE_MESSAGE, refusalKind, refusalTag } from "./budget";
import type { GatewayConfig } from "./config";
import { type GatewayClaims, extractToken, verifyJwt } from "./jwt";
import { type Stashed, pingBody, pingsAfter } from "./keepalive";
import type { FinishedCall, LedgerClient } from "./ledger";
import { log } from "./log";
import { mapModel } from "./models";
import { requestShape } from "./shape";
import { anthropicError, anthropicHeaders, forward } from "./upstream";

/** What the host gives one request. */
export interface GatewayHost {
  config: GatewayConfig;
  ledger: LedgerClient;
  /** Keeps `promise` running after the response is sent (the Worker's waitUntil). */
  waitUntil(promise: Promise<unknown>): void;
  /** Where a silent session's ping body is kept (keepalive.ts stashPing). */
  stashPing(body: string): Promise<Stashed>;
}

const LLM_PATHS = ["/llm/v1/messages", "/llm/v1/messages/count_tokens"];
// Under /llm so the edge proxy already routes it here.
const USAGE_PATH = "/llm/usage";
/** The control plane's tokens for reading a user's own usage. */
const USAGE_SCOPE = "usage";
/** The control plane's tokens for an admin (its `sub`), good for the admin routes only. */
const ADMIN_SCOPE = "admin";
const ADMIN_PREFIX = "/llm/admin/";
/** Everyone's usage and the whole ledger. */
const ADMIN_USAGE_PATH = "/admin/usage";
const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const NO_STORE = { "cache-control": "private, no-store" };
/** Which limit refused a call (user, global or blocked), and when it starts over. */
const BUDGET_HEADER = "x-llm-budget";
const BUDGET_RESETS_HEADER = "x-llm-budget-resets-at";

class BodyTooLarge extends Error {}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function error(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(anthropicError(type, message), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The path and query, for the log. */
const pathOf = (url: URL) => `${url.pathname}${url.search}`;

async function readText(request: Request, limit: number): Promise<string> {
  const tooLarge = () => new BodyTooLarge(`request body exceeds ${limit} bytes`);
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isAdminPath = (pathname: string) =>
  pathname.startsWith(ADMIN_PREFIX) || pathname === ADMIN_USAGE_PATH;

/** The caller's verified claims, or the 401/403 to answer with. */
async function authenticate(
  request: Request,
  config: GatewayConfig
): Promise<GatewayClaims | Response> {
  const url = new URL(request.url);
  const token = extractToken(request.headers);
  const result = token
    ? await verifyJwt(token, config.secret)
    : { ok: false as const, reason: "missing gateway token" };
  if (result.ok) {
    // A scoped token is good for its scope's routes only, never for LLM calls.
    const { scope } = result.claims;
    if (
      scope === undefined ||
      (scope === USAGE_SCOPE && url.pathname === USAGE_PATH) ||
      (scope === ADMIN_SCOPE && isAdminPath(url.pathname))
    ) {
      return result.claims;
    }
    log({ path: pathOf(url), status: 403, sub: result.claims.sub, scope });
    return error(403, "permission_error", "This gateway token cannot be used here", {
      "x-should-retry": "false",
    });
  }
  log({ path: pathOf(url), status: 401, reason: result.reason });
  return error(401, "authentication_error", `Invalid gateway token: ${result.reason}`, {
    "x-should-retry": "false",
  });
}

/** The admin calling the admin routes (an admin-scoped token's subject, for `updated_by`). */
async function authenticateAdmin(
  request: Request,
  config: GatewayConfig
): Promise<string | Response> {
  const claims = await authenticate(request, config);
  if (claims instanceof Response) return claims;
  if (claims.scope !== ADMIN_SCOPE) {
    return error(403, "permission_error", "This gateway token cannot be used here");
  }
  return claims.sub;
}

/** The ledger's answer; an unreachable ledger fails closed like an unreadable key usage. */
async function checkBudget(
  host: GatewayHost,
  sub: string,
  session: { sid: string; model: string } | undefined
): Promise<BudgetDecision> {
  try {
    return await host.ledger.check(sub, session);
  } catch (caught) {
    log({ sub, status: 503, error: `ledger check failed: ${caught}` });
    return { allowed: false, status: 503, scope: "global", message: UNAVAILABLE_MESSAGE };
  }
}

/**
 * A refused call. A spent budget or a paused account says so in a tag at the end of its message,
 * the one part of the refusal that reaches the agent runtime (see refusalTag), and in headers.
 */
function refusal(decision: Extract<BudgetDecision, { allowed: false }>): Response {
  const type =
    decision.status === 429
      ? "rate_limit_error"
      : decision.status === 403
        ? "permission_error"
        : "api_error";
  const kind = refusalKind(decision);
  const tag = refusalTag(decision);
  return error(decision.status, type, tag ? `${decision.message} ${tag}` : decision.message, {
    "x-should-retry": decision.status === 503 ? "true" : "false",
    ...(kind ? { [BUDGET_HEADER]: kind } : {}),
    ...(kind && decision.resetsAt ? { [BUDGET_RESETS_HEADER]: decision.resetsAt } : {}),
  });
}

async function handleLlm(
  request: Request,
  host: GatewayHost,
  claims: GatewayClaims
): Promise<Response> {
  const { config } = host;
  const started = Date.now();
  const url = new URL(request.url);
  const isMessages = url.pathname === "/llm/v1/messages";
  const entry = { sid: claims.sid, sub: claims.sub, path: url.pathname };
  const parsed = parseJsonObject(await readText(request, config.maxParsedBodyBytes));
  if (!parsed) {
    log({ ...entry, status: 400 });
    return error(400, "invalid_request_error", "Request body must be a JSON object");
  }
  const model = mapModel(parsed.model, config.modelMap, config.forceDefaultModel);
  if (isMessages) {
    // An allowed call also tells the keep-alive the session is talking again.
    const session = config.keepAlive ? { sid: claims.sid, model } : undefined;
    const decision = await checkBudget(host, claims.sub, session);
    if (!decision.allowed) {
      log({ ...entry, status: decision.status, budget: decision.scope });
      return refusal(decision);
    }
  }
  const upstreamUrl = new URL(`${config.upstreamBase}${url.pathname.slice(4)}${url.search}`);
  const sent = { ...parsed, model };
  const forwarding = forward({
    url: upstreamUrl,
    body: JSON.stringify(sent),
    incoming: request.headers,
    apiKey: config.apiKey,
  });
  // Taken while the upstream thinks, so the parsed conversation is not held for the whole stream:
  // what the log line needs, and the ping that may keep the session's cache alive afterwards.
  const requested = parsed.model;
  const stream = parsed.stream === true;
  const shape = isMessages ? requestShape(parsed) : undefined;
  const ping = isMessages && config.keepAlive ? pingBody(sent) : undefined;
  const { response, done } = await forwarding;

  // Registered now, while the request is live: it runs once the body is through or cut off.
  host.waitUntil(
    done.then(async (result) => {
      const ms = Date.now() - started;
      // A response cut off before its end has no cost yet: it is recorded as pending under its
      // generation id and settled by the backfill, instead of counting as $0.
      const pending =
        isMessages &&
        result.status === 200 &&
        typeof result.usage?.cost !== "number" &&
        result.generationId !== undefined;
      // The session goes silent now: for a tool the agent is running, or until the user answers.
      const silentFor = pingsAfter(
        result.stopReason,
        (result.usage?.cache_read_input_tokens ?? 0) +
          (result.usage?.cache_creation_input_tokens ?? 0),
        config.keepAlive
      );
      let keepAlive: FinishedCall["keepAlive"];
      if (ping !== undefined && result.status === 200 && !result.aborted && silentFor > 0) {
        const stashed = await host.stashPing(ping);
        if ("skipped" in stashed) {
          log({
            ...entry,
            model,
            keepalive: "skipped",
            reason: stashed.skipped,
            bytes: stashed.bytes,
          });
        } else {
          const headers = anthropicHeaders(request.headers);
          keepAlive = { ...stashed, url: upstreamUrl.toString(), headers, pings: silentFor };
        }
      }
      const call: FinishedCall = {
        sid: claims.sid,
        sub: claims.sub,
        ...(claims.app ? { app: claims.app } : {}),
        model,
        ...(isMessages && (result.usage || pending) ? { usage: result.usage ?? {} } : {}),
        ...(result.generationId ? { generationId: result.generationId } : {}),
        ...(keepAlive ? { keepAlive } : {}),
      };
      if (call.usage || call.keepAlive) {
        try {
          await host.ledger.record(call);
        } catch (caught) {
          // Enough to settle the call by hand.
          const lost = { model, usage: call.usage, generationId: call.generationId };
          log({ ...entry, status: 500, error: `ledger record failed: ${caught}`, lost });
        }
      }
      log({
        ...entry,
        requested,
        model,
        stream,
        status: result.status,
        ms,
        bytes: result.bytes,
        cost: result.usage?.cost ?? null,
        ...(shape ? { shape } : {}),
        ...(pending ? { pending: true, generation: result.generationId } : {}),
        ...(result.aborted ? { aborted: true } : {}),
      });
    })
  );
  return response;
}

/**
 * GET overview[?period=], GET users/:sub, PATCH users/:sub {budget_usd?, blocked?},
 * GET sessions/:sid[?since=&until=] (what the session's calls that finished in the window
 * cost, for the control plane's turn costs), GET/PATCH settings {monthly_budget_usd?,
 * user_budget_usd?, key_budget_usd?} (null restores the deployment's).
 */
async function handleAdminApi(
  request: Request,
  ledger: LedgerClient,
  by: string
): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const rest = url.pathname.slice(ADMIN_PREFIX.length);
  const period = url.searchParams.get("period") ?? undefined;
  if (period !== undefined && !PERIOD_KEY.test(period)) {
    return error(400, "invalid_request_error", PERIOD_MESSAGE);
  }
  const notAllowed = () =>
    error(405, "invalid_request_error", `${method} not allowed`, { allow: "GET, PATCH" });
  const body = async () => parseJsonObject(await readText(request, MAX_ADMIN_BODY_BYTES));
  if (rest === "overview") {
    if (method !== "GET") return error(405, "invalid_request_error", `${method} not allowed`);
    return json(200, await ledger.overview(period), NO_STORE);
  }
  if (rest === "settings") {
    if (method === "GET") return json(200, await ledger.settings(), NO_STORE);
    if (method !== "PATCH") return notAllowed();
    const parsed = parseSettingsPatch(await body());
    if ("error" in parsed) return error(400, "invalid_request_error", parsed.error);
    const settings = await ledger.setSettings(parsed.patch, by);
    log({ path: url.pathname, status: 200, admin: by, ...parsed.patch });
    return json(200, settings, NO_STORE);
  }
  const sessionMatch = /^sessions\/([^/]+)$/.exec(rest);
  if (sessionMatch) {
    if (method !== "GET") return error(405, "invalid_request_error", `${method} not allowed`);
    const window = parseWindow(
      url.searchParams.get("since"),
      url.searchParams.get("until"),
      Date.now()
    );
    if ("error" in window) return error(400, "invalid_request_error", window.error);
    const sid = decodeURIComponent(sessionMatch[1]);
    return json(200, await ledger.session(sid, window.since, window.until), NO_STORE);
  }
  const match = /^users\/([^/]+)$/.exec(rest);
  if (!match) return error(404, "not_found_error", `No route for ${url.pathname}`);
  const sub = decodeURIComponent(match[1]);
  if (method === "GET") return json(200, await ledger.user(sub, period), NO_STORE);
  if (method !== "PATCH") return notAllowed();
  const parsed = parseUserPatch(await body());
  if ("error" in parsed) return error(400, "invalid_request_error", parsed.error);
  const user = await ledger.setUser(sub, parsed.patch, by, period);
  log({ path: url.pathname, status: 200, admin: by, target: sub, ...parsed.patch });
  return json(200, user, NO_STORE);
}

const notFound = (request: Request) =>
  error(404, "not_found_error", `No route for ${request.method} ${new URL(request.url).pathname}`);

export function createApp<E extends HonoEnv>(hostOf: (c: Context<E>) => GatewayHost) {
  // Routes match the path as sent, the one the handlers read: Hono's default decodes it first,
  // so /llm/v1/%6Dessages would reach the Messages handler as something other than a Messages
  // call, with no budget check and nothing recorded.
  const app = new Hono<E>({ getPath: (request) => new URL(request.url).pathname });

  app.all("/healthz", (c) => {
    void hostOf(c).config; // a misconfigured gateway is not healthy
    return json(200, { ok: true });
  });

  // Claude Code's best-effort connection warm-up probe.
  app.all("/llm/api/hello", () => new Response(null, { status: 200 }));

  app.all(USAGE_PATH, async (c) => {
    const { method } = c.req.raw;
    if (method !== "GET") {
      return error(405, "invalid_request_error", `${method} not allowed`, { allow: "GET" });
    }
    const host = hostOf(c);
    const claims = await authenticate(c.req.raw, host.config);
    if (claims instanceof Response) return claims;
    // The token's subject is the only user whose usage a caller can see.
    return json(200, await host.ledger.usage(claims.sub), NO_STORE);
  });

  app.all(`${ADMIN_PREFIX}*`, async (c) => {
    const host = hostOf(c);
    if (!host.config.adminHttp) return notFound(c.req.raw);
    const by = await authenticateAdmin(c.req.raw, host.config);
    if (by instanceof Response) return by;
    return handleAdminApi(c.req.raw, host.ledger, by);
  });

  app.all(ADMIN_USAGE_PATH, async (c) => {
    const host = hostOf(c);
    if (!host.config.adminHttp || c.req.raw.method !== "GET") return notFound(c.req.raw);
    const by = await authenticateAdmin(c.req.raw, host.config);
    if (by instanceof Response) return by;
    return json(200, await host.ledger.snapshot());
  });

  for (const path of LLM_PATHS) {
    app.all(path, async (c) => {
      const { method } = c.req.raw;
      if (method !== "POST") {
        return error(405, "invalid_request_error", `${method} not allowed on ${path}`, {
          allow: "POST",
        });
      }
      const host = hostOf(c);
      const claims = await authenticate(c.req.raw, host.config);
      if (claims instanceof Response) return claims;
      return handleLlm(c.req.raw, host, claims);
    });
  }

  app.notFound((c) => notFound(c.req.raw));

  app.onError((caught, c) => {
    const tooLarge = caught instanceof BodyTooLarge;
    log({ path: pathOf(new URL(c.req.url)), status: tooLarge ? 413 : 500, error: String(caught) });
    return tooLarge
      ? error(413, "request_too_large", caught.message)
      : error(500, "api_error", "Gateway internal error");
  });

  return app;
}
