import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import type { BackgroundTasks } from "../../platform-ports";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SessionBudgetService } from "../budget-service";
import type { UsageRepository } from "../usage-repository";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;

/** Turns whose text is still being split; a turn is short-lived, so a few suffice. */
const MAX_TRACKED_TEXT_TURNS = 32;

/**
 * Where a turn's streamed text stands: which compaction generation it is in,
 * the part being written now (`index`; part 0 is the turn's ordinary token
 * row), the text that ended at the last tool call (`sealed`) and the latest
 * cumulative text.
 */
/** Unique within a message: compaction generation and part. */
function turnTextPartId(generation: number, index: number): string {
  return `text-${generation}-${index}`;
}

interface TurnText {
  generation: number;
  index: number;
  sealed: string;
  latest: string;
}

/**
 * Streaming/timeline family: the high-frequency events that narrate an
 * execution (tokens, steps, tool activity, compaction). Every event here is
 * broadcast to clients; the ones with a durable representation also record
 * to the timeline (steps renew activity, accumulate cost, and persist usage). Nothing
 * here transitions session state; a step whose turn has already ended
 * refreshes the metrics projection itself, as no settle for that turn is still
 * to come. Also owns the timeline-observer path (`recordTimelineEvent`) for
 * events that persist and broadcast unchanged.
 *
 * Some harnesses (Claude's) stream one cumulative text per turn, so what the
 * agent said before a tool call would be stored, and shown, after it. Such a
 * turn's text is cut into parts at each tool call: the text before the first
 * tool call stays the turn's ordinary token; after a cut, every token is
 * re-sent as the text since the cut, under a `partId`, and each part keeps the
 * timeline position where it started. Compaction starts the text over as an
 * ordinary token again. Tokens that already carry a `partId` (opencode's)
 * pass through.
 */
export class SandboxStreamingEventHandler {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly eventRepository: EventRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly messenger: SessionMessenger,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly budgetService: SessionBudgetService,
    private readonly usageRepository: UsageRepository,
    private readonly refreshMetricsAfterStep: (messageId: string | null) => void
  ) {}

  private readonly turnTexts = new Map<string, TurnText>();

  handleToken(event: TokenEvent, context: SandboxEventContext): void {
    const messageId = context.messageId;
    const part = messageId && !event.partId ? this.splitTurnText(messageId, event) : event;
    if (!part) return;
    if (messageId) {
      this.eventRepository.upsertTokenEvent(messageId, part, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event: part });
  }

  /** The token as the text written since the turn's last tool call, or null when that is empty. */
  private splitTurnText(messageId: string, event: TokenEvent): TokenEvent | null {
    const turn = this.turnText(messageId);
    turn.latest = event.content;
    if (turn.index === 0) return event;
    const content = event.content.startsWith(turn.sealed)
      ? event.content.slice(turn.sealed.length).replace(/^\s+/, "")
      : event.content;
    if (!content) return null;
    return { ...event, content, partId: turnTextPartId(turn.generation, turn.index) };
  }

  private turnText(messageId: string): TurnText {
    const tracked = this.turnTexts.get(messageId);
    if (tracked) return tracked;
    // After a restart mid-turn the stored text is all that is left of the
    // cut; the harness joins a turn's texts with a blank line.
    const stored = this.eventRepository.listTurnText(messageId);
    const generation = stored.compactions;
    const prefix = turnTextPartId(generation, 0).replace(/0$/, "");
    const parts = stored.parts.filter((part) => part.partId.startsWith(prefix));
    const texts = [stored.text, ...parts.map((part) => part.content)].filter(Boolean) as string[];
    const sealed = texts.join("\n\n");
    const turn: TurnText = {
      generation,
      index: stored.text === null ? 0 : 1 + parts.length,
      sealed,
      latest: sealed,
    };
    this.turnTexts.set(messageId, turn);
    if (this.turnTexts.size > MAX_TRACKED_TEXT_TURNS) {
      const oldest = this.turnTexts.keys().next().value;
      if (oldest !== undefined) this.turnTexts.delete(oldest);
    }
    return turn;
  }

  /** A tool call ends the text written before it: what follows is a new part. */
  private cutTurnText(messageId: string): void {
    const turn = this.turnTexts.get(messageId);
    if (!turn || turn.latest.length <= turn.sealed.length) return;
    if (!turn.latest.startsWith(turn.sealed)) return;
    turn.sealed = turn.latest;
    turn.index += 1;
  }

  handleContextCompacted(
    event: Extract<SandboxEvent, { type: "context_compacted" }>,
    context: SandboxEventContext
  ): void {
    // The harness starts the turn's text over after compaction, as an ordinary token.
    const turn = this.turnTexts.get(event.messageId);
    if (turn) {
      turn.generation += 1;
      turn.index = 0;
      turn.sealed = "";
      turn.latest = "";
    }
    const eventId = generateId();
    this.eventRepository.createContextCompactionEvent({
      id: eventId,
      type: event.type,
      data: JSON.stringify(event),
      messageId: event.messageId,
      createdAt: context.now,
    });
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  async handleStep(
    event: Extract<SandboxEvent, { type: "step_start" | "step_finish" }>,
    context: SandboxEventContext
  ): Promise<void> {
    this.updateLastActivity(context.now);
    this.messenger.broadcast({ type: "sandbox_event", event });
    if (event.type === "step_finish") {
      try {
        let persistenceFailure: { error: unknown } | null = null;
        try {
          this.usageRepository.recordStepUsage(event, context.messageId, context.now);
        } catch (error) {
          persistenceFailure = { error };
        }
        try {
          await this.budgetService.ingestStepFinish(event, context.messageId, context.now);
        } catch (error) {
          if (persistenceFailure) throw persistenceFailure.error;
          throw error;
        }
        if (persistenceFailure) throw persistenceFailure.error;
      } finally {
        // Submitted so a failed refresh is logged at the task boundary rather
        // than replacing the step's own outcome.
        this.backgroundTasks.submit(async () => this.refreshMetricsAfterStep(context.messageId), {
          name: "session_index.refresh_step_metrics",
          context: { message_id: context.messageId },
        });
      }
    }
  }

  handleToolCall(
    event: Extract<SandboxEvent, { type: "tool_call" }>,
    context: SandboxEventContext
  ): void {
    this.updateLastActivity(context.now);
    const messageId = context.messageId;
    if (messageId) {
      this.cutTurnText(messageId);
      this.eventRepository.upsertToolCallEvent(messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });

    if (messageId && !event.truncated?.fields.some((field) => field.startsWith("args."))) {
      this.backgroundTasks.submit(() => this.callbackService.notifyToolCall(messageId, event), {
        name: "callback.notify_tool_call",
        context: { message_id: messageId },
      });
    }
  }

  /**
   * Persist-and-broadcast for the router's timeline-observer cases
   * (`tool_result`, `error`, `warning`, `user_message`, and the push
   * terminal events, which additionally settle `SandboxPushService`).
   */
  recordTimelineEvent(event: SandboxEvent, context: SandboxEventContext): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }
}
