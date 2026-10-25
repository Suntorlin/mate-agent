/**
 * Questions the agent asks inside a session: where their events live and the
 * text an answer reaches the agent as.
 *
 * A question is one `question` event and, once the user acts on the card,
 * one `question_answered` event. Both rows have fixed ids derived from the
 * question id, so "does it exist" and "was it answered" are primary-key reads
 * and a question needs no table of its own.
 */

import { z } from "zod";
import {
  answerQuestionRequestSchema,
  type AnswerQuestionRequest,
  type QuestionCard,
} from "@open-inspect/shared/types/questions";

export function questionEventId(questionId: string): string {
  return `question:${questionId}`;
}

export function questionAnsweredEventId(questionId: string): string {
  return `question_answered:${questionId}`;
}

/**
 * Body of the internal answer route: the user's answer plus the prompt
 * author the public route resolved, the same fields `/internal/prompt` gets.
 */
export const internalQuestionAnswerRequestSchema = z.object({
  questionId: z.string().min(1),
  answer: answerQuestionRequestSchema,
  author: z.object({
    authorId: z.string(),
    canonicalUserId: z.string().nullable().optional(),
    scmEnrichment: z
      .object({
        userId: z.string().nullable(),
        login: z.string().nullable(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      })
      .optional(),
  }),
});
export type InternalQuestionAnswerRequest = z.infer<typeof internalQuestionAnswerRequestSchema>;

/** `title（value）`, or the title alone when the agent made them the same. */
function labelled(title: string, value: string): string {
  return title === value ? title : `${title}（${value}）`;
}

function optionLabel(question: QuestionCard, value: string): string {
  const option = question.options?.find((candidate) => candidate.value === value);
  return option ? labelled(option.title, value) : value;
}

function bulleted(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

function submittedText(question: QuestionCard, answer: AnswerQuestionRequest): string {
  const value = answer.value;
  const other = answer.other?.trim();
  const record = typeof value === "object" && !Array.isArray(value) ? value : {};
  switch (question.kind) {
    case "single":
    case "voice":
    case "image":
    case "binary":
      if (question.allowOther && other) return `选了「其他」：${other}`;
      return `选了：${optionLabel(question, typeof value === "string" ? value : "")}`;
    case "multi": {
      const picked = (Array.isArray(value) ? value : []).map((item) => optionLabel(question, item));
      if (question.allowOther && other) picked.push(`其他：${other}`);
      return `选了：${picked.join("、")}`;
    }
    case "fields":
      return `填写了：\n${bulleted(
        (question.fields ?? []).map((field) => {
          const filled = record[field.key]?.trim();
          return `${labelled(field.label, field.key)}：${filled ? filled : "（未填）"}`;
        })
      )}`;
    case "multi_question":
      return `选了：\n${bulleted(
        (question.questions ?? []).map((group) => {
          const picked = record[group.key];
          const option = group.options.find((candidate) => candidate.value === picked);
          const shown = option ? labelled(option.label, option.value) : "（未选）";
          return `${labelled(group.label, group.key)}：${shown}`;
        })
      )}`;
    case "confirm_cost":
      return question.cost
        ? `确认花费 ${question.cost.totalCredits} 积分，请继续。`
        : "确认了，请继续。";
    case "upload": {
      const fileIds = answer.fileIds ?? [];
      return (
        `上传了 ${fileIds.length} 个文件（fileId：${fileIds.join("、")}）。` +
        "它们已作为本会话的输入，在 /workspace/inputs/ 下；没看到就运行 library inputs。"
      );
    }
  }
}

/**
 * Whether a prompt is one the platform wrote for the user (what they did
 * with a question card: `questionAnswerText`) rather than their own words.
 */
export function isPlatformWrittenPrompt(content: string): boolean {
  return /^\[(回答 |用户点了|用户关闭了)/.test(content.trimStart());
}

/**
 * The prompt an answer becomes: one line the agent can read without the card
 * (the question's id and title, then what the user did). Values the agent
 * chose are shown with their titles so it can tell which option it meant.
 */
export function questionAnswerText(
  questionId: string,
  question: QuestionCard,
  answer: AnswerQuestionRequest
): string {
  const asked = `${questionId}「${question.title}」`;
  if (answer.action === "dismiss") {
    return `[用户关闭了问题 ${asked}，没有回答，请按你的判断继续]`;
  }
  if (answer.action === "secondary") {
    const value = answer.secondaryValue ?? "";
    const button = question.secondary?.find((candidate) => candidate.value === value);
    return `[用户点了「${button ? labelled(button.label, value) : value}」，问题 ${asked}]`;
  }
  return `[回答 ${asked}] ${submittedText(question, answer)}`;
}
