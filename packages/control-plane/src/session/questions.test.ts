import { describe, expect, it } from "vitest";
import type { AnswerQuestionRequest, QuestionCard } from "@open-inspect/shared/types/questions";
import { questionAnswerText } from "./questions";

function text(question: QuestionCard, answer: AnswerQuestionRequest): string {
  return questionAnswerText("q_123", question, answer);
}

describe("questionAnswerText", () => {
  const pace: QuestionCard = {
    title: "节奏想要哪种？",
    kind: "single",
    options: [
      { value: "keep", title: "照原片节奏" },
      { value: "fast", title: "更快" },
    ],
    allowOther: true,
    secondary: [{ value: "more", label: "换一批" }],
  };

  it("names the picked option by its title and value", () => {
    expect(text(pace, { action: "submit", value: "keep" })).toBe(
      "[回答 q_123「节奏想要哪种？」] 选了：照原片节奏（keep）"
    );
  });

  it("shows the 其他 text when the user typed one", () => {
    expect(text(pace, { action: "submit", other: "  跟着音乐的鼓点  " })).toBe(
      "[回答 q_123「节奏想要哪种？」] 选了「其他」：跟着音乐的鼓点"
    );
  });

  it("names a secondary button and the question it was on", () => {
    expect(text(pace, { action: "secondary", secondaryValue: "more" })).toBe(
      "[用户点了「换一批（more）」，问题 q_123「节奏想要哪种？」]"
    );
  });

  it("asks the agent to carry on by itself when the card was closed", () => {
    expect(text(pace, { action: "dismiss" })).toBe(
      "[用户关闭了问题 q_123「节奏想要哪种？」，没有回答，请按你的判断继续]"
    );
  });

  it("lists every pick of a multi question", () => {
    const styles: QuestionCard = {
      title: "要哪些风格？",
      kind: "multi",
      options: [
        { value: "warm", title: "暖色" },
        { value: "grain", title: "胶片颗粒" },
        { value: "Fade", title: "Fade" },
      ],
    };
    expect(text(styles, { action: "submit", value: ["warm", "Fade"] })).toBe(
      "[回答 q_123「要哪些风格？」] 选了：暖色（warm）、Fade"
    );
  });

  it("lists every field, empty ones included", () => {
    const brief: QuestionCard = {
      title: "补充一下信息",
      kind: "fields",
      fields: [
        { key: "brand", label: "品牌名", required: true },
        { key: "slogan", label: "口号" },
      ],
    };
    expect(text(brief, { action: "submit", value: { brand: "小鱼", slogan: " " } })).toBe(
      "[回答 q_123「补充一下信息」] 填写了：\n- 品牌名（brand）：小鱼\n- 口号（slogan）：（未填）"
    );
  });

  it("lists every option group of a multi_question", () => {
    const setup: QuestionCard = {
      title: "几个设置",
      kind: "multi_question",
      questions: [
        {
          key: "ratio",
          label: "画幅",
          options: [
            { value: "9:16", label: "竖屏" },
            { value: "16:9", label: "横屏" },
          ],
        },
        { key: "subs", label: "字幕", options: [{ value: "yes", label: "要" }] },
      ],
    };
    expect(text(setup, { action: "submit", value: { ratio: "9:16" } })).toBe(
      "[回答 q_123「几个设置」] 选了：\n- 画幅（ratio）：竖屏（9:16）\n- 字幕（subs）：（未选）"
    );
  });

  it("confirms the spend the card showed", () => {
    const cost: QuestionCard = {
      title: "确认花费",
      kind: "confirm_cost",
      cost: { totalCredits: 120, lines: [{ label: "3 个镜头", credits: 120 }] },
    };
    expect(text(cost, { action: "submit" })).toBe(
      "[回答 q_123「确认花费」] 确认花费 120 积分，请继续。"
    );
  });

  it("says where uploaded files are", () => {
    const upload: QuestionCard = {
      title: "上传原片",
      kind: "upload",
      upload: { accept: "video/*" },
    };
    expect(text(upload, { action: "submit", fileIds: ["file_a", "file_b"] })).toBe(
      "[回答 q_123「上传原片」] 上传了 2 个文件（fileId：file_a、file_b）。" +
        "它们已作为本会话的输入，在 /workspace/inputs/ 下；没看到就运行 library inputs。"
    );
  });

  it("answers voice, image and binary cards like a single choice", () => {
    for (const kind of ["voice", "image", "binary"] as const) {
      const question: QuestionCard = {
        title: "选哪个？",
        kind,
        options: [
          { value: "a", title: "甲", artifactId: "art-a" },
          { value: "b", title: "乙", artifactId: "art-b" },
        ],
      };
      expect(text(question, { action: "submit", value: "b" })).toBe(
        "[回答 q_123「选哪个？」] 选了：乙（b）"
      );
    }
  });
});
