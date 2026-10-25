import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { TurnCostSource } from "../turn-cost";
import type { Logger } from "../../logger";
import type { MessageRepository } from "../message-repository";
import type { RunningTurnBudgetWatch } from "../running-turn-budget";
import type { SandboxPushService } from "../sandbox-push-service";
import type { SessionWebSocketManager } from "../websocket-manager";
import type { SandboxArtifactEventHandler } from "./artifact.handler";
import type { SandboxEventContext } from "./context";
import type { SandboxExecutionEventHandler } from "./execution.handler";
import type { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxStreamingEventHandler } from "./streaming.handler";

type SandboxEventWithAck = SandboxEvent & { ackId?: string };

/** Event types that require delivery acknowledgement. */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "execution_complete",
  "error",
  "snapshot_ready",
  "push_complete",
  "push_error",
  "sandbox_generation_ready",
  "preservation_prepared",
]);

/**
 * Routes validated sandbox events to their family handlers. Owns exactly the
 * cross-family concerns: arrival logging, the per-event context (one clock
 * reading, one message-attribution resolution), the delivery-ack
 * contract — the ack for a critical event is sent after its handler finishes,
 * and family handlers never see `ackId` — the cost of a turn: the runtime
 * reports its own estimate on `step_finish` and `execution_complete`, and where
 * the gateway's ledger knows better (`turnCosts`) its figure replaces the
 * estimate before any handler, the session budget included, reads it — and,
 * while a turn runs, the prompt for the session budget to look at what the turn
 * has cost so far (`runningTurnBudget`, throttled there). Both figures are the
 * ledger's cumulative cost since the turn started, counted through
 * `messages.reported_cost_usd`, so the end-of-turn figure adds only what the
 * running-turn checks have not already counted.
 */
export class SessionSandboxEventProcessor {
  constructor(
    private readonly log: Logger,
    private readonly messageRepository: MessageRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly streaming: SandboxStreamingEventHandler,
    private readonly artifacts: SandboxArtifactEventHandler,
    private readonly execution: SandboxExecutionEventHandler,
    private readonly runtime: SandboxRuntimeEventHandler,
    private readonly pushService: SandboxPushService,
    private readonly shutdown?: {
      generationReady(event: Extract<SandboxEvent, { type: "sandbox_generation_ready" }>): void;
      prepared(event: Extract<SandboxEvent, { type: "preservation_prepared" }>): void;
    },
    private readonly turnCosts?: TurnCostSource,
    private readonly runningTurnBudget?: Pick<RunningTurnBudgetWatch, "observe">
  ) {}

  /**
   * The cost-bearing events of a turn (`step_finish`, then `execution_complete`) wait for the
   * ledger's answer; they are handled one after the other, as they arrived, so the answer cannot
   * let the completion overtake the step it follows.
   */
  private costEventsDone: Promise<unknown> = Promise.resolve();

  async processSandboxEvent(event: SandboxEventWithAck): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.log.info("Sandbox event", { event_type: event.type });
    }

    const now = Date.now();
    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.messageRepository.getProcessingMessage();
    const context: SandboxEventContext = {
      now,
      messageId: eventMessageId ?? processingMessage?.id ?? null,
      processingMessage,
    };

    if (this.turnCosts && (event.type === "step_finish" || event.type === "execution_complete")) {
      await this.inCostOrder(async () =>
        this.dispatch(await this.withTurnCost(event, context), context)
      );
    } else {
      await this.dispatch(event, context);
    }

    if (this.runningTurnBudget && processingMessage) {
      try {
        this.runningTurnBudget.observe(now);
      } catch (error) {
        this.log.warn("budget.running_turn_observe_failed", {
          event_type: event.type,
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    if (CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(event.ackId);
    }
  }

  private inCostOrder(task: () => Promise<void>): Promise<void> {
    const result = this.costEventsDone.then(task, task);
    this.costEventsDone = result.catch(() => undefined);
    return result;
  }

  /**
   * The event with the cost of its turn as the gateway's ledger has it, or as it came when the
   * ledger has no figure for the turn.
   */
  private async withTurnCost(
    event: SandboxEventWithAck,
    context: SandboxEventContext
  ): Promise<SandboxEventWithAck> {
    if (!this.turnCosts) return event;
    if (event.type !== "step_finish" && event.type !== "execution_complete") return event;
    if (typeof event.messageCostUsd !== "number") return event;
    const startedAt = context.messageId
      ? this.messageRepository.getMessageById(context.messageId)?.started_at
      : null;
    if (!startedAt) return event;
    let usd: number | null;
    try {
      usd = await this.turnCosts.turnCost({ sinceMs: startedAt, untilMs: context.now });
    } catch (error) {
      // A cost source answers null when it has no figure; one that throws must not lose the event.
      this.log.warn("Turn cost lookup failed", {
        event_type: event.type,
        message_id: context.messageId,
        error: error instanceof Error ? error : String(error),
      });
      return event;
    }
    if (usd === null) return event;
    this.log.info("Turn cost from the gateway", {
      event_type: event.type,
      message_id: context.messageId,
      runtime_usd: event.messageCostUsd,
      gateway_usd: usd,
    });
    return event.type === "step_finish"
      ? { ...event, cost: usd, messageCostUsd: usd }
      : { ...event, messageCostUsd: usd };
  }

  private async dispatch(event: SandboxEvent, context: SandboxEventContext): Promise<void> {
    switch (event.type) {
      case "sandbox_generation_ready":
        if (!this.shutdown) {
          throw new Error("Sandbox graceful shutdown event handlers are not configured");
        }
        this.shutdown.generationReady(event);
        return;
      case "preservation_prepared":
        if (!this.shutdown) {
          throw new Error("Sandbox graceful shutdown event handlers are not configured");
        }
        this.shutdown.prepared(event);
        return;
      case "heartbeat":
        this.runtime.handleHeartbeat(context);
        return;
      case "session_title":
        this.runtime.handleSessionTitle(event);
        return;
      case "ready":
        await this.runtime.handleReady(event, context);
        return;
      case "boot_progress":
        this.runtime.handleBootProgress(event, context);
        return;
      case "git_sync":
        this.runtime.handleGitSync(event, context);
        return;
      case "artifact":
        this.artifacts.handleArtifact(event, context);
        return;
      case "token":
        this.streaming.handleToken(event, context);
        return;
      case "context_compacted":
        this.streaming.handleContextCompacted(event, context);
        return;
      case "step_start":
      case "step_finish":
        await this.streaming.handleStep(event, context);
        return;
      case "tool_call":
        this.streaming.handleToolCall(event, context);
        return;
      case "execution_complete":
        await this.execution.handleExecutionComplete(event, context);
        return;
      case "push_complete":
      case "push_error":
        // Observed like any other timeline event; additionally answers the
        // push the sandbox was asked to perform. The settle continuation runs
        // on a microtask, so it cannot observe this dispatch mid-flight.
        this.streaming.recordTimelineEvent(event, context);
        this.pushService.settlePush(event);
        return;
      case "tool_result":
      case "error":
      case "warning":
      case "user_message":
        // Timeline-observer events: persist and broadcast, nothing else.
        this.streaming.recordTimelineEvent(event, context);
        return;
      case "question":
      case "question_answered":
        // Written by the control plane alone (the ask_user route checks the
        // card; the answer route checks the user). A sandbox claiming
        // either would bypass both, so its copy is dropped.
        this.log.warn("Sandbox sent a control-plane-only event", { event_type: event.type });
        return;
      case "snapshot_ready":
        // The bridge's answer to the snapshot command. The lifecycle manager
        // drives the snapshot itself through the provider; all this needs is
        // the delivery ack below, which stops the bridge re-sending it.
        return;
      case "media_generation":
        // Recorded only through POST /sessions/:id/media-generations, which
        // checks the report and merges it into the generation's one row; a
        // copy over the socket would skip both.
        this.log.warn("Sandbox sent a control-plane-only event", { event_type: event.type });
        return;
      case "card_dismissed":
        // Only the session owner closes a card (POST /sessions/:id/cards/dismiss);
        // a sandbox claiming one is ignored, never recorded or told to the agent.
        this.log.warn("sandbox_event.ignored", { event_type: event.type });
        return;
      default:
        // Exhaustive: a new SandboxEvent variant must pick a family here.
        event satisfies never;
        return;
    }
  }

  private sendAck(ackId: string | undefined): void {
    if (!ackId) return;
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "ack", ackId });
    } else {
      this.log.debug("Cannot send ACK: no sandbox socket", { ack_id: ackId });
    }
  }
}
