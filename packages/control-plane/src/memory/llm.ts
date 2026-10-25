/**
 * The small model the memory jobs call. With an LLM gateway, Haiku through it, billed to the
 * user: the control plane mints a short-lived gateway token of the same shape a sandbox's has
 * (`sub` the user, `sid` the session, no `scope`), so the gateway checks the call against that
 * user's budget and records it there. Without one, the Messages API the inline runtime uses
 * (INLINE_LLM_BASE_URL with INLINE_LLM_API_KEY) and MEMORY_MODEL. Non-streaming: the answers
 * are short.
 */

import { z } from "zod";
import { mintJwt } from "../auth/jwt";
import type { JobOutcome } from "../jobs";
import type { Logger } from "../logger";
import { withRequestDeadline } from "../sandbox/request-deadline";
import { readGatewayConfig, type GatewayConfig } from "../gateway/config";
import type { EnvConfig, Platform } from "../types";

/** Where the memory jobs' model calls go. */
export type UserMemoryModel =
  | { readonly kind: "gateway"; readonly gateway: GatewayConfig }
  | {
      readonly kind: "direct";
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly model: string;
    };

/** Both memory jobs: three deliveries, a minute apart. */
export const USER_MEMORY_JOB_RETRY = Object.freeze({ maxAttempts: 3, retryDelayMs: 60_000 });

/** The model the gateway serves the memory jobs. */
export const USER_MEMORY_MODEL = "claude-haiku-4-5";
/** The model a direct Messages API serves them, unless MEMORY_MODEL names another. */
export const DEFAULT_DIRECT_MEMORY_MODEL = "anthropic/claude-haiku-4.5";
/** How long one memory call may take before it counts as failed. */
const USER_MEMORY_MODEL_DEADLINE_MS = 30_000;
const TOKEN_TTL_SECONDS = 10 * 60;
const ANTHROPIC_VERSION = "2023-06-01";
// Cloudflare in front of the gateway rejects some default client agents (error 1010).
const USER_AGENT = "agent-engine-control-plane/1 (memory)";
/** How much of a refused call's body is kept for the log. */
const ERROR_BODY_CHARS = 300;

const messageResponseSchema = z.object({
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

class UserMemoryModelError extends Error {
  constructor(
    message: string,
    /** The model API's HTTP status, or null when no answer came (network, deadline). */
    readonly status: number | null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "UserMemoryModelError";
  }

  /** The user's (or the deployment's) budget is spent: trying again will not help today. */
  get budgetSpent(): boolean {
    return this.status === 429;
  }

  /** Whether a later attempt could succeed: no answer, a timeout, a conflict or a server error. */
  get retryable(): boolean {
    return this.status === null || this.status === 408 || this.status === 409 || this.status >= 500;
  }
}

export interface UserMemoryModelReply {
  /** The text blocks of the answer, joined. */
  text: string;
  model: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export async function askUserMemoryModel(
  target: UserMemoryModel,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly system: string;
    readonly prompt: string;
    readonly maxTokens: number;
    readonly nowMs: number;
    readonly fetch?: typeof fetch;
  }
): Promise<UserMemoryModelReply> {
  let url: string;
  let key: string;
  let model: string;
  let doFetch = input.fetch ?? fetch;
  if (target.kind === "gateway") {
    const iat = Math.floor(input.nowMs / 1000);
    key = await mintJwt(
      { sub: input.userId, sid: input.sessionId, iat, exp: iat + TOKEN_TTL_SECONDS },
      target.gateway.secret
    );
    url = `${target.gateway.url}/llm/v1/messages`;
    model = USER_MEMORY_MODEL;
    doFetch = input.fetch ?? target.gateway.fetch ?? fetch;
  } else {
    key = target.apiKey;
    url = `${target.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    model = target.model;
  }
  const started = Date.now();
  const body = await withRequestDeadline(
    "memory model",
    "memory",
    USER_MEMORY_MODEL_DEADLINE_MS,
    undefined,
    async (signal) => {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "x-api-key": key,
          Authorization: `Bearer ${key}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens,
          // Memory writes should not change from one run to the next.
          temperature: 0,
          system: input.system,
          messages: [{ role: "user", content: input.prompt }],
        }),
        signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, ERROR_BODY_CHARS);
        throw new UserMemoryModelError(
          `The memory model answered ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status
        );
      }
      return response.json();
    }
  ).catch((cause: unknown) => {
    if (cause instanceof UserMemoryModelError) throw cause;
    throw new UserMemoryModelError("The memory model call failed", null, { cause });
  });
  const parsed = messageResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new UserMemoryModelError("The memory model's answer is not a message", 502);
  const message = parsed.data;
  return {
    text: message.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join(""),
    model: message.model ?? model,
    stopReason: message.stop_reason ?? null,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
    latencyMs: Date.now() - started,
  };
}

/**
 * Where the memory jobs' model calls go: the deployment's gateway, else the inline runtime's
 * Messages API; null when there is neither (memory jobs then have nothing to call) or the
 * gateway's configuration is broken (logged).
 */
export function userMemoryModel(
  env: Pick<
    EnvConfig,
    | "GATEWAY_URL"
    | "GATEWAY_SECRET"
    | "INLINE_LLM_BASE_URL"
    | "INLINE_LLM_API_KEY"
    | "INLINE_MODEL"
    | "MEMORY_MODEL"
  > &
    Partial<Pick<Platform, "GATEWAY">>,
  log: Logger
): UserMemoryModel | null {
  try {
    const gateway = readGatewayConfig(env);
    if (gateway) return { kind: "gateway", gateway };
    const baseUrl = env.INLINE_LLM_BASE_URL?.trim();
    const apiKey = env.INLINE_LLM_API_KEY?.trim();
    if (!baseUrl || !apiKey) return null;
    return {
      kind: "direct",
      baseUrl,
      apiKey,
      model: env.MEMORY_MODEL?.trim() || DEFAULT_DIRECT_MEMORY_MODEL,
    };
  } catch (error) {
    log.error("user_memory.misconfigured", {
      event: "user_memory.misconfigured",
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
}

/**
 * What a memory job does after a failed model call: a spent budget is the
 * user's to lift, not a reason to try again; a refused request will be
 * refused again; anything else is retried a minute later.
 */
export function afterUserMemoryModelFailure(
  error: unknown,
  log: Logger,
  context: Record<string, unknown>
): JobOutcome {
  const status = error instanceof UserMemoryModelError ? error.status : null;
  if (error instanceof UserMemoryModelError && error.budgetSpent) {
    log.info("user_memory.budget_spent", { ...context, event: "user_memory.budget_spent", status });
    return "ack";
  }
  if (error instanceof UserMemoryModelError && !error.retryable) {
    log.error("user_memory.model_refused", {
      ...context,
      event: "user_memory.model_refused",
      status,
      error,
    });
    return "ack";
  }
  log.warn("user_memory.model_failed", {
    ...context,
    event: "user_memory.model_failed",
    status,
    error: error instanceof Error ? error : String(error),
  });
  return { retry: true, delayMs: USER_MEMORY_JOB_RETRY.retryDelayMs };
}
