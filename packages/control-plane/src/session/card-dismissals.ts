import type { CardDismissedEvent } from "@open-inspect/shared/types/session-cards";

/**
 * The line that tells the agent a card was closed, in the bracketed form of
 * the other notes the platform adds to a message (the sandbox's attached-files
 * note): one line, so the sandbox's memory recall can strip it as a platform
 * note rather than read it as the person's words.
 */
export function describeCardDismissal(event: CardDismissedEvent): string {
  const label = event.label ? oneLine(event.label) : "";
  if (label) return `[用户关闭了卡片「${label}」]`;
  return event.target.kind === "artifact"
    ? `[用户关闭了卡片（产物 ${oneLine(event.target.artifactId)}）]`
    : `[用户关闭了卡片（事件 ${oneLine(event.target.eventId)}）]`;
}

/**
 * The prompt text the agent receives: the person's message, then a line for
 * each card closed since the last prompt, oldest first. The timeline keeps
 * the message as the person wrote it.
 */
export function withCardDismissalNotes(
  content: string,
  dismissals: readonly CardDismissedEvent[]
): string {
  if (dismissals.length === 0) return content;
  return `${content}\n\n${dismissals.map(describeCardDismissal).join("\n")}`;
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
