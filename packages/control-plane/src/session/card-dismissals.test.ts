import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDismissedEvent } from "@open-inspect/shared/types/session-cards";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { describeCardDismissal, withCardDismissalNotes } from "./card-dismissals";
import { EventRepository } from "./event-repository";
import { CardDismissHandler } from "./http/handlers/card-dismiss.handler";
import { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import { initSchema } from "./schema";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import type { SqlStorage } from "./sql-storage";

function dismissed(
  target: CardDismissedEvent["target"],
  label?: string,
  dismissedAt = 1000
): CardDismissedEvent {
  return { type: "card_dismissed", target, ...(label ? { label } : {}), dismissedAt };
}

describe("what the agent is told about a closed card", () => {
  it("quotes the card's title", () => {
    expect(
      describeCardDismissal(
        dismissed({ kind: "artifact", artifactId: "art-1" }, "推广片 · 第 3 版")
      )
    ).toBe("[用户关闭了卡片「推广片 · 第 3 版」]");
  });

  it("keeps a title on one line", () => {
    expect(
      describeCardDismissal(dismissed({ kind: "event", eventId: "evt-1" }, " 旁白\n 第 2 版\t"))
    ).toBe("[用户关闭了卡片「旁白 第 2 版」]");
  });

  it("names the artifact or event when the card had no title", () => {
    expect(describeCardDismissal(dismissed({ kind: "artifact", artifactId: "art-1" }))).toBe(
      "[用户关闭了卡片（产物 art-1）]"
    );
    expect(describeCardDismissal(dismissed({ kind: "event", eventId: "evt-9" }))).toBe(
      "[用户关闭了卡片（事件 evt-9）]"
    );
  });

  it("follows the message with one line per card, oldest first", () => {
    expect(
      withCardDismissalNotes("把第 2 版再剪短一点", [
        dismissed({ kind: "artifact", artifactId: "art-3" }, "推广片 · 第 3 版"),
        dismissed({ kind: "event", eventId: "evt-err" }, "渲染出错"),
      ])
    ).toBe(
      "把第 2 版再剪短一点\n\n[用户关闭了卡片「推广片 · 第 3 版」]\n[用户关闭了卡片「渲染出错」]"
    );
  });

  it("leaves a message alone when no card was closed", () => {
    expect(withCardDismissalNotes("继续", [])).toBe("继续");
  });
});

describe("card dismissals against SQLite", () => {
  let db: DatabaseSync;
  let sql: SqlStorage;
  let events: EventRepository;
  let messages: MessageRepository;
  let handler: CardDismissHandler;
  let broadcast: ReturnType<typeof vi.fn<SessionMessenger["broadcast"]>>;
  let now: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    sql = storage.sql;
    initSchema(sql);
    events = new EventRepository(sql, storage.transactionSync);
    messages = new MessageRepository(
      sql,
      storage.transactionSync,
      new SessionAttachmentRepository(sql),
      events
    );
    broadcast = vi.fn<SessionMessenger["broadcast"]>();
    now = 1000;
    handler = new CardDismissHandler(
      { getSession: () => ({}) as never },
      events,
      { broadcast },
      () => ++now
    );
    sql.exec(
      "INSERT INTO participants (id, user_id, role, joined_at) VALUES ('author', 'user', 'owner', 1)"
    );
    for (const id of ["msg-1", "msg-2"]) {
      sql.exec(
        `INSERT INTO messages (id, author_id, content, source, status, created_at)
         VALUES (?, 'author', ?, 'web', 'pending', 1)`,
        id,
        id
      );
    }
  });

  afterEach(() => db.close());

  function dismiss(body: unknown): Promise<Response> {
    return handler.dismiss(
      new Request("http://internal/internal/cards/dismiss", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  }

  function startPrompt(messageId: string): boolean {
    return messages.startMessageProcessing(messageId, ++now, {
      type: "user_message",
      content: messageId,
      messageId,
      timestamp: now / 1000,
    });
  }

  function pendingTargets(): CardDismissedEvent["target"][] {
    return messages.listCardDismissalsSinceLastPrompt().map((event) => event.target);
  }

  it("records a dismissal once, in the timeline, and broadcasts it once", async () => {
    const first = await dismiss({
      target: { kind: "artifact", artifactId: "art-3" },
      label: "推广片 · 第 3 版",
    });
    expect(first.status).toBe(200);
    const recorded = {
      type: "card_dismissed",
      target: { kind: "artifact", artifactId: "art-3" },
      label: "推广片 · 第 3 版",
      dismissedAt: 1001,
    };
    await expect(first.json()).resolves.toEqual({ event: recorded, alreadyDismissed: false });
    expect(broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event: recorded });

    const again = await dismiss({
      target: { kind: "artifact", artifactId: "art-3" },
      label: "another title",
    });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ event: recorded, alreadyDismissed: true });
    expect(broadcast).toHaveBeenCalledTimes(1);

    const page = events.listEventPage({ limit: 10, type: "card_dismissed" });
    expect(page.events.map((row) => [row.id, row.message_id, JSON.parse(row.data)])).toEqual([
      ["card_dismissed:artifact:art-3", null, recorded],
    ]);
  });

  it("holds dismissals for the next prompt, and no longer once it is dispatched", async () => {
    await dismiss({ target: { kind: "artifact", artifactId: "art-3" }, label: "推广片 · 第 3 版" });
    await dismiss({ target: { kind: "event", eventId: "evt-err" } });
    expect(pendingTargets()).toEqual([
      { kind: "artifact", artifactId: "art-3" },
      { kind: "event", eventId: "evt-err" },
    ]);

    expect(startPrompt("msg-1")).toBe(true);
    expect(pendingTargets()).toEqual([]);

    // Closed while the agent works: told with the prompt after this one.
    await dismiss({ target: { kind: "artifact", artifactId: "art-4" } });
    // Closing an already-closed card again tells the agent nothing new.
    await dismiss({ target: { kind: "artifact", artifactId: "art-3" } });
    expect(pendingTargets()).toEqual([{ kind: "artifact", artifactId: "art-4" }]);
  });

  it("keeps dismissals pending when a prompt's send fails and it goes back to the queue", async () => {
    await dismiss({ target: { kind: "artifact", artifactId: "art-3" } });

    expect(startPrompt("msg-1")).toBe(true);
    messages.updateMessageToPending("msg-1");
    expect(pendingTargets()).toEqual([{ kind: "artifact", artifactId: "art-3" }]);

    expect(startPrompt("msg-1")).toBe(true);
    expect(pendingTargets()).toEqual([]);
  });

  it("skips a malformed stored dismissal rather than failing the prompt", () => {
    sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES ('card_dismissed:artifact:x', 'card_dismissed', '{"type":"card_dismissed"}', NULL, 1, 1)`
    );
    expect(pendingTargets()).toEqual([]);
  });

  it.each([{}, { target: { kind: "question", questionId: "q-1" } }, null])(
    "rejects an invalid request %#",
    async (body) => {
      expect((await dismiss(body)).status).toBe(400);
      expect(broadcast).not.toHaveBeenCalled();
    }
  );

  it("answers 404 before the session exists", async () => {
    const missing = new CardDismissHandler({ getSession: () => null }, events, { broadcast }, () =>
      Date.now()
    );
    const response = await missing.dismiss(
      new Request("http://internal/internal/cards/dismiss", {
        method: "POST",
        body: JSON.stringify({ target: { kind: "artifact", artifactId: "art-1" } }),
      })
    );
    expect(response.status).toBe(404);
    expect(events.getEventById("card_dismissed:artifact:art-1")).toBeNull();
  });
});
