/**
 * Questions: the agent asks the user something with a card (pick one, fill fields, confirm a
 * spend, upload…), the turn ends, and the user's answer comes back as the next prompt.
 *
 * Three shapes, one per hop:
 * - `askUserInputSchema`: what the agent passes to its `ask_user` tool.
 *   Strict: the card must be renderable for its kind, so a bad call is
 *   refused back to the agent instead of reaching the user.
 * - `questionEventSchema` / `questionAnsweredEventSchema`: the two
 *   timeline events (`sandbox_event`s the control plane writes). Structural
 *   only, so a stored event keeps replaying if the input rules change.
 * - `answerQuestionRequestSchema`: the body of
 *   `POST /sessions/:id/questions/:questionId/answer`.
 */

import { z } from "zod";

/** Caps on what one question may hold; the control plane enforces them when the agent asks. */
export const QUESTION_LIMITS = Object.freeze({
  titleChars: 500,
  fields: 20,
  options: 30,
  questions: 10,
  secondary: 4,
  /** The whole card, serialized. */
  questionBytes: 32 * 1024,
  /** One answered value (a field, the "other" text). */
  answerValueChars: 8_000,
  answerValues: 50,
  fileIds: 20,
});

export const QUESTION_KINDS = [
  "fields",
  "single",
  "multi",
  "voice",
  "image",
  "multi_question",
  "confirm_cost",
  "upload",
  "binary",
] as const;
export const questionKindSchema = z.enum(QUESTION_KINDS);
export type QuestionKind = z.infer<typeof questionKindSchema>;

const text = z.string().min(1);

/** One input of a `fields` card. */
export const questionFieldSchema = z.object({
  key: text,
  label: text,
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  required: z.boolean().optional(),
  help: z.string().optional(),
});
export type QuestionField = z.infer<typeof questionFieldSchema>;

/**
 * One choice of a `single` / `multi` / `voice` / `image` / `binary` card.
 * `artifactId` is the audio to preview (voice) or the picture (image).
 */
export const questionOptionSchema = z.object({
  value: text,
  title: text,
  description: z.string().optional(),
  tag: z.string().optional(),
  aside: z.string().optional(),
  artifactId: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** One option group of a `multi_question` card. */
export const questionGroupSchema = z.object({
  key: text,
  label: text,
  options: z.array(z.object({ value: text, label: text })).min(1),
  defaultValue: z.string().optional(),
});
export type QuestionGroup = z.infer<typeof questionGroupSchema>;

/** The spend a `confirm_cost` card asks the user to approve, in the product's credits. */
export const questionCostSchema = z.object({
  totalCredits: z.number().nonnegative(),
  lines: z.array(z.object({ label: text, credits: z.number() })),
});
export type QuestionCost = z.infer<typeof questionCostSchema>;

/** What an `upload` card accepts (an `accept` attribute, e.g. `video/*,audio/*`). */
export const questionUploadSchema = z.object({
  accept: z.string(),
  hint: z.string().optional(),
});

/** A secondary button (换一批, 都不满意，重画…); pressing it answers with its value. */
export const questionSecondarySchema = z.object({ value: text, label: text });
export type QuestionSecondary = z.infer<typeof questionSecondarySchema>;

/** The card itself: everything but the ids and time the engine adds. */
const questionCardShape = {
  /** The question, shown as the card's heading. */
  title: text,
  kind: questionKindSchema,
  fields: z.array(questionFieldSchema).optional(),
  options: z.array(questionOptionSchema).optional(),
  /** `single` only: a last "其他" row with a text input. */
  allowOther: z.boolean().optional(),
  questions: z.array(questionGroupSchema).optional(),
  cost: questionCostSchema.optional(),
  upload: questionUploadSchema.optional(),
  /** The primary button's label; the card says 「确定」 when absent. */
  submitLabel: z.string().optional(),
  secondary: z.array(questionSecondarySchema).optional(),
};
export const questionCardSchema = z.object(questionCardShape);
export type QuestionCard = z.infer<typeof questionCardSchema>;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

const OPTION_KINDS: ReadonlySet<QuestionKind> = new Set([
  "single",
  "multi",
  "voice",
  "image",
  "binary",
]);

/** Why a card cannot be shown for its kind, one message per problem. */
function cardProblems(card: QuestionCard): { path: string[]; message: string }[] {
  const problems: { path: string[]; message: string }[] = [];
  const limit = (path: string, items: readonly unknown[] | undefined, max: number) => {
    if (items && items.length > max) {
      problems.push({ path: [path], message: `at most ${max} ${path} per question` });
    }
  };
  const unique = (path: string, values: readonly string[], what: string) => {
    const repeated = duplicates(values);
    if (repeated.length > 0) {
      problems.push({ path: [path], message: `${what} must be unique: ${repeated.join(", ")}` });
    }
  };

  if (card.title.length > QUESTION_LIMITS.titleChars) {
    problems.push({
      path: ["title"],
      message: `title is at most ${QUESTION_LIMITS.titleChars} characters`,
    });
  }
  limit("fields", card.fields, QUESTION_LIMITS.fields);
  limit("options", card.options, QUESTION_LIMITS.options);
  limit("questions", card.questions, QUESTION_LIMITS.questions);
  limit("secondary", card.secondary, QUESTION_LIMITS.secondary);
  if (card.secondary) {
    unique(
      "secondary",
      card.secondary.map((button) => button.value),
      "secondary values"
    );
  }

  if (card.kind === "fields") {
    if (!card.fields?.length) {
      problems.push({ path: ["fields"], message: "a fields question needs at least one field" });
    } else {
      unique(
        "fields",
        card.fields.map((field) => field.key),
        "field keys"
      );
    }
  } else if (OPTION_KINDS.has(card.kind)) {
    if (!card.options?.length) {
      problems.push({
        path: ["options"],
        message: `a ${card.kind} question needs at least one option`,
      });
    } else {
      unique(
        "options",
        card.options.map((option) => option.value),
        "option values"
      );
      if (card.kind === "binary" && card.options.length !== 2) {
        problems.push({ path: ["options"], message: "a binary question has exactly 2 options" });
      }
    }
  } else if (card.kind === "multi_question") {
    if (!card.questions?.length) {
      problems.push({
        path: ["questions"],
        message: "a multi_question question needs at least one option group",
      });
    } else {
      unique(
        "questions",
        card.questions.map((group) => group.key),
        "option group keys"
      );
    }
  } else if (card.kind === "confirm_cost") {
    if (!card.cost) {
      problems.push({ path: ["cost"], message: "a confirm_cost question needs cost" });
    }
  } else if (card.kind === "upload") {
    if (!card.upload) {
      problems.push({ path: ["upload"], message: "an upload question needs upload" });
    }
  }

  if (new TextEncoder().encode(JSON.stringify(card)).byteLength > QUESTION_LIMITS.questionBytes) {
    problems.push({
      path: [],
      message: `the question is larger than ${QUESTION_LIMITS.questionBytes} bytes`,
    });
  }
  return problems;
}

/** What the agent passes to `ask_user`: a card that can be shown for its kind. */
export const askUserInputSchema = questionCardSchema.superRefine((card, ctx) => {
  for (const problem of cardProblems(card)) {
    ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
  }
});
export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** What the control plane answers the sandbox once the card is on the user's screen. */
export const askUserResponseSchema = z.object({
  questionId: z.string(),
  messageId: z.string(),
});
export type AskUserResponse = z.infer<typeof askUserResponseSchema>;

/**
 * `question`: a card the agent showed. `messageId` is the turn that asked;
 * `createdAt` is epoch milliseconds, `timestamp` epoch seconds like every
 * other sandbox event.
 */
export const questionEventSchema = z.object({
  type: z.literal("question"),
  questionId: z.string(),
  messageId: z.string(),
  ...questionCardShape,
  createdAt: z.number(),
  timestamp: z.number(),
  ackId: z.string().optional(),
});
export type QuestionEvent = z.infer<typeof questionEventSchema>;

export const QUESTION_ANSWER_ACTIONS = ["submit", "secondary", "dismiss"] as const;
export const questionAnswerActionSchema = z.enum(QUESTION_ANSWER_ACTIONS);
export type QuestionAnswerAction = z.infer<typeof questionAnswerActionSchema>;

const answerText = z.string().max(QUESTION_LIMITS.answerValueChars);

/**
 * The answered value: a string for single / voice / image / binary, the
 * picked values for multi, `{ key: value }` for fields and multi_question.
 */
export const questionAnswerValueSchema = z.union([
  answerText,
  z.array(answerText).max(QUESTION_LIMITS.answerValues),
  z
    .record(z.string(), answerText)
    .refine((value) => Object.keys(value).length <= QUESTION_LIMITS.answerValues, {
      message: `at most ${QUESTION_LIMITS.answerValues} answered values`,
    }),
]);
export type QuestionAnswerValue = z.infer<typeof questionAnswerValueSchema>;

/** Body of `POST /sessions/:id/questions/:questionId/answer`. */
export const answerQuestionRequestSchema = z
  .object({
    action: questionAnswerActionSchema,
    /** `secondary`: the value of the button pressed. */
    secondaryValue: z.string().min(1).optional(),
    value: questionAnswerValueSchema.optional(),
    /** `single` with `allowOther`: what the user typed under 「其他」. */
    other: answerText.optional(),
    /** `upload`: files uploaded through /files and attached to the session as inputs. */
    fileIds: z.array(z.string().min(1).max(128)).max(QUESTION_LIMITS.fileIds).optional(),
  })
  .refine((answer) => answer.action !== "secondary" || answer.secondaryValue !== undefined, {
    message: "secondaryValue is required when action is secondary",
    path: ["secondaryValue"],
  });
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;

/** 200 from the answer route: the prompt the answer started. */
export const answerQuestionResponseSchema = z.object({
  questionId: z.string(),
  /** The new turn the answer was queued as. */
  messageId: z.string(),
  status: z.literal("queued"),
});
export type AnswerQuestionResponse = z.infer<typeof answerQuestionResponseSchema>;

/**
 * `question_answered`: the user answered, pressed a secondary button or
 * closed the card. `messageId` is the turn that asked (the card's own);
 * `answerMessageId` is the prompt the answer was sent as, whose
 * `user_message` carries the text the agent read. `answeredAt` is epoch
 * milliseconds.
 */
export const questionAnsweredEventSchema = z.object({
  type: z.literal("question_answered"),
  questionId: z.string(),
  messageId: z.string(),
  answerMessageId: z.string().optional(),
  action: questionAnswerActionSchema,
  value: questionAnswerValueSchema.optional(),
  other: z.string().optional(),
  secondaryValue: z.string().optional(),
  fileIds: z.array(z.string()).optional(),
  answeredAt: z.number(),
  timestamp: z.number(),
  ackId: z.string().optional(),
});
export type QuestionAnsweredEvent = z.infer<typeof questionAnsweredEventSchema>;

/**
 * Why `answer` does not fit `question`, or null when it does. The card
 * offered fixed choices; an answer naming one it did not offer is refused
 * rather than relayed to the agent as if the user had picked it.
 */
export function questionAnswerProblem(
  question: QuestionCard,
  answer: AnswerQuestionRequest
): string | null {
  if (answer.action === "dismiss") return null;
  if (answer.action === "secondary") {
    const offered = question.secondary?.some((button) => button.value === answer.secondaryValue);
    return offered ? null : `"${answer.secondaryValue}" is not a secondary button of this question`;
  }

  const optionValues = new Set((question.options ?? []).map((option) => option.value));
  const value = answer.value;
  const other = answer.other?.trim();
  switch (question.kind) {
    case "single":
      if (question.allowOther && other) return null;
      if (typeof value !== "string") return "a single question is answered with one value";
      return optionValues.has(value) ? null : `"${value}" is not an option of this question`;
    case "voice":
    case "image":
    case "binary":
      if (typeof value !== "string")
        return `a ${question.kind} question is answered with one value`;
      return optionValues.has(value) ? null : `"${value}" is not an option of this question`;
    case "multi": {
      if (!Array.isArray(value)) return "a multi question is answered with a list of values";
      const unknown = value.filter((item) => !optionValues.has(item));
      if (unknown.length > 0) return `not options of this question: ${unknown.join(", ")}`;
      if (value.length === 0 && !(question.allowOther && other)) {
        return "pick at least one option";
      }
      return null;
    }
    case "fields": {
      if (!isRecord(value)) return "a fields question is answered with { key: value }";
      const fields = question.fields ?? [];
      const keys = new Set(fields.map((field) => field.key));
      const unknown = Object.keys(value).filter((key) => !keys.has(key));
      if (unknown.length > 0) return `not fields of this question: ${unknown.join(", ")}`;
      const missing = fields.filter((field) => field.required && !value[field.key]?.trim());
      if (missing.length > 0) {
        return `required fields are empty: ${missing.map((field) => field.key).join(", ")}`;
      }
      return null;
    }
    case "multi_question": {
      if (!isRecord(value)) return "a multi_question question is answered with { key: value }";
      const groups = new Map((question.questions ?? []).map((group) => [group.key, group]));
      for (const [key, picked] of Object.entries(value)) {
        const group = groups.get(key);
        if (!group) return `"${key}" is not an option group of this question`;
        if (!group.options.some((option) => option.value === picked)) {
          return `"${picked}" is not an option of group "${key}"`;
        }
      }
      return null;
    }
    case "confirm_cost":
      return null;
    case "upload":
      return answer.fileIds?.length ? null : "an upload question is answered with fileIds";
  }
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
