import {
  cardDismissedEventId,
  cardDismissedEventSchema,
  cardDismissRequestSchema,
  type CardDismissedEvent,
  type CardDismissResponse,
} from "@open-inspect/shared/types/session-cards";
import type { EventRepository } from "../../event-repository";
import type { SessionMessenger } from "../../messenger";
import type { SessionCoreRepository } from "../../session-core-repository";

/**
 * Records that the session owner closed a card. The `card_dismissed` event
 * goes into the timeline, so reloads and replays show the card closed, and
 * waits there for the next prompt, which tells the agent (see
 * `withCardDismissalNotes`). Closing a card starts no turn, and closing it
 * again records nothing new.
 */
export class CardDismissHandler {
  constructor(
    private readonly repository: Pick<SessionCoreRepository, "getSession">,
    private readonly events: Pick<EventRepository, "createEventIfAbsent" | "getEventById">,
    private readonly messenger: Pick<SessionMessenger, "broadcast">,
    private readonly now: () => number
  ) {}

  async dismiss(request: Request): Promise<Response> {
    if (!this.repository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const parsed = cardDismissRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid card dismiss request" }, { status: 400 });
    }

    const { target, label } = parsed.data;
    const dismissedAt = this.now();
    const event: CardDismissedEvent = {
      type: "card_dismissed",
      target,
      ...(label ? { label } : {}),
      dismissedAt,
    };
    const id = cardDismissedEventId(target);
    const created = this.events.createEventIfAbsent({
      id,
      type: event.type,
      data: JSON.stringify(event),
      messageId: null,
      createdAt: dismissedAt,
    });
    if (created) {
      this.messenger.broadcast({ type: "sandbox_event", event });
      return Response.json({ event, alreadyDismissed: false } satisfies CardDismissResponse);
    }

    return Response.json({
      event: this.recordedDismissal(id) ?? event,
      alreadyDismissed: true,
    } satisfies CardDismissResponse);
  }

  private recordedDismissal(id: string): CardDismissedEvent | null {
    const row = this.events.getEventById(id);
    if (!row) return null;
    try {
      const recorded = cardDismissedEventSchema.safeParse(JSON.parse(row.data));
      return recorded.success ? recorded.data : null;
    } catch {
      return null;
    }
  }
}
