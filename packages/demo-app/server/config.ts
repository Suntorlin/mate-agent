/** The demo backend's settings, read once from the environment (see README for each). */

export interface Config {
  port: number;
  dataDir: string;
  engineUrl: string;
  /** The engine's SERVICE_AUTH_SECRET_APP: the key this backend signs its engine calls with. */
  engineSecret: string;
  /** The engine's APP_ENGINE_TOKEN: the bearer the engine shows when it asks for an MCP token. */
  engineToken: string;
  /** The one model both runtimes use. */
  model: string;
  signupCredits: number;
  creditsPerUsd: number;
}

/** Sandbox turns name the model by the engine's id; the inline runtime uses INLINE_MODEL. */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_PORT = 9320;
/** One credit is a tenth of a US cent: a new account can spend two dollars of model time. */
const DEFAULT_CREDITS_PER_USD = 1000;
const DEFAULT_SIGNUP_CREDITS = 2000;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (see packages/demo-app/README.md)`);
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: positiveNumber(env, "DEMO_PORT", DEFAULT_PORT),
    dataDir: env.DEMO_DATA_DIR?.trim() || ".local/demo-app",
    engineUrl: (env.DEMO_ENGINE_URL?.trim() || "http://localhost:8797").replace(/\/+$/, ""),
    engineSecret: required(env, "SERVICE_AUTH_SECRET_APP"),
    engineToken: required(env, "APP_ENGINE_TOKEN"),
    model: env.DEMO_MODEL?.trim() || DEFAULT_MODEL,
    signupCredits: positiveNumber(env, "DEMO_SIGNUP_CREDITS", DEFAULT_SIGNUP_CREDITS),
    creditsPerUsd: positiveNumber(env, "DEMO_CREDITS_PER_USD", DEFAULT_CREDITS_PER_USD),
  };
}
