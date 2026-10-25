import { describe, expect, it } from "vitest";
import {
  MEDIA_GENERATION_LIMITS,
  mediaGenerationEventId,
  mediaGenerationEventSchema,
  mediaGenerationReportSchema,
} from "./media-generation";
import { eventTypeSchema, sandboxEventSchema } from "./sandbox-events";
import * as shared from "../index";

const RUNNING = {
  generationId: "6f1c2b3a-9d0e-4f11-8a22-0b1c2d3e4f50",
  status: "running",
  source: "mcp",
  mediaKind: "video",
  label: "coffee-shot03",
  model: "seedance-1-0-pro",
  aspectRatio: "9:16",
  durationMs: 5000,
  credits: 120,
  costUsd: 0.0018,
} as const;

function issues(input: unknown): string[] {
  const result = mediaGenerationReportSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("mediaGenerationReportSchema", () => {
  it("accepts a running, a failed, a succeeded and a link report", () => {
    expect(issues(RUNNING)).toEqual([]);
    expect(
      issues({
        generationId: "submit-toolu_01",
        status: "failed",
        source: "api",
        mediaKind: "image",
        failure: {
          code: "insufficient_credits",
          message: "Insufficient credits",
          providerCode: "insufficient_credits",
          retryable: false,
        },
      })
    ).toEqual([]);
    expect(
      issues({
        generationId: "tts-toolu_02",
        status: "succeeded",
        source: "mcp",
        mediaKind: "audio",
        credits: 42,
        outputs: [{ status: "succeeded", url: "https://cdn.example.com/a.mp3" }],
      })
    ).toEqual([]);
    expect(
      issues({
        generationId: RUNNING.generationId,
        status: "succeeded",
        source: "mcp",
        artifactId: "art-1",
        outputIndex: 1,
      })
    ).toEqual([]);
  });

  it("ties failure to failed and outputs to a finished generation", () => {
    expect(issues({ ...RUNNING, status: "failed" })).toEqual([
      "failure: a failed report needs failure",
    ]);
    expect(
      issues({ ...RUNNING, status: "succeeded", failure: { code: "unknown", message: "x" } })
    ).toEqual(["failure: only a failed report carries failure"]);
    expect(issues({ ...RUNNING, outputs: [{ status: "succeeded" }] })).toEqual([
      "status: a running report has no outputs or artifact yet",
    ]);
    expect(issues({ ...RUNNING, status: "succeeded", outputIndex: 0 })).toEqual([
      "outputIndex: outputIndex names the output artifactId belongs to",
    ]);
  });

  it("refuses unknown fields, odd ids, plain http outputs and unknown codes", () => {
    expect(issues({ ...RUNNING, type: "question" })).toEqual([': Unrecognized key: "type"']);
    expect(issues({ ...RUNNING, generationId: "../etc" })).toEqual([
      "generationId: letters, digits and . _ : - only",
    ]);
    expect(
      issues({
        ...RUNNING,
        status: "succeeded",
        outputs: [{ status: "succeeded", url: "http://cdn.example.com/a.png" }],
      })
    ).toEqual(["outputs.0.url: must be an https URL"]);
    expect(
      issues({ ...RUNNING, status: "failed", failure: { code: "nsfw", message: "x" } })
    ).toHaveLength(1);
    expect(issues({ ...RUNNING, costUsd: -0.01 })).toHaveLength(1);
  });

  it("caps the report's size", () => {
    expect(
      issues({
        ...RUNNING,
        generationId: "g".repeat(MEDIA_GENERATION_LIMITS.generationIdChars + 1),
      })
    ).toHaveLength(1);
    const outputs = Array.from({ length: MEDIA_GENERATION_LIMITS.outputs + 1 }, () => ({
      status: "succeeded",
    }));
    expect(issues({ ...RUNNING, status: "succeeded", outputs })).toHaveLength(1);
    const bigFailure = {
      code: "unknown",
      message: "x".repeat(MEDIA_GENERATION_LIMITS.messageChars),
    };
    const many = Array.from({ length: MEDIA_GENERATION_LIMITS.outputs }, () => ({
      status: "failed",
      failure: bigFailure,
    }));
    expect(issues({ ...RUNNING, status: "failed", failure: bigFailure, outputs: many })).toEqual([
      `: the report is larger than ${MEDIA_GENERATION_LIMITS.reportBytes} bytes`,
    ]);
  });
});

describe("media_generation event", () => {
  const event = {
    type: "media_generation",
    generationId: RUNNING.generationId,
    messageId: "msg-1",
    status: "failed",
    mediaKind: "video",
    source: "mcp",
    model: "seedance-1-0-pro",
    failure: { code: "moderation", message: "Prompt rejected", refunded: true },
    outputs: [{ status: "failed", failure: { code: "moderation", message: "Prompt rejected" } }],
    startedAt: 1_760_000_000_000,
    finishedAt: 1_760_000_030_000,
    timestamp: 1_760_000_030,
  };

  it("is a sandbox event the timeline and event pages carry", () => {
    expect(mediaGenerationEventSchema.parse(event)).toEqual(event);
    expect(sandboxEventSchema.parse(event)).toEqual(event);
    expect(eventTypeSchema.parse("media_generation")).toBe("media_generation");
  });

  it("has one row per generation", () => {
    expect(mediaGenerationEventId("gen-1")).toBe("media_generation:gen-1");
  });

  it("is exported from the package root", () => {
    expect(shared.mediaGenerationEventSchema).toBe(mediaGenerationEventSchema);
    expect(shared.MEDIA_GENERATION_FAILURE_CODES).toEqual([
      "moderation",
      "timeout",
      "provider_error",
      "insufficient_credits",
      "plan_required",
      "canceled",
      "unknown",
    ]);
  });
});
