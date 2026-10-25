/**
 * A product's media generations on the timeline: one card per generation (an image, a video, a
 * voiceover) that shows it running, then succeeded or failed.
 *
 * The agent makes media with the product's tools, and the product, which knows when a generation
 * starts and ends, reports each step to `POST /sessions/:id/media-generations` as the session
 * owner's product (`app` service); the session's sandbox may report one too (sandbox token). The
 * control plane writes it as a `media_generation` event.
 *
 * Two shapes:
 * - `mediaGenerationReportSchema`: what a reporter sends. Strict, with size caps; one report is
 *   one step (submitted, finished, or "this output became that artifact").
 * - `mediaGenerationEventSchema`: the timeline event. One event row per generation, merged from
 *   every report so far, so a reload or a replay shows the generation's latest state; each report
 *   is also broadcast as the merged event. Structural only, so stored events keep replaying if the
 *   report rules change. Clients key cards by `generationId`.
 *
 * A generation goes `running` → `succeeded` | `failed`. A `running` report after the generation
 * finished is ignored; a later finished report replaces the earlier one (a re-poll or a linked
 * artifact adds detail). `costUsd` counts against the session's budget; `credits` is what the
 * product shows for it.
 */

import { z } from "zod";

export const MEDIA_GENERATION_STATUSES = ["running", "succeeded", "failed"] as const;
export const mediaGenerationStatusSchema = z.enum(MEDIA_GENERATION_STATUSES);
export type MediaGenerationStatus = z.infer<typeof mediaGenerationStatusSchema>;

export const MEDIA_GENERATION_KINDS = ["image", "video", "audio"] as const;
export const mediaGenerationKindSchema = z.enum(MEDIA_GENERATION_KINDS);
export type MediaGenerationKind = z.infer<typeof mediaGenerationKindSchema>;

/** `mcp`: made through one of the product's MCP tools; `api`: a script called the same tools over HTTP. */
export const MEDIA_GENERATION_SOURCES = ["api", "mcp"] as const;
export const mediaGenerationSourceSchema = z.enum(MEDIA_GENERATION_SOURCES);
export type MediaGenerationSource = z.infer<typeof mediaGenerationSourceSchema>;

/**
 * Why a generation failed, as a client words it. `message` carries the
 * provider's own words (the hover detail) and `providerCode` its raw code.
 * - `moderation`: the prompt or an input was refused by content review.
 * - `timeout`: the provider did not finish in time.
 * - `provider_error`: the model or its queue failed (e.g. `provider_error`,
 *   `enqueue_failed`; a voiceover that failed and was not charged).
 * - `insufficient_credits`: the product's account cannot pay for it.
 * - `plan_required`: the product's plan does not allow it (video on a free plan,
 *   too many outputs, the free daily image limit).
 * - `canceled`: the generation was canceled.
 * - `unknown`: anything else.
 */
export const MEDIA_GENERATION_FAILURE_CODES = [
  "moderation",
  "timeout",
  "provider_error",
  "insufficient_credits",
  "plan_required",
  "canceled",
  "unknown",
] as const;
export const mediaGenerationFailureCodeSchema = z.enum(MEDIA_GENERATION_FAILURE_CODES);
export type MediaGenerationFailureCode = z.infer<typeof mediaGenerationFailureCodeSchema>;

/** Caps on one report; the control plane enforces them. */
export const MEDIA_GENERATION_LIMITS = Object.freeze({
  generationIdChars: 128,
  labelChars: 120,
  promptChars: 1_000,
  modelChars: 200,
  aspectRatioChars: 32,
  messageChars: 2_000,
  providerCodeChars: 64,
  urlChars: 2_048,
  mimeTypeChars: 100,
  artifactIdChars: 200,
  outputs: 16,
  /** A day; nothing a generation produces is longer. */
  durationMs: 24 * 60 * 60 * 1000,
  /** The whole report, serialized. */
  reportBytes: 32 * 1024,
});

// ---- Timeline event (structural) ----------------------------------------------------

export const mediaGenerationFailureSchema = z.object({
  code: mediaGenerationFailureCodeSchema,
  message: z.string(),
  providerCode: z.string().optional(),
  /** The credits held for it were given back. */
  refunded: z.boolean().optional(),
  /** Resubmitting the identical request may work. */
  retryable: z.boolean().optional(),
});
export type MediaGenerationFailure = z.infer<typeof mediaGenerationFailureSchema>;

/** One output of a generation (an image generation can make several). */
export const mediaGenerationOutputSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  /** Where the provider keeps it (a permanent public https link). */
  url: z.string().optional(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** The session artifact it was uploaded as, once the agent uploaded it. */
  artifactId: z.string().optional(),
  failure: mediaGenerationFailureSchema.optional(),
});
export type MediaGenerationOutput = z.infer<typeof mediaGenerationOutputSchema>;

export const mediaGenerationEventSchema = z.object({
  type: z.literal("media_generation"),
  generationId: z.string(),
  /** The turn the generation started in; later reports keep it. */
  messageId: z.string(),
  status: mediaGenerationStatusSchema,
  mediaKind: mediaGenerationKindSchema,
  source: mediaGenerationSourceSchema,
  /**
   * What it is for: from the agent's request key (e.g. `coffee-shot03`); for a voiceover, the
   * line it speaks, without its delivery tags.
   */
  label: z.string().optional(),
  prompt: z.string().optional(),
  /** Model id; for a voiceover, the voice (its title once it is done). */
  model: z.string().optional(),
  aspectRatio: z.string().optional(),
  durationMs: z.number().optional(),
  /** Outputs requested. */
  count: z.number().optional(),
  /** The product's credits, as it shows them: held while running, net of refunds once finished. */
  credits: z.number().optional(),
  /** What it costs in USD, held and settled like `credits`; it counts against the session's budget. */
  costUsd: z.number().optional(),
  /** The artifact of the first output the agent uploaded. */
  artifactId: z.string().optional(),
  outputs: z.array(mediaGenerationOutputSchema).optional(),
  /** Why it failed; only on `failed`. Failed outputs of a `succeeded` one carry their own. */
  failure: mediaGenerationFailureSchema.optional(),
  /** Epoch milliseconds of the first report. */
  startedAt: z.number(),
  /** Epoch milliseconds it was first reported finished. */
  finishedAt: z.number().optional(),
  /** Epoch seconds of the latest report, like every sandbox event. */
  timestamp: z.number(),
  ackId: z.string().optional(),
});
export type MediaGenerationEvent = z.infer<typeof mediaGenerationEventSchema>;

/** The timeline event id of a generation: one row per generation. */
export function mediaGenerationEventId(generationId: string): string {
  return `media_generation:${generationId}`;
}

// ---- Sandbox report (strict) --------------------------------------------------------

const L = MEDIA_GENERATION_LIMITS;
const shortText = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z
  .string()
  .max(L.urlChars)
  .url()
  .refine((value) => value.startsWith("https://"), { message: "must be an https URL" });

export const mediaGenerationReportFailureSchema = z.strictObject({
  code: mediaGenerationFailureCodeSchema,
  message: z.string().trim().min(1).max(L.messageChars),
  providerCode: shortText(L.providerCodeChars).optional(),
  refunded: z.boolean().optional(),
  retryable: z.boolean().optional(),
});

export const mediaGenerationReportOutputSchema = z.strictObject({
  status: z.enum(["succeeded", "failed"]),
  url: httpsUrl.optional(),
  mimeType: shortText(L.mimeTypeChars).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  artifactId: shortText(L.artifactIdChars).optional(),
  failure: mediaGenerationReportFailureSchema.optional(),
});

export const mediaGenerationReportSchema = z
  .strictObject({
    generationId: z
      .string()
      .max(L.generationIdChars)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "letters, digits and . _ : - only"),
    status: mediaGenerationStatusSchema,
    source: mediaGenerationSourceSchema,
    /** Required for a generation the session has not seen yet. */
    mediaKind: mediaGenerationKindSchema.optional(),
    /** The turn, when the reporter knows it; otherwise the running turn. */
    messageId: shortText(128).optional(),
    label: shortText(L.labelChars).optional(),
    prompt: shortText(L.promptChars).optional(),
    model: shortText(L.modelChars).optional(),
    aspectRatio: shortText(L.aspectRatioChars).optional(),
    durationMs: z.number().int().nonnegative().max(L.durationMs).optional(),
    count: z.number().int().positive().max(L.outputs).optional(),
    credits: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    /** An artifact the agent uploaded one of the outputs as (see `outputIndex`). */
    artifactId: shortText(L.artifactIdChars).optional(),
    /** Which output `artifactId` is; the first when absent. */
    outputIndex: z
      .number()
      .int()
      .nonnegative()
      .max(L.outputs - 1)
      .optional(),
    outputs: z.array(mediaGenerationReportOutputSchema).max(L.outputs).optional(),
    failure: mediaGenerationReportFailureSchema.optional(),
  })
  .superRefine((report, ctx) => {
    if (report.status === "failed" && !report.failure) {
      ctx.addIssue({ code: "custom", path: ["failure"], message: "a failed report needs failure" });
    }
    if (report.status !== "failed" && report.failure) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "only a failed report carries failure",
      });
    }
    if (report.status === "running" && (report.outputs || report.artifactId)) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "a running report has no outputs or artifact yet",
      });
    }
    if (report.outputIndex !== undefined && report.artifactId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["outputIndex"],
        message: "outputIndex names the output artifactId belongs to",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(report)).length > L.reportBytes) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `the report is larger than ${L.reportBytes} bytes`,
      });
    }
  });
export type MediaGenerationReport = z.infer<typeof mediaGenerationReportSchema>;

/**
 * Answer to `POST /sessions/:id/media-generations`: the generation's event
 * after this report. `recorded` is false when the report changed nothing (a
 * `running` report for a generation that already finished).
 */
export const mediaGenerationReportResponseSchema = z.object({
  event: mediaGenerationEventSchema,
  recorded: z.boolean(),
});
export type MediaGenerationReportResponse = z.infer<typeof mediaGenerationReportResponseSchema>;
