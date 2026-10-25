import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { createNodeSqlStorage } from "../../../node/sqlite-storage";
import type { Logger } from "../../../logger";
import type { EnqueuePromptRequest } from "../../enqueue-prompt-contract";
import { EventRepository } from "../../event-repository";
import { questionAnsweredEventId, questionEventId } from "../../questions";
import { BudgetExhaustedError } from "../../message-queue";
import { initSchema } from "../../schema";
import { QuestionsHandler } from "./questions.handler";

const NOW = 1_760_000_000_000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const PACE_QUESTION = {
  title: "节奏想要哪种？",
  kind: "single",
  options: [
    { value: "keep", title: "照原片节奏" },
    { value: "fast", title: "更快", description: "每镜头 1-2 秒" },
  ],
  allowOther: true,
  secondary: [{ value: "more", label: "换一批" }],
};

function post(body: unknown): Request {
  return new Request("http://internal/x", { method: "POST", body: JSON.stringify(body) });
}

describe("QuestionsHandler", () => {
  let db: DatabaseSync;
  let events: EventRepository;
  let turn: { id: string } | null;
  let broadcasts: ServerMessage[];
  let prompts: EnqueuePromptRequest[];
  let enqueue: (request: EnqueuePromptRequest) => Promise<{ messageId: string }>;
  let handler: QuestionsHandler;
  let ids: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    events = new EventRepository(storage.sql, storage.transactionSync);
    turn = { id: "msg-1" };
    broadcasts = [];
    prompts = [];
    ids = 0;
    enqueue = async (request) => {
      prompts.push(request);
      return { messageId: `msg-${prompts.length + 1}` };
    };
    handler = new QuestionsHandler(
      events,
      { getProcessingMessage: () => turn },
      { broadcast: (message) => broadcasts.push(message) },
      { enqueuePrompt: (request) => enqueue(request) },
      () => `id${++ids}`,
      () => NOW
    );
  });

  afterEach(() => db.close());

  async function ask(body: unknown = PACE_QUESTION) {
    const response = await handler.ask(post(body));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function answer(answerBody: unknown, questionId = "q_id1") {
    const response = await handler.answer(
      post({
        questionId,
        answer: answerBody,
        author: { authorId: "app:uid-42", canonicalUserId: "user-1" },
      }),
      log
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  describe("ask", () => {
    it("records the card on the running turn and shows it", async () => {
      const { status, body } = await ask();

      expect(status).toBe(201);
      expect(body).toEqual({ questionId: "q_id1", messageId: "msg-1" });
      const row = events.getEventById(questionEventId("q_id1"));
      expect(row).toMatchObject({ type: "question", message_id: "msg-1", created_at: NOW });
      const stored = JSON.parse(row!.data);
      expect(stored).toEqual({
        type: "question",
        questionId: "q_id1",
        messageId: "msg-1",
        ...PACE_QUESTION,
        createdAt: NOW,
        timestamp: NOW / 1000,
      });
      // The timeline and the live socket read it with the shared sandbox event schema.
      expect(sandboxEventSchema.parse(stored)).toEqual(stored);
      expect(broadcasts).toEqual([{ type: "sandbox_event", event: stored }]);
    });

    it("tells the agent what is wrong with a card it cannot show", async () => {
      const { status, body } = await ask({
        title: "选一个",
        kind: "binary",
        options: [{ value: "a", title: "A" }],
      });

      expect(status).toBe(400);
      expect(body.issues).toEqual(["options: a binary question has exactly 2 options"]);
      expect(broadcasts).toEqual([]);
    });

    it("refuses a question outside a turn", async () => {
      turn = null;

      const { status } = await ask();

      expect(status).toBe(409);
      expect(events.getEventById(questionEventId("q_id1"))).toBeNull();
    });
  });

  describe("answer", () => {
    beforeEach(async () => {
      await ask();
      broadcasts = [];
    });

    it("queues the answer as the owner's prompt and marks the question answered", async () => {
      const { status, body } = await answer({ action: "submit", value: "keep" });

      expect(status).toBe(200);
      expect(body).toEqual({ questionId: "q_id1", messageId: "msg-2", status: "queued" });
      expect(prompts).toEqual([
        {
          content: "[回答 q_id1「节奏想要哪种？」] 选了：照原片节奏（keep）",
          authorId: "app:uid-42",
          canonicalUserId: "user-1",
          source: "web",
        },
      ]);
      const row = events.getEventById(questionAnsweredEventId("q_id1"));
      expect(row).toMatchObject({ type: "question_answered", message_id: "msg-1" });
      const stored = JSON.parse(row!.data);
      expect(stored).toEqual({
        type: "question_answered",
        questionId: "q_id1",
        messageId: "msg-1",
        answerMessageId: "msg-2",
        action: "submit",
        value: "keep",
        answeredAt: NOW,
        timestamp: NOW / 1000,
      });
      expect(sandboxEventSchema.parse(stored)).toEqual(stored);
      expect(broadcasts).toEqual([{ type: "sandbox_event", event: stored }]);
    });

    it("relays a secondary button and a dismissal", async () => {
      await answer({ action: "secondary", secondaryValue: "more" });
      await ask();
      await answer({ action: "dismiss" }, "q_id2");

      expect(prompts.map((prompt) => prompt.content)).toEqual([
        "[用户点了「换一批（more）」，问题 q_id1「节奏想要哪种？」]",
        "[用户关闭了问题 q_id2「节奏想要哪种？」，没有回答，请按你的判断继续]",
      ]);
    });

    it("answers a question once", async () => {
      await answer({ action: "submit", value: "keep" });

      const second = await answer({ action: "submit", value: "fast" });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe("QUESTION_ALREADY_ANSWERED");
      expect(prompts).toHaveLength(1);
    });

    it("refuses a second answer while the first is still being queued", async () => {
      let release!: () => void;
      enqueue = (request) =>
        new Promise((resolve) => {
          prompts.push(request);
          release = () => resolve({ messageId: "msg-2" });
        });

      const first = answer({ action: "submit", value: "keep" });
      const second = await answer({ action: "dismiss" });
      release();

      expect(second.status).toBe(409);
      expect((await first).status).toBe(200);
      expect(prompts).toHaveLength(1);
    });

    it("answers 404 for a question this session never asked", async () => {
      const { status } = await answer({ action: "dismiss" }, "q_unknown");

      expect(status).toBe(404);
      expect(prompts).toEqual([]);
    });

    it.each([
      ["an option the card did not offer", { action: "submit", value: "slow" }],
      ["a secondary button the card did not have", { action: "secondary", secondaryValue: "x" }],
      ["a list for a single choice", { action: "submit", value: ["keep"] }],
    ])("rejects %s and leaves the question open", async (_name, body) => {
      const { status } = await answer(body);

      expect(status).toBe(400);
      expect(prompts).toEqual([]);
      expect(events.getEventById(questionAnsweredEventId("q_id1"))).toBeNull();
    });

    it("leaves the question open when the prompt is refused", async () => {
      enqueue = async () => {
        throw new BudgetExhaustedError();
      };

      const refused = await answer({ action: "submit", value: "keep" });

      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("BUDGET_EXHAUSTED");
      expect(events.getEventById(questionAnsweredEventId("q_id1"))).toBeNull();
      expect(broadcasts).toEqual([]);

      enqueue = async () => ({ messageId: "msg-9" });
      expect((await answer({ action: "submit", value: "keep" })).status).toBe(200);
    });
  });
});
