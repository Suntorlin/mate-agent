import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import type { ListEventsResponse } from "@open-inspect/shared/types/sandbox-events";
import type { CardDismissResponse } from "@open-inspect/shared/types/session-cards";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, serviceFetch, type ServiceRequestInit } from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";
const POSTER = { kind: "artifact", artifactId: "art-poster-3" } as const;

function dismissCard(
  sessionId: string,
  body: unknown,
  identity: Pick<ServiceRequestInit, "service" | "actor"> = {}
): Promise<Response> {
  return serviceFetch(`https://test.local/sessions/${sessionId}/cards/dismiss`, {
    method: "POST",
    body: JSON.stringify(body),
    ...identity,
  });
}

function dismissalRows(stub: DurableObjectStub) {
  return queryDO<{ id: string; type: string; message_id: string | null }>(
    stub,
    "SELECT id, type, message_id FROM events WHERE type = 'card_dismissed' ORDER BY timeline_sequence"
  );
}

async function ownedSession(prefix: string) {
  const name = `${prefix}-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(name, {
    userId: BROWSER_USER_ID,
    canonicalUserId: BROWSER_USER_ID,
  });
  return { name, stub };
}

describe("POST /sessions/:id/cards/dismiss", () => {
  beforeEach(cleanD1Tables);

  it("records the owner's dismissal in the timeline without starting a turn", async () => {
    const { name, stub } = await ownedSession("card-dismiss");

    const response = await dismissCard(name, { target: POSTER, label: "推广片 · 第 3 版" });

    expect(response.status).toBe(200);
    const body = await response.json<CardDismissResponse>();
    expect(body).toEqual({
      event: {
        type: "card_dismissed",
        target: POSTER,
        label: "推广片 · 第 3 版",
        dismissedAt: expect.any(Number),
      },
      alreadyDismissed: false,
    });
    await expect(dismissalRows(stub)).resolves.toEqual([
      { id: "card_dismissed:artifact:art-poster-3", type: "card_dismissed", message_id: null },
    ]);
    // Nothing for the agent to run until the person writes again.
    await expect(queryDO(stub, "SELECT id FROM messages")).resolves.toEqual([]);

    // History and a reload both show the card closed.
    const events = await serviceFetch(
      `https://test.local/sessions/${name}/events?type=card_dismissed`
    );
    expect(events.status).toBe(200);
    expect((await events.json<ListEventsResponse>()).events).toEqual([
      expect.objectContaining({ type: "card_dismissed", data: body.event }),
    ]);
    const snapshot = await serviceFetch(`https://test.local/sessions/${name}`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json<SessionSnapshot>()).timeline.events).toEqual(
      expect.arrayContaining([
        {
          eventId: "card_dismissed:artifact:art-poster-3",
          timelineSequence: expect.any(Number),
          event: body.event,
        },
      ])
    );
  });

  it("answers a second dismissal of the same card with the first one, recording nothing", async () => {
    const { name, stub } = await ownedSession("card-dismiss-again");
    const first = await (
      await dismissCard(name, { target: POSTER, label: "推广片 · 第 3 版" })
    ).json<CardDismissResponse>();

    const again = await dismissCard(name, { target: POSTER });

    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ event: first.event, alreadyDismissed: true });
    await expect(dismissalRows(stub)).resolves.toHaveLength(1);
  });

  it("keeps an artifact card and an event card with the same id apart", async () => {
    const { name, stub } = await ownedSession("card-dismiss-kinds");

    expect(
      (await dismissCard(name, { target: { kind: "artifact", artifactId: "x-1" } })).status
    ).toBe(200);
    expect((await dismissCard(name, { target: { kind: "event", eventId: "x-1" } })).status).toBe(
      200
    );

    await expect(dismissalRows(stub)).resolves.toEqual([
      expect.objectContaining({ id: "card_dismissed:artifact:x-1" }),
      expect.objectContaining({ id: "card_dismissed:event:x-1" }),
    ]);
  });

  it("lets the app service dismiss for the app user who owns the session, and no other", async () => {
    const owner = { service: "app", actor: "app:uid-owner" } as const;
    const created = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Promo" }),
      ...owner,
    });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));

    const foreign = await dismissCard(
      sessionId,
      { target: POSTER },
      { service: "app", actor: "app:uid-someone-else" }
    );
    expect(foreign.status).toBeGreaterThanOrEqual(403);
    await expect(dismissalRows(stub)).resolves.toEqual([]);

    const actorless = await dismissCard(sessionId, { target: POSTER }, { service: "app" });
    expect(actorless.status).toBeGreaterThanOrEqual(400);
    await expect(dismissalRows(stub)).resolves.toEqual([]);

    const response = await dismissCard(sessionId, { target: POSTER }, owner);
    expect(response.status).toBe(200);
    await expect(dismissalRows(stub)).resolves.toHaveLength(1);
  });

  it("refuses a dismissal from someone who does not own the session", async () => {
    const name = `card-dismiss-foreign-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name, {
      userId: "another-user",
      canonicalUserId: "22222222222222222222222222222222",
    });

    const response = await dismissCard(name, { target: POSTER });

    expect(response.status).toBe(403);
    await expect(dismissalRows(stub)).resolves.toEqual([]);
  });

  it("answers 404 for a session that does not exist", async () => {
    const response = await dismissCard(`card-dismiss-missing-${crypto.randomUUID()}`, {
      target: POSTER,
    });

    expect(response.status).toBe(404);
  });

  it.each([
    {},
    { target: { kind: "question", questionId: "q-1" } },
    { target: { kind: "artifact", artifactId: "" } },
    { target: POSTER, label: "x".repeat(201) },
    { target: POSTER, extra: true },
  ])("rejects invalid body %#", async (body) => {
    const { name, stub } = await ownedSession("card-dismiss-invalid");

    expect((await dismissCard(name, body)).status).toBe(400);
    await expect(dismissalRows(stub)).resolves.toEqual([]);
  });
});
