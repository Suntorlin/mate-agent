/**
 * A product's media generations inside a session: how a report becomes the generation's
 * `media_generation` event (see `@open-inspect/shared/types/media-generation`).
 *
 * A generation is one event row (`media_generation:<generationId>`), so a
 * reload or a replay shows its latest state at the place it started. Each
 * report is merged into that row:
 * - The first report fixes the turn (`messageId`), `startedAt`, and where it
 *   came from (`source`); it must say what kind of media it is.
 * - `running` after the generation finished changes nothing: reports of one
 *   generation can arrive out of order (two reporters, retries).
 * - A finished report replaces the outcome (status, outputs, failure); a
 *   later one wins, so a re-poll or a linked upload adds detail. A failure
 *   whose reason is `unknown` does not replace one that had a reason.
 * - A `succeeded` generation shows what it made. A success with no succeeded
 *   output, for a generation that has none yet (a status poll that knows only
 *   the outcome), does not finish it: the card keeps running, with the
 *   report's details, until a report brings the outputs. One that already
 *   finished stays as it was.
 * - Details a report leaves out (model, prompt, …) keep their earlier value.
 */

import type {
  MediaGenerationEvent,
  MediaGenerationOutput,
  MediaGenerationReport,
  MediaGenerationStatus,
} from "@open-inspect/shared/types/media-generation";

export function isFinishedGeneration(status: MediaGenerationStatus): boolean {
  return status !== "running";
}

const DETAIL_FIELDS = [
  "label",
  "prompt",
  "model",
  "aspectRatio",
  "durationMs",
  "count",
  "credits",
  "costUsd",
] as const satisfies readonly (keyof MediaGenerationReport & keyof MediaGenerationEvent)[];

export type MediaGenerationMerge =
  | { kind: "recorded"; event: MediaGenerationEvent }
  | { kind: "unchanged"; event: MediaGenerationEvent }
  | { kind: "needs_media_kind" };

/**
 * Outputs of a finished report, keeping the artifact an earlier report linked
 * to the same output (same position, same URL) when this one does not name it.
 */
function mergedOutputs(
  previous: readonly MediaGenerationOutput[] | undefined,
  next: readonly MediaGenerationOutput[] | undefined
): MediaGenerationOutput[] | undefined {
  if (!next) return previous ? [...previous] : undefined;
  return next.map((output, index) => {
    const before = previous?.[index];
    if (output.artifactId || !before?.artifactId || before.url !== output.url) return output;
    return { ...output, artifactId: before.artifactId };
  });
}

/** `report.artifactId` placed on the output it names (the first by default). */
function withLinkedArtifact(
  outputs: MediaGenerationOutput[] | undefined,
  report: MediaGenerationReport
): MediaGenerationOutput[] | undefined {
  if (!report.artifactId || !outputs) return outputs;
  const index = report.outputIndex ?? 0;
  if (!outputs[index]) return outputs;
  return outputs.map((output, position) =>
    position === index ? { ...output, artifactId: report.artifactId } : output
  );
}

/**
 * The generation's event after `report`. `existing` is its stored event, if
 * any; `context.messageId` is the turn a new generation belongs to.
 */
export function mergeMediaGenerationReport(
  existing: MediaGenerationEvent | null,
  report: MediaGenerationReport,
  context: { messageId: string; now: number }
): MediaGenerationMerge {
  if (existing && isFinishedGeneration(existing.status) && report.status === "running") {
    return { kind: "unchanged", event: existing };
  }
  const mediaKind = report.mediaKind ?? existing?.mediaKind;
  if (!mediaKind) return { kind: "needs_media_kind" };

  const outputs = withLinkedArtifact(mergedOutputs(existing?.outputs, report.outputs), report);
  const artifactId =
    outputs?.find((output) => output.artifactId)?.artifactId ??
    existing?.artifactId ??
    report.artifactId;
  const showsNothing =
    report.status === "succeeded" &&
    !artifactId &&
    !outputs?.some((output) => output.status === "succeeded");
  if (showsNothing && existing && isFinishedGeneration(existing.status)) {
    return { kind: "unchanged", event: existing };
  }
  const status: MediaGenerationStatus = showsNothing ? "running" : report.status;

  const finished = isFinishedGeneration(status);
  const event: MediaGenerationEvent = {
    type: "media_generation",
    generationId: report.generationId,
    messageId: existing?.messageId ?? context.messageId,
    status,
    mediaKind,
    source: existing?.source ?? report.source,
    startedAt: existing?.startedAt ?? context.now,
    timestamp: context.now / 1000,
  };
  for (const field of DETAIL_FIELDS) {
    const value = report[field] ?? existing?.[field];
    if (value !== undefined) Object.assign(event, { [field]: value });
  }

  if (outputs && finished) event.outputs = outputs;
  if (artifactId && finished) event.artifactId = artifactId;

  if (report.status === "failed" && report.failure) {
    // A status poll knows only that it failed; the result already said why.
    const known = existing?.failure;
    event.failure =
      report.failure.code === "unknown" && known && known.code !== "unknown"
        ? known
        : report.failure;
  }
  if (finished) {
    event.finishedAt =
      existing && isFinishedGeneration(existing.status) && existing.finishedAt !== undefined
        ? existing.finishedAt
        : context.now;
  }
  return { kind: "recorded", event };
}

/** Every artifact a report names, so the session can check they are its own. */
export function reportedArtifactIds(report: MediaGenerationReport): string[] {
  const ids = new Set<string>();
  if (report.artifactId) ids.add(report.artifactId);
  for (const output of report.outputs ?? []) {
    if (output.artifactId) ids.add(output.artifactId);
  }
  return [...ids];
}
