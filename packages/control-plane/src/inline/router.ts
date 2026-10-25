/**
 * Decides whether a prompt needs a sandbox (a computer) or can run inline.
 *
 * Jev, the small decision model OpenRouter serves at /systemone (the same one that picks the
 * effort of "auto" prompts, see session/auto-reasoning-effort.ts), is asked whether handling the
 * message needs a computer. Measured on assistant messages: about 0.35 s and $0.00002 a call, 9
 * of 9 sample messages routed as expected. Every doubt routes inline, because inline is cheap and
 * the inline model can still hand the turn to a sandbox itself (the use_sandbox tool): Jev
 * unconfigured, failing, slow or unparsed all run inline.
 */

import type { Logger } from "../logger";

export const JEV_URL = "https://openrouter.ai/api/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** At or above this probability of "needs a computer" the prompt goes to a sandbox. */
export const SANDBOX_THRESHOLD = 0.5;
export const ROUTE_TIMEOUT_MS = 2_000;
const MAX_MESSAGE_CHARS = 2_000;

const QUESTION = {
  computer: {
    type: "noul",
    instructions:
      "The state is the latest message a user sent to a personal assistant agent, with their " +
      "previous message for context. Answer yes if handling it needs a computer: running code " +
      "or shell commands, creating, converting or editing files or documents, analysing a " +
      "spreadsheet, PDF or many pages of material, browsing several web pages, or a long " +
      "multi-step task that produces an artifact. Answer no if a conversational reply is " +
      "enough, even with a few simple app actions: a question, advice, planning, a reminder or " +
      "task to add, small talk, a short summary or rewrite of text given in the message, or a " +
      "confirmation.",
  },
} as const;

export type Runtime = "inline" | "sandbox";

export interface RouteInput {
  messageId: string;
  content: string;
  previousContent: string | null;
  /** Attachments go to a sandbox: the inline runtime sends text only for now. */
  hasAttachments: boolean;
}

export type ChooseRuntime = (input: RouteInput) => Promise<Runtime>;

export interface JevRuntimeRouterOptions {
  apiKey: string | undefined;
  log: Logger;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

function probabilityOfComputer(body: unknown): number | null {
  const answer = (body as { answers?: { computer?: { noul?: unknown } } })?.answers?.computer?.noul;
  const p = typeof answer === "number" ? answer : (answer as { yes?: unknown } | undefined)?.yes;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

export function createJevRuntimeRouter(options: JevRuntimeRouterOptions): ChooseRuntime {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  return async (input) => {
    const decide = (runtime: Runtime, fields: Record<string, unknown>) => {
      options.log.info("prompt.route", {
        event: "prompt.route",
        message_id: input.messageId,
        runtime,
        ...fields,
      });
      return runtime;
    };
    if (input.hasAttachments) return decide("sandbox", { reason: "attachments" });
    if (!options.apiKey) return decide("inline", { reason: "unconfigured" });

    const state: Record<string, string> = {
      latest_user_message: input.content.slice(0, MAX_MESSAGE_CHARS),
    };
    if (input.previousContent) {
      state.previous_user_message = input.previousContent.slice(0, MAX_MESSAGE_CHARS);
    }
    const started = now();
    try {
      const response = await fetchFn(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTION }),
        signal: AbortSignal.timeout(options.timeoutMs ?? ROUTE_TIMEOUT_MS),
      });
      const latencyMs = now() - started;
      if (!response.ok) {
        return decide("inline", {
          reason: "jev_error",
          status: response.status,
          latency_ms: latencyMs,
        });
      }
      const body: unknown = await response.json();
      const p = probabilityOfComputer(body);
      const cost = (body as { usage?: { cost?: unknown } })?.usage?.cost;
      const fields = {
        p_computer: p,
        latency_ms: latencyMs,
        jev_cost_usd: typeof cost === "number" ? cost : null,
      };
      if (p === null) return decide("inline", { reason: "jev_unparsed", ...fields });
      return p >= SANDBOX_THRESHOLD
        ? decide("sandbox", { reason: "needs_computer", ...fields })
        : decide("inline", { reason: "conversational", ...fields });
    } catch (error) {
      return decide("inline", {
        reason:
          error instanceof Error && error.name === "TimeoutError" ? "jev_timeout" : "jev_failed",
        latency_ms: now() - started,
      });
    }
  };
}
