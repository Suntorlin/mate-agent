import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";

/**
 * Persist a session-continuity notice in the existing timeline format so
 * disconnected clients see it too. The web shows it as a quiet status line.
 */
export function recordSessionWarning(
  events: EventRepository,
  messenger: Pick<SessionMessenger, "broadcast">,
  message: string,
  eventId: string
): void {
  const now = Date.now();
  const event: Extract<SandboxEvent, { type: "warning" }> = {
    type: "warning",
    scope: "continuity",
    message,
    timestamp: now / 1000,
  };
  const created = events.createEventIfAbsent({
    id: eventId,
    type: "warning",
    data: JSON.stringify(event),
    messageId: null,
    createdAt: now,
  });
  if (created) messenger.broadcast({ type: "sandbox_event", event });
}
