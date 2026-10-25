import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { EventRepository } from "./event-repository";
import type {
  ExecutionStopCoordinator,
  ExecutionStopPreparation,
} from "./execution-stop-coordinator";
import type { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";

interface BudgetTransition {
  warningEvent: Extract<SandboxEvent, { type: "warning" }> | null;
  stopPreparation: ExecutionStopPreparation | null;
  statusChanged: boolean;
}

const NO_BUDGET_TRANSITION: BudgetTransition = {
  warningEvent: null,
  stopPreparation: null,
  statusChanged: false,
};

type StepFinishEvent = Extract<SandboxEvent, { type: "step_finish" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

/**
 * Cost accounting is idempotent by construction. The runtime reports the
 * cumulative cost of the current turn (`messageCostUsd`) on every step and on
 * `execution_complete`; the session total only ever moves by the amount that
 * report exceeds the highest one already recorded for the message. A resent
 * event therefore adds nothing and a dropped one is repaired by the next.
 *
 * Runtimes that predate the cumulative field still report a per-step `cost`,
 * which is added directly; that path undercounts on a dropped event.
 *
 * The budget covers everything the session spends: the model's cost (`total_cost`, from the
 * reports above) plus the media the product generated for it (`mediaCostUsd`: what its media
 * generations hold or were charged). The two come from different ledgers (the gateway's calls, and
 * the generations' own records) and never overlap. `spentUsd` is their sum: what clients show as
 * used and what the limit is compared with.
 */
export class SessionBudgetService {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: Pick<
      MessageRepository,
      "raiseReportedCost" | "getRunningTurnCost"
    >,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly executionStop: Pick<ExecutionStopCoordinator, "prepare" | "deliver">,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly generateId: () => string,
    /** USD of the session's media generations; 0 where a session generates none. */
    private readonly mediaCostUsd: () => number = () => 0
  ) {}

  /** What the session has spent against its budget. */
  spentUsd(): number {
    return (this.repository.getSession()?.total_cost ?? 0) + this.mediaCostUsd();
  }

  async ingestStepFinish(
    event: StepFinishEvent,
    messageId: string | null,
    now: number
  ): Promise<void> {
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      const delta = this.observeReportedCost(event, messageId);
      if (delta > 0) {
        const totalCost = this.repository.addSessionCost(delta, now);
        transition = { ...this.applyObservedCost(totalCost, messageId, now), statusChanged: true };
      }
    });
    await this.deliverTransition(transition);
  }

  /** Synchronous so completion and cost can share the caller's storage transaction. */
  observeExecutionCost(event: ExecutionCompleteEvent, now: number): BudgetTransition {
    if (typeof event.messageCostUsd !== "number") return NO_BUDGET_TRANSITION;
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      const delta = this.messageRepository.raiseReportedCost(
        event.messageId,
        event.messageCostUsd as number
      );
      if (delta <= 0) return;
      const totalCost = this.repository.addSessionCost(delta, now);
      transition = {
        ...this.applyObservedCost(totalCost, event.messageId, now),
        statusChanged: true,
      };
    });
    return transition;
  }

  /**
   * The running turn's model use so far, by the gateway's ledger, counted like a report from the
   * runtime: the session total grows by what it exceeds the highest figure already recorded for
   * the turn, so the runtime's own report at the end of the turn adds only what is still missing,
   * and a spent budget stops the turn as an end-of-turn report would. Nothing happens once the
   * turn is no longer the one running (its end has reported the cost, or a new turn has begun and
   * the ledger's window would hold its calls too).
   */
  async observeRunningTurnSpend(messageId: string, spentUsd: number, now: number): Promise<void> {
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      if (this.messageRepository.getRunningTurnCost()?.messageId !== messageId) return;
      const delta = this.messageRepository.raiseReportedCost(messageId, spentUsd);
      if (delta <= 0) return;
      const totalCost = this.repository.addSessionCost(delta, now);
      transition = { ...this.applyObservedCost(totalCost, messageId, now), statusChanged: true };
    });
    await this.deliverTransition(transition);
  }

  /**
   * A media generation was reported and its cost changed (held at submission, settled when it
   * finished, refunded when it failed): it counts against the budget from now. Nothing is added to
   * the session total, which holds the model's cost alone; the generations' own records are the
   * media's ledger, so a re-report of one generation cannot count it twice. A generation that takes
   * the session to the limit stops the turn as a cost report would.
   */
  async observeMediaSpend(messageId: string | null, now: number): Promise<void> {
    let transition: BudgetTransition = { ...NO_BUDGET_TRANSITION, statusChanged: true };
    this.repository.transaction(() => {
      const session = this.repository.getSession();
      if (!session) return;
      transition = {
        ...this.applyObservedCost(session.total_cost, messageId, now),
        statusChanged: true,
      };
    });
    await this.deliverTransition(transition);
  }

  async updateLimit(maxCostUsd: number | null, now: number): Promise<void> {
    const session = this.repository.getSession();
    if (!session || Object.is(session.max_cost_usd, maxCostUsd)) return;

    const spent = session.total_cost + this.mediaCostUsd();
    const exhausted = maxCostUsd !== null && spent >= maxCostUsd;
    const transition = this.repository.transaction(() => {
      this.repository.setSessionBudget(maxCostUsd, exhausted, now);
      if (exhausted && session.budget_exhausted !== 1) {
        return this.prepareExhaustion(spent, maxCostUsd, null, now);
      }
      return { ...NO_BUDGET_TRANSITION, statusChanged: true };
    });
    await this.deliverTransition(transition);
    if (!exhausted) await this.processMessageQueue();
  }

  broadcastStatus(): void {
    const session = this.repository.getSession();
    if (!session) return;
    this.messenger.broadcast({
      type: "budget_status",
      totalCost: session.total_cost + this.mediaCostUsd(),
      maxSessionCostUsd: session.max_cost_usd,
      budgetExhausted: session.budget_exhausted === 1,
    });
  }

  /** Amount the session total should grow by for this step; 0 for resends. */
  private observeReportedCost(event: StepFinishEvent, messageId: string | null): number {
    if (typeof event.messageCostUsd === "number" && Number.isFinite(event.messageCostUsd)) {
      const target = messageId ?? event.messageId;
      return this.messageRepository.raiseReportedCost(target, event.messageCostUsd);
    }
    if (typeof event.cost === "number" && Number.isFinite(event.cost) && event.cost > 0) {
      return event.cost;
    }
    return 0;
  }

  /** `totalCost` is the model cost just recorded; the media's share is added here. */
  private applyObservedCost(
    totalCost: number,
    messageId: string | null,
    now: number
  ): BudgetTransition {
    const session = this.repository.getSession();
    const spent = totalCost + this.mediaCostUsd();
    if (
      !session ||
      session.max_cost_usd === null ||
      session.budget_exhausted === 1 ||
      spent < session.max_cost_usd
    ) {
      return NO_BUDGET_TRANSITION;
    }

    this.repository.markBudgetExhausted(now);
    return this.prepareExhaustion(spent, session.max_cost_usd, messageId, now);
  }

  /** Prepare the same exhaustion effects for cost reports and live limit edits. */
  private prepareExhaustion(
    spent: number,
    limit: number,
    messageId: string | null,
    now: number
  ): BudgetTransition {
    const reason = `Session cost limit reached: ${formatCost(spent)} of ${formatCost(limit)}`;
    const stopPreparation = this.executionStop.prepare(reason, now);
    return {
      warningEvent: this.persistWarning(
        `${reason}. ${stopPreparation ? "Execution stopped." : "Work paused."}`,
        messageId,
        now
      ),
      stopPreparation,
      statusChanged: true,
    };
  }

  /** Deliver only after the transaction containing the observation has committed. */
  async deliverTransition(transition: BudgetTransition): Promise<void> {
    if (transition.warningEvent) {
      this.messenger.broadcast({ type: "sandbox_event", event: transition.warningEvent });
    }
    if (transition.statusChanged) this.broadcastStatus();
    if (transition.stopPreparation) {
      await this.executionStop.deliver(transition.stopPreparation);
    }
  }

  private persistWarning(
    message: string,
    messageId: string | null,
    now: number
  ): Extract<SandboxEvent, { type: "warning" }> {
    const event: Extract<SandboxEvent, { type: "warning" }> = {
      type: "warning",
      scope: "budget",
      message,
      timestamp: now / 1000,
    };
    this.eventRepository.createEvent({
      id: this.generateId(),
      type: "warning",
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });
    return event;
  }
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}
