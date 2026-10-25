/**
 * The signed-in user's LLM spend against their own budget, read from the LLM
 * gateway. The gateway keeps the ledger and enforces the budget; the control
 * plane only asks on the user's behalf, with a short-lived JWT whose `sub` is
 * the user and whose `scope: "usage"` lets it read that user's usage and do
 * nothing else (no LLM calls, no memory).
 */

import { z } from "zod";
import { mintJwt } from "../auth/jwt";
import { withRequestDeadline } from "../sandbox/request-deadline";
import type { GatewayConfig } from "./config";

export const GATEWAY_USAGE_TOKEN_TTL_SECONDS = 60;
export const GATEWAY_USAGE_SCOPE = "usage";
const GATEWAY_USAGE_SESSION_ID = "control-plane-usage";
const GATEWAY_USAGE_REQUEST_DEADLINE_MS = 10_000;
// Cloudflare in front of the gateway rejects some default client agents.
const USER_AGENT = "agent-engine-control-plane/1 (usage)";

const gatewayUsageSchema = z.object({
  period: z.enum(["month", "day"]),
  period_start: z.string(),
  resets_at: z.string(),
  budget_usd: z.number(),
  spent_usd: z.number(),
  remaining_usd: z.number(),
});

/** What `GET /me/llm-usage` returns. */
export interface LlmUsage {
  readonly period: "month" | "day";
  readonly periodStart: string;
  readonly resetsAt: string;
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
}

export class GatewayUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayUsageError";
  }
}

export async function mintGatewayUsageToken(
  secret: string,
  input: { readonly userId: string; readonly nowMs: number }
): Promise<string> {
  const iat = Math.floor(input.nowMs / 1000);
  return mintJwt(
    {
      sub: input.userId,
      sid: GATEWAY_USAGE_SESSION_ID,
      scope: GATEWAY_USAGE_SCOPE,
      iat,
      exp: iat + GATEWAY_USAGE_TOKEN_TTL_SECONDS,
    },
    secret
  );
}

export async function fetchLlmUsage(
  gateway: GatewayConfig,
  input: { readonly userId: string; readonly nowMs: number; readonly fetch?: typeof fetch }
): Promise<LlmUsage> {
  const token = await mintGatewayUsageToken(gateway.secret, input);
  const doFetch = input.fetch ?? gateway.fetch ?? fetch;
  const body = await withRequestDeadline(
    "LLM gateway",
    "usage",
    GATEWAY_USAGE_REQUEST_DEADLINE_MS,
    undefined,
    async (signal) => {
      const response = await doFetch(`${gateway.url}/llm/usage`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayUsageError(`LLM gateway usage returned ${response.status}`);
      }
      return response.json();
    }
  ).catch((cause: unknown) => {
    if (cause instanceof GatewayUsageError) throw cause;
    throw new GatewayUsageError("LLM gateway usage request failed", { cause });
  });
  const parsed = gatewayUsageSchema.safeParse(body);
  if (!parsed.success) throw new GatewayUsageError("LLM gateway usage response is invalid");
  const usage = parsed.data;
  return {
    period: usage.period,
    periodStart: usage.period_start,
    resetsAt: usage.resets_at,
    budgetUsd: usage.budget_usd,
    spentUsd: usage.spent_usd,
    remainingUsd: usage.remaining_usd,
  };
}
