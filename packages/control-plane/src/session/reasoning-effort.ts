/** The reasoning effort a session's prompts run at. */

import {
  AUTO_REASONING_EFFORT,
  getDefaultReasoningEffort,
  isRequestableReasoningEffort,
} from "@open-inspect/shared/models";
import type { Logger } from "../logger";

/**
 * Validate reasoning effort against a model's allowed values.
 * Returns the validated effort string or null if invalid/absent.
 * "auto" is kept for a model that has "low": the queue picks the effort when it dispatches.
 */
export function validateReasoningEffort(
  model: string,
  effort: string | undefined,
  log: Logger
): string | null {
  if (!effort) return null;
  if (isRequestableReasoningEffort(model, effort)) return effort;
  log.warn("Invalid reasoning effort for model, ignoring", {
    model,
    reasoning_effort: effort,
  });
  return null;
}

type EffortSession = { reasoning_effort?: string | null } | null | undefined;

/**
 * The effort a prompt runs at unless it names one: the session's own, else the model's default.
 * May be "auto" (`AUTO_REASONING_EFFORT`), which the queue resolves per prompt.
 */
export function sessionDefaultReasoningEffort(
  session: EffortSession,
  model: string
): string | undefined {
  return session?.reasoning_effort ?? baseReasoningEffort(session, model);
}

/**
 * The effort the session runs at when nothing asks for less: its own unless that is "auto",
 * else the model's default. The sandbox starts its agent at this effort ahead of the first
 * prompt, so a prompt that resolves to another one switches the agent's effort.
 */
export function baseReasoningEffort(session: EffortSession, model: string): string | undefined {
  const own = session?.reasoning_effort;
  return (
    (own && own !== AUTO_REASONING_EFFORT ? own : undefined) ?? getDefaultReasoningEffort(model)
  );
}
