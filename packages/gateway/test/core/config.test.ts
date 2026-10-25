// The gateway's configuration: the variables both hosts read, their defaults and checks.
import { expect, test } from "vitest";
import {
  ConfigError,
  DEFAULT_MAX_PARSED_BODY_BYTES,
  type GatewayVars,
  parseConfig,
} from "../../src/core/config";
import { DEFAULT_MODEL_MAP } from "../../src/core/models";

const minimal = (vars: GatewayVars = {}): GatewayVars => ({
  GATEWAY_SECRET: " test-secret ",
  OPENROUTER_API_KEY: "sk-or-test",
  ...vars,
});

test("unset variables take the defaults", () => {
  expect(parseConfig(minimal())).toEqual({
    secret: "test-secret",
    apiKey: "sk-or-test",
    upstreamBase: "https://openrouter.ai/api",
    modelMap: DEFAULT_MODEL_MAP,
    forceDefaultModel: false,
    budgetUsd: 25,
    userBudgetUsd: 20,
    monthlyBudgetUsd: null,
    userBudgetPeriod: "month",
    adminHttp: true,
    maxParsedBodyBytes: DEFAULT_MAX_PARSED_BODY_BYTES,
  });
});

test("a host may bring its own default body limit; the variable still wins", () => {
  expect(parseConfig(minimal(), { maxParsedBodyBytes: 1024 }).maxParsedBodyBytes).toBe(1024);
  expect(
    parseConfig(minimal({ MAX_PARSED_BODY_BYTES: "2048" }), { maxParsedBodyBytes: 1024 })
      .maxParsedBodyBytes
  ).toBe(2048);
});

test("empty strings, as the example wrangler.jsonc sets them, also mean the default", () => {
  const config = parseConfig(
    minimal({
      LLM_MONTHLY_BUDGET_USD: "",
      LLM_ALERT_WEBHOOK_URL: "",
      LLM_MODEL_MAP: "",
      CACHE_KEEPALIVE_TOOL_PINGS: "",
      MAX_PARSED_BODY_BYTES: "",
    })
  );
  expect(config.monthlyBudgetUsd).toBeNull();
  expect(config.alertWebhook).toBeUndefined();
  expect(config.modelMap).toBe(DEFAULT_MODEL_MAP);
  expect(config.maxParsedBodyBytes).toBe(DEFAULT_MAX_PARSED_BODY_BYTES);
});

test("set variables are read, numbers and flags as wrangler may pass them", () => {
  const config = parseConfig(
    minimal({
      LLM_BUDGET_USD: 200,
      LLM_USER_BUDGET_USD: "50",
      LLM_MONTHLY_BUDGET_USD: "300",
      LLM_USER_BUDGET_PERIOD: "day",
      LLM_ALERT_WEBHOOK_URL: "https://hooks.test/bot",
      LLM_MODEL_MAP: '{"haiku":"h","default":"d"}',
      LLM_FORCE_DEFAULT_MODEL: true,
      CACHE_KEEPALIVE: "yes",
      CACHE_KEEPALIVE_TOOL_PINGS: "4",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/",
      ADMIN_HTTP_ENABLED: "false",
      MAX_PARSED_BODY_BYTES: "1048576",
    })
  );
  expect(config).toMatchObject({
    budgetUsd: 200,
    userBudgetUsd: 50,
    monthlyBudgetUsd: 300,
    userBudgetPeriod: "day",
    alertWebhook: "https://hooks.test/bot",
    modelMap: { haiku: "h", default: "d" },
    forceDefaultModel: true,
    keepAlive: { toolPings: 4, idlePings: undefined },
    upstreamBase: "https://openrouter.test/api",
    adminHttp: false,
    maxParsedBodyBytes: 1_048_576,
  });
});

test("usage reports need both their URL and their bearer", () => {
  expect(parseConfig(minimal({})).usageReport).toBeUndefined();
  expect(
    parseConfig(
      minimal({
        LLM_USAGE_REPORT_URL: " https://product.test/internal/llm-usage ",
        LLM_USAGE_REPORT_TOKEN: "bearer",
      })
    ).usageReport
  ).toEqual({ url: "https://product.test/internal/llm-usage", token: "bearer" });
  for (const vars of [
    { LLM_USAGE_REPORT_URL: "https://product.test/internal/llm-usage" },
    { LLM_USAGE_REPORT_TOKEN: "bearer" },
  ]) {
    expect(() => parseConfig(minimal(vars))).toThrow(
      "LLM_USAGE_REPORT_URL and LLM_USAGE_REPORT_TOKEN are set together"
    );
  }
  expect(() =>
    parseConfig(minimal({ LLM_USAGE_REPORT_URL: "product.test", LLM_USAGE_REPORT_TOKEN: "b" }))
  ).toThrow("LLM_USAGE_REPORT_URL must be an http(s) URL");
});

test("the keep-alive needs its switch", () => {
  expect(parseConfig(minimal({ CACHE_KEEPALIVE_TOOL_PINGS: "4" })).keepAlive).toBeUndefined();
  expect(parseConfig(minimal({ CACHE_KEEPALIVE: "0" })).keepAlive).toBeUndefined();
});

test("a bad value names the variable", () => {
  const cases: Array<[GatewayVars, string]> = [
    [{ GATEWAY_SECRET: " " }, "GATEWAY_SECRET is not set"],
    [{ OPENROUTER_API_KEY: undefined }, "OPENROUTER_API_KEY is not set"],
    [{ LLM_BUDGET_USD: "-1" }, "LLM_BUDGET_USD must be a number >= 0"],
    [{ LLM_USER_BUDGET_USD: "lots" }, "LLM_USER_BUDGET_USD must be a number >= 0"],
    [{ LLM_MONTHLY_BUDGET_USD: "-5" }, "LLM_MONTHLY_BUDGET_USD must be a number >= 0"],
    [{ LLM_USER_BUDGET_PERIOD: "week" }, "LLM_USER_BUDGET_PERIOD must be one of month, day"],
    [
      { LLM_MODEL_MAP: '{"opus":"x"}' },
      'LLM_MODEL_MAP: LLM_MODEL_MAP must include a "default" entry',
    ],
    [
      { CACHE_KEEPALIVE: "1", CACHE_KEEPALIVE_IDLE_PINGS: "1.5" },
      "CACHE_KEEPALIVE_IDLE_PINGS must be an integer >= 0",
    ],
    [{ MAX_PARSED_BODY_BYTES: "0" }, "MAX_PARSED_BODY_BYTES must be > 0"],
  ];
  for (const [vars, message] of cases) {
    expect(() => parseConfig(minimal(vars)), message).toThrow(ConfigError);
    expect(() => parseConfig(minimal(vars))).toThrow(message);
  }
});
