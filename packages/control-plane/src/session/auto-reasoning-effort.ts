/**
 * Picks the effort for a prompt that asked for "auto" (`AUTO_REASONING_EFFORT`).
 *
 * Jev, a small decision model on OpenRouter, is asked whether the message needs any new design
 * or build work. When it is sure it does not (a small tweak, a question, a confirmation, small
 * talk) the prompt runs at "low", which cost 60% less than "medium" on small edits with the
 * same results; otherwise at the session's base effort. Building something new at "low" has
 * gone wrong (a finished video with almost no sound), so every doubt keeps the base effort:
 * below the threshold, answers to question cards (they start a build), and any failure or
 * timeout of the call. Measured: about 0.4 s and $0.00002 a call.
 */

import type { Logger } from "../logger";

export const JEV_URL = "https://openrouter.ai/api/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** At or above this probability of "no new work" the prompt runs at "low". */
export const AUTO_LOW_THRESHOLD = 0.7;
export const AUTO_EFFORT_TIMEOUT_MS = 2_000;
/** Answers to a question card and button presses, which go on with the work asked before. */
const CARD_REPLY_PREFIXES = ["[回答", "[用户"];
/** Jev reads the head of a long message; the rest rarely changes the answer. */
const MAX_MESSAGE_CHARS = 2_000;

const QUESTION = {
  small: {
    type: "noul",
    instructions:
      "The state is the latest message from a user to an agent, with the user's previous " +
      "message for context. Answer yes if handling the latest message needs no new design or " +
      "build work: small talk, a question, a confirmation, or a small tweak to something " +
      "already made (change a word, a colour, a size, a value, re-export). Answer no if the " +
      "agent must plan, write or build new content: a new piece of work, a new section, a " +
      "different style or structure, a redo, or fixing something that is broken. Also answer " +
      "no when the latest message tells the agent to go on with, or approves, a build that is " +
      "not finished yet (for example 'continue' or 'ok, go' after asking for something new).",
  },
} as const;

export interface AutoEffortInput {
  messageId: string;
  content: string;
  /** The previous prompt's text, so "continue" after a build request is read as part of it. */
  previousContent: string | null;
  /** What the prompt runs at unless Jev is sure it needs no new work. */
  baseEffort: string | undefined;
}

export type ChooseAutoEffort = (input: AutoEffortInput) => Promise<string | undefined>;

export interface JevEffortChooserOptions {
  apiKey: string | undefined;
  log: Logger;
  fetchFn?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  now?: () => number;
}

function probabilityOfSmall(body: unknown): number | null {
  const answer = (body as { answers?: { small?: { noul?: unknown } } })?.answers?.small?.noul;
  const p = typeof answer === "number" ? answer : (answer as { yes?: unknown } | undefined)?.yes;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

export function createJevEffortChooser(options: JevEffortChooserOptions): ChooseAutoEffort {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  return async (input) => {
    const base = input.baseEffort;
    const decide = (effort: string | undefined, fields: Record<string, unknown>) => {
      options.log.info("prompt.auto_effort", {
        event: "prompt.auto_effort",
        message_id: input.messageId,
        base_effort: base,
        reasoning_effort: effort,
        ...fields,
      });
      return effort;
    };
    if (!options.apiKey) return decide(base, { reason: "unconfigured" });
    const text = input.content.trimStart();
    if (CARD_REPLY_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      return decide(base, { reason: "card_reply" });
    }
    const state: Record<string, string> = {
      latest_user_message: input.content.slice(0, MAX_MESSAGE_CHARS),
    };
    if (input.previousContent) {
      state.previous_user_message = input.previousContent.slice(0, MAX_MESSAGE_CHARS);
    }
    const started = now();
    try {
      const response = await fetchFn(options.url ?? JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTION }),
        signal: AbortSignal.timeout(options.timeoutMs ?? AUTO_EFFORT_TIMEOUT_MS),
      });
      const latencyMs = now() - started;
      if (!response.ok) {
        return decide(base, {
          reason: "jev_error",
          status: response.status,
          latency_ms: latencyMs,
        });
      }
      const body: unknown = await response.json();
      const p = probabilityOfSmall(body);
      const cost = (body as { usage?: { cost?: unknown } })?.usage?.cost;
      const fields = {
        p_small: p,
        latency_ms: latencyMs,
        jev_cost_usd: typeof cost === "number" ? cost : null,
      };
      if (p === null) return decide(base, { reason: "jev_unparsed", ...fields });
      return p >= AUTO_LOW_THRESHOLD
        ? decide("low", { reason: "small", ...fields })
        : decide(base, { reason: "work", ...fields });
    } catch (error) {
      return decide(base, {
        reason: "jev_failed",
        latency_ms: now() - started,
        error: error instanceof Error ? error.name : String(error),
      });
    }
  };
}
