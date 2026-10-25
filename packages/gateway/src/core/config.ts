// The gateway's configuration: the same variable names, defaults and checks on both hosts (the
// Worker's vars and secrets, the Node host's environment). A bad value is a ConfigError naming
// it: the Worker answers every request with a 500 and a log line, the Node host refuses to start.
import { BUDGET_PERIODS, type BudgetPeriod } from "./budget";
import { type ModelMap, parseModelMap } from "./models";

/** Request bodies up to this size are read and parsed (the model is mapped, the shape logged). */
export const DEFAULT_MAX_PARSED_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPSTREAM_BASE = "https://openrouter.ai/api";

/** The variables, as the Worker's bindings or the Node host's environment hold them. */
export interface GatewayVars {
  // Secrets
  /** Signs the sandbox, usage and admin tokens (HS256). */
  GATEWAY_SECRET?: string;
  /** The one upstream key. */
  OPENROUTER_API_KEY?: string;
  /** The gateway's bearer at LLM_USAGE_REPORT_URL. */
  LLM_USAGE_REPORT_TOKEN?: string;
  // Vars (wrangler may hand non-string JSON values through as they are)
  LLM_BUDGET_USD?: string | number;
  LLM_USER_BUDGET_USD?: string | number;
  LLM_USER_BUDGET_PERIOD?: string;
  LLM_MONTHLY_BUDGET_USD?: string | number;
  LLM_ALERT_WEBHOOK_URL?: string;
  /** Where each settled call of a product's user is POSTed (core/usage-reports.ts). */
  LLM_USAGE_REPORT_URL?: string;
  LLM_MODEL_MAP?: string;
  LLM_FORCE_DEFAULT_MODEL?: string | boolean;
  CACHE_KEEPALIVE?: string | boolean;
  CACHE_KEEPALIVE_TOOL_PINGS?: string | number;
  CACHE_KEEPALIVE_IDLE_PINGS?: string | number;
  OPENROUTER_BASE_URL?: string;
  ADMIN_HTTP_ENABLED?: string | boolean;
  MAX_PARSED_BODY_BYTES?: string | number;
}

export interface GatewayConfig {
  secret: string;
  apiKey: string;
  upstreamBase: string;
  modelMap: ModelMap;
  forceDefaultModel: boolean;
  budgetUsd: number;
  userBudgetUsd: number;
  monthlyBudgetUsd: number | null;
  userBudgetPeriod: BudgetPeriod;
  /** Monthly-budget alerts go to a Lark (Feishu) custom bot webhook when one is set. */
  alertWebhook?: string;
  /** Each settled call of a product's user is reported here; absent when off. */
  usageReport?: { url: string; token: string };
  /** Renew a session's prompt cache while it is silent (CACHE_KEEPALIVE); absent when off. */
  keepAlive?: { toolPings?: number; idlePings?: number };
  /** Whether /llm/admin/* and /admin/usage are served over HTTP. */
  adminHttp: boolean;
  maxParsedBodyBytes: number;
}

export class ConfigError extends Error {}

const text = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value).trim();

const on = (value: unknown): boolean => /^(1|true|yes)$/i.test(text(value) ?? "");

function amount(name: string, value: unknown, fallback: string): number {
  const parsed = Number(text(value) || fallback);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new ConfigError(`${name} must be a number >= 0`);
  return parsed;
}

function count(name: string, value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${name} must be an integer >= 0`);
  }
  return parsed;
}

// Trimmed like the control plane does, so both sides sign with the same bytes.
function required(name: string, value: unknown): string {
  const raw = text(value);
  if (!raw) throw new ConfigError(`${name} is not set`);
  return raw;
}

/** Both usage report variables, or neither: a URL without its bearer would only collect 401s. */
function parseUsageReport(env: GatewayVars): { url: string; token: string } | undefined {
  const url = text(env.LLM_USAGE_REPORT_URL);
  const token = text(env.LLM_USAGE_REPORT_TOKEN);
  if (!url && !token) return undefined;
  if (!url || !token) {
    throw new ConfigError("LLM_USAGE_REPORT_URL and LLM_USAGE_REPORT_TOKEN are set together");
  }
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new ConfigError("LLM_USAGE_REPORT_URL must be an http(s) URL");
  }
  return { url, token };
}

export function parseConfig(
  env: GatewayVars,
  defaults: { maxParsedBodyBytes?: number } = {}
): GatewayConfig {
  const monthlyRaw = text(env.LLM_MONTHLY_BUDGET_USD);
  const monthlyBudgetUsd = monthlyRaw ? Number(monthlyRaw) : null;
  if (monthlyBudgetUsd !== null && (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0)) {
    throw new ConfigError("LLM_MONTHLY_BUDGET_USD must be a number >= 0");
  }
  const userBudgetPeriod = (text(env.LLM_USER_BUDGET_PERIOD) || "month") as BudgetPeriod;
  if (!BUDGET_PERIODS.includes(userBudgetPeriod)) {
    throw new ConfigError(`LLM_USER_BUDGET_PERIOD must be one of ${BUDGET_PERIODS.join(", ")}`);
  }
  let modelMap: ModelMap;
  try {
    modelMap = parseModelMap(text(env.LLM_MODEL_MAP));
  } catch (error) {
    throw new ConfigError(`LLM_MODEL_MAP: ${(error as Error).message}`);
  }
  const maxParsedBodyBytes = count("MAX_PARSED_BODY_BYTES", env.MAX_PARSED_BODY_BYTES);
  if (maxParsedBodyBytes === 0) throw new ConfigError("MAX_PARSED_BODY_BYTES must be > 0");
  const alertWebhook = text(env.LLM_ALERT_WEBHOOK_URL);
  const usageReport = parseUsageReport(env);
  return {
    secret: required("GATEWAY_SECRET", env.GATEWAY_SECRET),
    apiKey: required("OPENROUTER_API_KEY", env.OPENROUTER_API_KEY),
    upstreamBase: (text(env.OPENROUTER_BASE_URL) || DEFAULT_UPSTREAM_BASE).replace(/\/$/, ""),
    modelMap,
    forceDefaultModel: on(env.LLM_FORCE_DEFAULT_MODEL),
    budgetUsd: amount("LLM_BUDGET_USD", env.LLM_BUDGET_USD, "25"),
    userBudgetUsd: amount("LLM_USER_BUDGET_USD", env.LLM_USER_BUDGET_USD, "20"),
    monthlyBudgetUsd,
    userBudgetPeriod,
    ...(alertWebhook ? { alertWebhook } : {}),
    ...(usageReport ? { usageReport } : {}),
    // Off unless switched on. How many pings (one every 4.5 minutes) a silent session gets:
    // while its agent runs a tool, and after its turn ended; unset keeps the built-in 13 and 3.
    ...(on(env.CACHE_KEEPALIVE)
      ? {
          keepAlive: {
            toolPings: count("CACHE_KEEPALIVE_TOOL_PINGS", env.CACHE_KEEPALIVE_TOOL_PINGS),
            idlePings: count("CACHE_KEEPALIVE_IDLE_PINGS", env.CACHE_KEEPALIVE_IDLE_PINGS),
          },
        }
      : {}),
    adminHttp: !/^(0|false|no)$/i.test(text(env.ADMIN_HTTP_ENABLED) ?? ""),
    maxParsedBodyBytes:
      maxParsedBodyBytes ?? defaults.maxParsedBodyBytes ?? DEFAULT_MAX_PARSED_BODY_BYTES,
  };
}
