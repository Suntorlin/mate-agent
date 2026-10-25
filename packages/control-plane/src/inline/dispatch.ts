/**
 * What the session's message queue needs from the inline runtime, and the note that tells a
 * sandbox's agent about the turns it did not see.
 */

import type { ChooseRuntime } from "./router";
import type { InlineOutcome } from "./runtime";

export interface InlineDispatch {
  /** Asked only when no sandbox is attached; a running sandbox keeps the conversation. */
  chooseRuntime: ChooseRuntime;
  run(input: { messageId: string; content: string; userId: string }): Promise<InlineOutcome>;
}

/** How many inline turns a sandbox prompt carries at most. */
export const INLINE_TURNS_FOR_SANDBOX = 20;
const MAX_TURN_CHARS = 2_000;

/**
 * Prefix for a sandbox prompt when earlier turns ran inline: the sandbox's agent keeps its own
 * history, so without this it would not know what was said while it was not running.
 */
export function withInlineTurns(
  content: string,
  turns: Array<{ content: string; reply: string | null }>
): string {
  if (turns.length === 0) return content;
  const lines = turns.map(
    (turn) =>
      `User: ${turn.content.slice(0, MAX_TURN_CHARS)}\nAssistant: ${(turn.reply ?? "").slice(0, MAX_TURN_CHARS)}`
  );
  return (
    "[Earlier in this conversation, answered without a computer]\n" +
    `${lines.join("\n\n")}\n[End of earlier turns]\n\n${content}`
  );
}
