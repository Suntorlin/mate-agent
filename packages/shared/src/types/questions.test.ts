import { describe, expect, it } from "vitest";
import {
  answerQuestionRequestSchema,
  askUserInputSchema,
  questionAnswerProblem,
  type QuestionCard,
} from "./questions";
import { eventTypeSchema, sandboxEventSchema } from "./sandbox-events";
import { serverMessageSchema } from "./server-messages";

function issues(input: unknown): string[] {
  const result = askUserInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const options = [
  { value: "a", title: "A" },
  { value: "b", title: "B" },
];

describe("askUserInputSchema", () => {
  it.each([
    ["fields", { fields: [{ key: "name", label: "名字", required: true }] }],
    ["single", { options, allowOther: true }],
    ["multi", { options }],
    ["voice", { options: [{ value: "v1", title: "温柔女声", artifactId: "art-1" }] }],
    ["image", { options: [{ value: "i1", title: "封面一", artifactId: "art-2" }] }],
    [
      "multi_question",
      { questions: [{ key: "ratio", label: "画幅", options: [{ value: "9:16", label: "竖屏" }] }] },
    ],
    ["confirm_cost", { cost: { totalCredits: 120, lines: [{ label: "镜头", credits: 120 }] } }],
    ["upload", { upload: { accept: "video/*", hint: "原片" } }],
    ["binary", { options }],
  ])("accepts a %s card", (kind, card) => {
    expect(
      issues({ title: "问题", kind, ...card, secondary: [{ value: "x", label: "X" }] })
    ).toEqual([]);
  });

  it.each([
    ["fields", {}, "a fields question needs at least one field"],
    ["single", {}, "a single question needs at least one option"],
    ["binary", { options: [options[0]] }, "a binary question has exactly 2 options"],
    ["multi_question", {}, "a multi_question question needs at least one option group"],
    ["confirm_cost", {}, "a confirm_cost question needs cost"],
    ["upload", {}, "an upload question needs upload"],
    ["single", { options: [options[0], options[0]] }, "option values must be unique: a"],
  ])("refuses a %s card the creator could not answer", (kind, card, message) => {
    expect(issues({ title: "问题", kind, ...card })).toContain(message);
  });

  it("refuses an unknown kind and an empty title", () => {
    expect(issues({ title: "", kind: "slider" })).toHaveLength(2);
  });
});

describe("answerQuestionRequestSchema", () => {
  it.each([
    { action: "submit", value: "a" },
    { action: "submit", value: ["a", "b"] },
    { action: "submit", value: { name: "小鱼" } },
    { action: "submit", other: "别的" },
    { action: "submit", fileIds: ["file-1"] },
    { action: "secondary", secondaryValue: "more" },
    { action: "dismiss" },
  ])("accepts %j", (body) => {
    expect(answerQuestionRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { action: "skip" },
    { action: "secondary" },
    { action: "submit", value: 3 },
    { action: "submit", value: { n: 1 } },
  ])("refuses %j", (body) => {
    expect(answerQuestionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("questionAnswerProblem", () => {
  const single: QuestionCard = { title: "?", kind: "single", options, allowOther: true };

  it("accepts an offered option, the 其他 text, a dismissal and an offered button", () => {
    const withButton = { ...single, secondary: [{ value: "more", label: "换一批" }] };
    expect(questionAnswerProblem(single, { action: "submit", value: "a" })).toBeNull();
    expect(questionAnswerProblem(single, { action: "submit", other: "c" })).toBeNull();
    expect(questionAnswerProblem(single, { action: "dismiss" })).toBeNull();
    expect(
      questionAnswerProblem(withButton, { action: "secondary", secondaryValue: "more" })
    ).toBeNull();
  });

  it("refuses what the card did not offer", () => {
    expect(questionAnswerProblem(single, { action: "submit", value: "z" })).toMatch(
      /not an option/
    );
    expect(questionAnswerProblem(single, { action: "secondary", secondaryValue: "more" })).toMatch(
      /not a secondary button/
    );
    expect(
      questionAnswerProblem(
        { title: "?", kind: "multi", options },
        { action: "submit", value: ["a", "z"] }
      )
    ).toMatch(/not options of this question: z/);
  });

  it("requires the required fields", () => {
    const fields: QuestionCard = {
      title: "?",
      kind: "fields",
      fields: [
        { key: "brand", label: "品牌", required: true },
        { key: "slogan", label: "口号" },
      ],
    };
    expect(questionAnswerProblem(fields, { action: "submit", value: { slogan: "x" } })).toMatch(
      /required fields are empty: brand/
    );
    expect(
      questionAnswerProblem(fields, { action: "submit", value: { brand: "鱼", other: "x" } })
    ).toMatch(/not fields of this question: other/);
    expect(questionAnswerProblem(fields, { action: "submit", value: { brand: "鱼" } })).toBeNull();
  });

  it("requires files for an upload and nothing for a cost confirmation", () => {
    const upload: QuestionCard = { title: "?", kind: "upload", upload: { accept: "*/*" } };
    expect(questionAnswerProblem(upload, { action: "submit" })).toMatch(/fileIds/);
    expect(questionAnswerProblem(upload, { action: "submit", fileIds: ["f"] })).toBeNull();
    expect(
      questionAnswerProblem({ title: "?", kind: "confirm_cost" }, { action: "submit" })
    ).toBeNull();
  });
});

describe("question events on the wire", () => {
  const question = {
    type: "question",
    questionId: "q_1",
    messageId: "msg-1",
    title: "节奏想要哪种？",
    kind: "single",
    options,
    createdAt: 1_760_000_000_000,
    timestamp: 1_760_000_000,
  };
  const answered = {
    type: "question_answered",
    questionId: "q_1",
    messageId: "msg-1",
    answerMessageId: "msg-2",
    action: "submit",
    value: "a",
    answeredAt: 1_760_000_001_000,
    timestamp: 1_760_000_001,
  };

  it("are sandbox events a client can receive and list", () => {
    expect(sandboxEventSchema.parse(question)).toEqual(question);
    expect(sandboxEventSchema.parse(answered)).toEqual(answered);
    expect(serverMessageSchema.parse({ type: "sandbox_event", event: question })).toEqual({
      type: "sandbox_event",
      event: question,
    });
    expect(eventTypeSchema.options).toEqual(
      expect.arrayContaining(["question", "question_answered"])
    );
  });
});
