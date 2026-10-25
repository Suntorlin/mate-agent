import {
  askUserInputSchema,
  questionAnswerProblem,
  questionEventSchema,
  type QuestionAnsweredEvent,
  type QuestionEvent,
} from "@open-inspect/shared/types/questions";
import type { Logger } from "../../../logger";
import {
  enqueuePromptRequestSchema,
  type EnqueuePromptRequest,
} from "../../enqueue-prompt-contract";
import type { EventRepository } from "../../event-repository";
import {
  questionAnswerText,
  internalQuestionAnswerRequestSchema,
  questionAnsweredEventId,
  questionEventId,
} from "../../questions";
import type { MessageRepository } from "../../message-repository";
import type { SessionMessenger } from "../../messenger";
import { enqueuePromptErrorResponse } from "./messages.handler";

/** The prompt entry an answer goes through: the same one `/internal/prompt` uses. */
export interface QuestionPromptQueue {
  enqueuePrompt(request: EnqueuePromptRequest): Promise<{ messageId: string }>;
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

function parseStored(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * HTTP boundary for the questions the agent asks.
 *
 * `ask`: the agent's `ask_user` call, relayed by the sandbox route. The card
 * is checked, given an id, recorded on the running turn's timeline and shown
 * to everyone watching. The turn itself is not held: the tool tells the
 * agent to end it, and the answer arrives as a new prompt.
 *
 * `answer`: the user acted on the card. The answer is checked against the
 * card, turned into text and queued exactly like a typed prompt; only then is
 * the question marked answered, so a refused prompt (budget, queue full,
 * archived session) leaves the card open to try again.
 */
export class QuestionsHandler {
  /** Questions whose answer is being queued right now; the prompt path awaits. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly events: Pick<EventRepository, "createEvent" | "getEventById">,
    private readonly messages: Pick<MessageRepository, "getProcessingMessage">,
    private readonly messenger: Pick<SessionMessenger, "broadcast">,
    private readonly prompts: QuestionPromptQueue,
    private readonly generateId: () => string,
    private readonly now: () => number = Date.now
  ) {}

  async ask(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!body.ok) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    const parsed = askUserInputSchema.safeParse(body.value);
    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid question",
          issues: parsed.error.issues.map((issue) =>
            issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
          ),
        },
        { status: 400 }
      );
    }
    const turn = this.messages.getProcessingMessage();
    if (!turn) {
      return Response.json(
        { error: "No turn is running; a question can only be asked while answering a prompt" },
        { status: 409 }
      );
    }

    const now = this.now();
    const questionId = `q_${this.generateId()}`;
    const event: QuestionEvent = {
      type: "question",
      questionId,
      messageId: turn.id,
      ...parsed.data,
      createdAt: now,
      timestamp: now / 1000,
    };
    this.events.createEvent({
      id: questionEventId(questionId),
      type: event.type,
      data: JSON.stringify(event),
      messageId: turn.id,
      createdAt: now,
    });
    this.messenger.broadcast({ type: "sandbox_event", event });
    return Response.json({ questionId, messageId: turn.id }, { status: 201 });
  }

  async answer(request: Request, log: Logger): Promise<Response> {
    const body = await readJson(request);
    if (!body.ok) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    const parsed = internalQuestionAnswerRequestSchema.safeParse(body.value);
    if (!parsed.success) return Response.json({ error: "Invalid answer" }, { status: 400 });
    const { questionId, answer, author } = parsed.data;

    const row = this.events.getEventById(questionEventId(questionId));
    if (!row) return Response.json({ error: "Question not found" }, { status: 404 });
    const question = questionEventSchema.safeParse(parseStored(row.data));
    if (!question.success) {
      log.error("question.stored_event_invalid", { question_id: questionId });
      return Response.json({ error: "Question not found" }, { status: 404 });
    }
    if (
      this.answering.has(questionId) ||
      this.events.getEventById(questionAnsweredEventId(questionId))
    ) {
      return Response.json(
        { error: "This question was already answered", code: "QUESTION_ALREADY_ANSWERED" },
        { status: 409 }
      );
    }
    const problem = questionAnswerProblem(question.data, answer);
    if (problem) return Response.json({ error: problem }, { status: 400 });

    const prompt = enqueuePromptRequestSchema.safeParse({
      content: questionAnswerText(questionId, question.data, answer),
      authorId: author.authorId,
      canonicalUserId: author.canonicalUserId,
      source: "web",
      scmEnrichment: author.scmEnrichment,
    });
    if (!prompt.success) return Response.json({ error: "Answer is too long" }, { status: 400 });

    this.answering.add(questionId);
    try {
      let queued: { messageId: string };
      try {
        queued = await this.prompts.enqueuePrompt(prompt.data);
      } catch (error) {
        const refused = enqueuePromptErrorResponse(error);
        if (refused) return refused;
        throw error;
      }

      const now = this.now();
      const event: QuestionAnsweredEvent = {
        type: "question_answered",
        questionId,
        messageId: question.data.messageId,
        answerMessageId: queued.messageId,
        action: answer.action,
        ...(answer.value !== undefined ? { value: answer.value } : {}),
        ...(answer.other !== undefined ? { other: answer.other } : {}),
        ...(answer.secondaryValue !== undefined ? { secondaryValue: answer.secondaryValue } : {}),
        ...(answer.fileIds !== undefined ? { fileIds: answer.fileIds } : {}),
        answeredAt: now,
        timestamp: now / 1000,
      };
      this.events.createEvent({
        id: questionAnsweredEventId(questionId),
        type: event.type,
        data: JSON.stringify(event),
        messageId: question.data.messageId,
        createdAt: now,
      });
      this.messenger.broadcast({ type: "sandbox_event", event });
      log.info("question.answered", {
        question_id: questionId,
        action: answer.action,
        message_id: queued.messageId,
      });
      return Response.json({ questionId, messageId: queued.messageId, status: "queued" });
    } finally {
      this.answering.delete(questionId);
    }
  }
}
