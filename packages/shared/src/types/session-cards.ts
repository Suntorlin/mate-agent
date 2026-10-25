/**
 * Cards a person closes in a session's conversation: a media or status card
 * (video, image, narration, file, error, interruption, …) the client shows
 * for an artifact or a timeline event.
 *
 * Closing a card is something the agent should know, the way it knows what
 * the person says: the control plane records a `card_dismissed` timeline
 * event (so a reload or a replay shows the card closed) and tells the agent
 * with the person's next message. It never starts a turn by itself.
 *
 * Question cards are answered or dismissed through the question flow, not here.
 */

import { z } from "zod";

export const CARD_DISMISS_LIMITS = Object.freeze({
  /** An artifact or event id, as the client knows the card by. */
  idChars: 200,
  /** The card title the client shows, quoted to the agent. */
  labelChars: 200,
});

const cardIdSchema = z.string().trim().min(1).max(CARD_DISMISS_LIMITS.idChars);

/** Which card was closed: the artifact or the timeline event it shows. */
export const cardDismissTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), artifactId: cardIdSchema }),
  z.strictObject({ kind: z.literal("event"), eventId: cardIdSchema }),
]);
export type CardDismissTarget = z.infer<typeof cardDismissTargetSchema>;

/** Body of `POST /sessions/:id/cards/dismiss`. */
export const cardDismissRequestSchema = z.strictObject({
  target: cardDismissTargetSchema,
  /** The card's title as the client shows it; what the agent is told was closed. */
  label: z.string().trim().min(1).max(CARD_DISMISS_LIMITS.labelChars).optional(),
});
export type CardDismissRequest = z.infer<typeof cardDismissRequestSchema>;

/**
 * The timeline event a dismissal records. One per card: closing a card that
 * is already closed changes nothing. `dismissedAt` is epoch milliseconds.
 */
export const cardDismissedEventSchema = z.object({
  type: z.literal("card_dismissed"),
  target: cardDismissTargetSchema,
  label: z.string().optional(),
  dismissedAt: z.number().int().nonnegative(),
});
export type CardDismissedEvent = z.infer<typeof cardDismissedEventSchema>;

/** Answer to `POST /sessions/:id/cards/dismiss`, the first time and every time after. */
export const cardDismissResponseSchema = z.object({
  event: cardDismissedEventSchema,
  /** True when the card was already closed; nothing new was recorded. */
  alreadyDismissed: z.boolean(),
});
export type CardDismissResponse = z.infer<typeof cardDismissResponseSchema>;

/** The stable timeline event id of a card's dismissal; at most one per card. */
export function cardDismissedEventId(target: CardDismissTarget): string {
  return target.kind === "artifact"
    ? `card_dismissed:artifact:${target.artifactId}`
    : `card_dismissed:event:${target.eventId}`;
}
