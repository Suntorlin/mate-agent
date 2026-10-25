import { describe, expect, it } from "vitest";
import * as shared from "../index";
import { eventResponseSchema, eventTypeSchema, sandboxEventSchema } from "./sandbox-events";
import { sessionTimelineEventSchema } from "./server-messages";
import {
  CARD_DISMISS_LIMITS,
  cardDismissedEventId,
  cardDismissedEventSchema,
  cardDismissRequestSchema,
} from "./session-cards";

describe("card dismiss request", () => {
  it("names an artifact card or an event card, with an optional title", () => {
    expect(
      cardDismissRequestSchema.parse({
        target: { kind: "artifact", artifactId: "art-1" },
        label: "  推广片 · 第 3 版 ",
      })
    ).toEqual({ target: { kind: "artifact", artifactId: "art-1" }, label: "推广片 · 第 3 版" });
    expect(cardDismissRequestSchema.parse({ target: { kind: "event", eventId: "evt-1" } })).toEqual(
      { target: { kind: "event", eventId: "evt-1" } }
    );
  });

  it.each([
    {},
    { target: { kind: "question", questionId: "q-1" } },
    { target: { kind: "artifact" } },
    { target: { kind: "artifact", artifactId: "  " } },
    { target: { kind: "artifact", artifactId: "a".repeat(CARD_DISMISS_LIMITS.idChars + 1) } },
    { target: { kind: "artifact", artifactId: "art-1", eventId: "evt-1" } },
    { target: { kind: "event", eventId: "evt-1" }, label: "" },
    { target: { kind: "event", eventId: "evt-1" }, label: "x".repeat(201) },
    { target: { kind: "event", eventId: "evt-1" }, userId: "someone" },
  ])("rejects %j", (body) => {
    expect(cardDismissRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("card_dismissed event", () => {
  const event = {
    type: "card_dismissed" as const,
    target: { kind: "artifact" as const, artifactId: "art-1" },
    label: "推广片 · 第 3 版",
    dismissedAt: 1_760_000_000_000,
  };

  it("is a timeline event like any other, so history and replays carry it", () => {
    expect(sandboxEventSchema.parse(event)).toEqual(event);
    expect(eventTypeSchema.parse("card_dismissed")).toBe("card_dismissed");
    expect(
      eventResponseSchema.parse({
        id: "card_dismissed:artifact:art-1",
        type: "card_dismissed",
        data: event,
        messageId: null,
        createdAt: event.dismissedAt,
      }).type
    ).toBe("card_dismissed");
    expect(
      sessionTimelineEventSchema.parse({
        eventId: "card_dismissed:artifact:art-1",
        timelineSequence: 7,
        event,
      }).event
    ).toEqual(event);
  });

  it("requires a target and when it was dismissed", () => {
    expect(cardDismissedEventSchema.safeParse({ type: "card_dismissed" }).success).toBe(false);
    expect(cardDismissedEventSchema.safeParse({ ...event, dismissedAt: undefined }).success).toBe(
      false
    );
  });

  it("has one id per card, whatever the title", () => {
    expect(cardDismissedEventId({ kind: "artifact", artifactId: "art-1" })).toBe(
      "card_dismissed:artifact:art-1"
    );
    expect(cardDismissedEventId({ kind: "event", eventId: "art-1" })).toBe(
      "card_dismissed:event:art-1"
    );
  });

  it("is exported from the package root", () => {
    expect(shared.cardDismissRequestSchema).toBe(cardDismissRequestSchema);
    expect(shared.cardDismissedEventSchema).toBe(cardDismissedEventSchema);
    expect(shared.cardDismissedEventId).toBe(cardDismissedEventId);
  });
});
