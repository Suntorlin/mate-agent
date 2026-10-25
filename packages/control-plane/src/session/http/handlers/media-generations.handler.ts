import {
  mediaGenerationEventId,
  mediaGenerationEventSchema,
  mediaGenerationReportSchema,
  type MediaGenerationEvent,
  type MediaGenerationReportResponse,
} from "@open-inspect/shared/types/media-generation";
import type { ArtifactRepository } from "../../artifact-repository";
import type { EventRepository } from "../../event-repository";
import { mergeMediaGenerationReport, reportedArtifactIds } from "../../media-generations";
import type { MessageRepository } from "../../message-repository";
import type { SessionMessenger } from "../../messenger";

function parseStored(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * HTTP boundary for a product's media generations: the product reports a generation it started,
 * finished or saw uploaded (relayed by `POST /sessions/:id/media-generations`, as the session
 * owner's product or from the session's sandbox). The report is checked, merged into the
 * generation's one event row (`media-generations.ts`) and the merged event is shown to everyone
 * watching.
 *
 * The reporter chooses nothing but the report: the event type, its row, the turn it belongs to and
 * its times are the session's, and any artifact it names must be one of this session's.
 *
 * A generation's cost (`costUsd`) is part of what the session has spent, and its row is where the
 * session reads it from, so a report that changes it is told to the budget, which stops the turn
 * at the limit.
 */
export class MediaGenerationsHandler {
  constructor(
    private readonly events: Pick<EventRepository, "getEventById" | "upsertMediaGenerationEvent">,
    private readonly messages: Pick<MessageRepository, "getProcessingMessage" | "getMessageById">,
    private readonly artifacts: Pick<ArtifactRepository, "getArtifactById">,
    private readonly messenger: Pick<SessionMessenger, "broadcast">,
    private readonly now: () => number = Date.now,
    /** The generation's cost changed: it counts against the session budget (`observeMediaSpend`). */
    private readonly spendChanged: (
      messageId: string,
      now: number
    ) => Promise<void> = async () => {}
  ) {}

  async report(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = mediaGenerationReportSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid media generation report",
          issues: parsed.error.issues.map((issue) =>
            issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
          ),
        },
        { status: 400 }
      );
    }
    const report = parsed.data;
    const unknownArtifact = reportedArtifactIds(report).find(
      (artifactId) => !this.artifacts.getArtifactById(artifactId)
    );
    if (unknownArtifact) {
      return Response.json(
        { error: `Artifact ${unknownArtifact} is not in this session` },
        { status: 400 }
      );
    }

    const id = mediaGenerationEventId(report.generationId);
    const existing = this.stored(id);
    const messageId = existing?.messageId ?? this.turnFor(report.messageId);
    if (!messageId) {
      return Response.json(
        { error: "No turn is running; a new generation is reported while answering a prompt" },
        { status: 409 }
      );
    }

    const now = this.now();
    const merged = mergeMediaGenerationReport(existing, report, { messageId, now });
    if (merged.kind === "needs_media_kind") {
      return Response.json(
        {
          error: "Invalid media generation report",
          issues: ["mediaKind: required for a generation this session has not seen"],
        },
        { status: 400 }
      );
    }
    if (merged.kind === "unchanged") {
      return Response.json({
        event: merged.event,
        recorded: false,
      } satisfies MediaGenerationReportResponse);
    }

    this.events.upsertMediaGenerationEvent(id, merged.event, now);
    this.messenger.broadcast({ type: "sandbox_event", event: merged.event });
    if (merged.event.costUsd !== existing?.costUsd) await this.spendChanged(messageId, now);
    return Response.json(
      { event: merged.event, recorded: true } satisfies MediaGenerationReportResponse,
      { status: existing ? 200 : 201 }
    );
  }

  private stored(id: string): MediaGenerationEvent | null {
    const row = this.events.getEventById(id);
    if (!row) return null;
    const event = mediaGenerationEventSchema.safeParse(parseStored(row.data));
    return event.success ? event.data : null;
  }

  /** The turn a reporter named, when the session has it; otherwise the running turn. */
  private turnFor(reported: string | undefined): string | null {
    if (reported && this.messages.getMessageById(reported)) return reported;
    return this.messages.getProcessingMessage()?.id ?? null;
  }
}
