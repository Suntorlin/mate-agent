import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import { SessionSandboxEventProcessor } from "./processor";
import { SandboxArtifactEventHandler } from "./artifact.handler";
import { SandboxExecutionEventHandler } from "./execution.handler";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import { SandboxPushService } from "../sandbox-push-service";
import { SandboxStreamingEventHandler } from "./streaming.handler";
import type { GitPushSpec } from "../../source-control";
import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { TurnCostSource } from "../turn-cost";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { SessionDiffService } from "../diffs/service";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SandboxRepository } from "../sandbox-repository";
import type { ArtifactRepository } from "../artifact-repository";
import type { EventRepository } from "../event-repository";
import type { MessageRepository, TerminalMessageStatus } from "../message-repository";
import type { SessionStatusService } from "../session-status-service";
import type { SandboxCommandTarget, SessionWebSocketManager } from "../websocket-manager";
import type { SessionBudgetService } from "../budget-service";
import { UsageRepository } from "../usage-repository";
import { initSchema } from "../schema";

function createPushSpec(repoOwner: string, repoName: string, targetBranch: string): GitPushSpec {
  return {
    remoteUrl: `https://token@example.com/${repoOwner}/${repoName}.git`,
    redactedRemoteUrl: `https://***@example.com/${repoOwner}/${repoName}.git`,
    refspec: `HEAD:refs/heads/${targetBranch}`,
    targetBranch,
    repoOwner,
    repoName,
    force: false,
  };
}

function createProcessor(
  shutdown?: {
    generationReady(event: Extract<SandboxEvent, { type: "sandbox_generation_ready" }>): void;
    prepared(event: Extract<SandboxEvent, { type: "preservation_prepared" }>): void;
  },
  persistedUsage?: UsageRepository,
  turnCosts?: TurnCostSource,
  runningTurnBudget?: { observe(now: number): void }
) {
  const getProcessingMessage = vi.fn(() => null as { id: string } | null);
  const getMessageById = vi.fn((_id: string) => null as { started_at: number | null } | null);
  const repository = {
    getMessageById,
    updateSandboxHeartbeat: vi.fn(),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    recordBootProgress: vi.fn(() => true),
    getSession: vi.fn(() => null),
    getProcessingMessage,
    getMessageContent: vi.fn(() => null as string | null),
    addSessionCost: vi.fn(() => 1.25),
    recordMessageCompletion: vi.fn((event: { messageId: string }, completedAt: number) => {
      getProcessingMessage.mockReturnValue(null);
      return {
        messageId: event.messageId,
        messageCreatedAt: 1000,
        messageStartedAt: 1100,
        completedAt,
        status: "completed" as const,
      };
    }),
    clearMessageAwaitingStopConfirmation: vi.fn(),
    updateSandboxGitSyncStatus: vi.fn(),
    updateSessionCurrentSha: vi.fn(),
  };
  const eventRepository = {
    upsertTokenEvent: vi.fn(),
    listTurnText: vi.fn(() => ({
      text: null as string | null,
      parts: [] as Array<{ partId: string; content: string }>,
      compactions: 0,
    })),
    createContextCompactionEvent: vi.fn(),
    upsertToolCallEvent: vi.fn(),
    createEvent: vi.fn(),
  } as unknown as EventRepository;
  const artifactRepository = { createArtifact: vi.fn() } as unknown as ArtifactRepository;

  const callbackService = {
    notifyToolCall: vi.fn(async () => {}),
    notifyComplete: vi.fn(async () => {}),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    getSandboxCommandTarget: vi.fn(
      (): SandboxCommandTarget => ({
        kind: "unavailable",
      })
    ),
    send: vi.fn(() => true),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const diffService = { pinBaselines: vi.fn() };
  const triggerSnapshot = vi.fn(async (_reason: string) => {});
  const projectTerminalMessage = vi.fn(async () => {});
  const statusService = {
    reconcileAfterExecution: vi.fn(async (_outcome: TerminalMessageStatus) => {}),
  };
  const scheduleInactivityCheck = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const broadcastPromptQueue = vi.fn();
  const updateLastActivity = vi.fn();
  const refreshSlackActivity = vi.fn();
  const applySessionTitleUpdate = vi.fn((title: string) => ({ ok: true as const, title }));
  const offerFallbackTitle = vi.fn((_title: string) => {});
  const rememberTurn = vi.fn(async (_messageId: string) => {});
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const backgroundTasks = createTestBackgroundTasks();
  const budgetService = {
    ingestStepFinish: vi.fn(async () => {}),
    observeExecutionCost: vi.fn((_event: unknown, _now: number) => ({
      warningEvent: null,
      stopPreparation: null,
      statusChanged: false,
    })),
    deliverTransition: vi.fn(async () => {}),
  };
  const usageRepository = { recordStepUsage: vi.fn() };
  const refreshMetricsAfterStep = vi.fn((_messageId: string | null) => {});

  // The real family composition, mirroring components.ts, so the suite keeps
  // pinning end-to-end processSandboxEvent behavior across the split.
  const pushService = new SandboxPushService(log, wsManager as unknown as SessionWebSocketManager);
  const processor = new SessionSandboxEventProcessor(
    log,
    repository as unknown as MessageRepository,
    wsManager as unknown as SessionWebSocketManager,
    new SandboxStreamingEventHandler(
      backgroundTasks,
      eventRepository,
      callbackService as unknown as CallbackNotificationService,
      messenger,
      updateLastActivity,
      budgetService as unknown as SessionBudgetService,
      persistedUsage ?? (usageRepository as unknown as UsageRepository),
      refreshMetricsAfterStep
    ),
    new SandboxArtifactEventHandler(
      artifactRepository,
      eventRepository,
      messenger,
      updateLastActivity
    ),
    new SandboxExecutionEventHandler(
      backgroundTasks,
      log,
      repository as unknown as MessageRepository,
      callbackService as unknown as CallbackNotificationService,
      messenger,
      projectTerminalMessage,
      statusService as unknown as SessionStatusService,
      triggerSnapshot,
      updateLastActivity,
      scheduleInactivityCheck,
      processMessageQueue,
      broadcastPromptQueue,
      budgetService,
      (closure) => closure(),
      offerFallbackTitle,
      rememberTurn
    ),
    new SandboxRuntimeEventHandler(
      repository as unknown as SessionCoreRepository,
      repository as unknown as SandboxRepository,
      eventRepository,
      messenger,
      diffService as unknown as SessionDiffService,
      applySessionTitleUpdate,
      updateLastActivity,
      refreshSlackActivity,
      scheduleInactivityCheck,
      backgroundTasks,
      { processMessageQueue, reconcileProcessingMessage: vi.fn() },
      log,
      { onRuntimeReady: vi.fn(() => false) }
    ),
    pushService,
    shutdown,
    turnCosts,
    runningTurnBudget
  );

  return {
    processor,
    pushService,
    offerFallbackTitle,
    rememberTurn,
    artifactRepository,
    repository,
    eventRepository,
    wsManager,
    callbackService,
    broadcast,
    diffService,
    triggerSnapshot,
    projectTerminalMessage,
    statusService,
    scheduleInactivityCheck,
    processMessageQueue,
    broadcastPromptQueue,
    updateLastActivity,
    refreshSlackActivity,
    applySessionTitleUpdate,
    backgroundTasks,
    log,
    budgetService,
    usageRepository,
    refreshMetricsAfterStep,
  };
}

describe("SessionSandboxEventProcessor", () => {
  it("releases the next prompt without waiting for diff work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledOnce();
  });

  it("hands a turn that finished well to memory, and no other", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });
    await h.backgroundTasks.settle();
    expect(h.rememberTurn).toHaveBeenCalledExactlyOnceWith("msg-1");

    for (const outcome of [
      { success: false, error: "boom" },
      { success: false, error: "Task was cancelled", stopped: true as const },
    ]) {
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-2" });
      await h.processor.processSandboxEvent({
        type: "execution_complete",
        messageId: "msg-2",
        sandboxId: "sb-1",
        timestamp: 3000,
        ...outcome,
      });
    }
    // A completion for a message that is no longer processing settles nothing.
    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-3",
      success: true,
      sandboxId: "sb-1",
      timestamp: 4000,
    });
    await h.backgroundTasks.settle();
    expect(h.rememberTurn).toHaveBeenCalledOnce();
  });

  it("logs when the post-completion snapshot fails", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.triggerSnapshot.mockRejectedValue(new Error("snapshot backend down"));

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    await h.backgroundTasks.settle();
    // The failed snapshot is absorbed by the boundary, not thrown at the caller.
    expect(h.backgroundTasks.failures).toEqual([expect.any(Error)]);
  });

  it("updates heartbeat without broadcasting", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "heartbeat",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateSandboxHeartbeat).toHaveBeenCalledWith(expect.any(Number));
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("applies session_title without storing a timeline event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "session_title",
      title: "Generated title",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.applySessionTitleUpdate).toHaveBeenCalledWith("Generated title", {
      onlyIfUnset: true,
      replaceFallback: true,
    });
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });

  it("ignores a card dismissal claimed by the sandbox", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "card_dismissed",
      target: { kind: "artifact", artifactId: "art-1" },
      dismissedAt: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("pins diff baselines on ready", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.diffService.pinBaselines).toHaveBeenCalledWith(event);
  });

  it("records the reported runtime version on ready", async () => {
    const h = createProcessor();

    await h.processor.processSandboxEvent({
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
      runtimeVersion: "v59-opencode-1-18-18",
    });

    expect(h.repository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(
      "v59-opencode-1-18-18"
    );
  });

  it("records a null runtime version when the sandbox reports none", async () => {
    const h = createProcessor();

    // A replacement sandbox that reports nothing must not inherit its
    // predecessor's version, or a snapshot it takes is stamped with a runtime
    // that never produced it. Spawn clears the column; this write keeps it
    // clear rather than filling it in.
    await h.processor.processSandboxEvent({
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
    });

    expect(h.repository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(null);
  });

  it("persists token event and broadcasts it", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "token",
      content: "abc",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.eventRepository.upsertTokenEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  describe("a turn's cumulative text", () => {
    const token = (content: string, extra: Partial<SandboxEvent> = {}): SandboxEvent =>
      ({
        type: "token",
        content,
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        ...extra,
      }) as SandboxEvent;
    const toolCall = (callId: string): SandboxEvent =>
      ({
        type: "tool_call",
        tool: "Bash",
        args: {},
        callId,
        status: "running",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      }) as SandboxEvent;
    const stored = (h: ReturnType<typeof createProcessor>) =>
      vi
        .mocked(h.eventRepository.upsertTokenEvent)
        .mock.calls.map(([, event]) => [
          (event as { partId?: string }).partId,
          (event as { content: string }).content,
        ]);

    it("is cut at each tool call, so what was said before a tool stays before it", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent(token("先查余额。"));
      await h.processor.processSandboxEvent(toolCall("call-1"));
      await h.processor.processSandboxEvent(toolCall("call-1")); // its completion update
      await h.processor.processSandboxEvent(token("先查余额。\n\n最便宜的是 mini"));
      await h.processor.processSandboxEvent(token("先查余额。\n\n最便宜的是 mini。"));
      await h.processor.processSandboxEvent(toolCall("call-2"));
      await h.processor.processSandboxEvent(token("先查余额。\n\n最便宜的是 mini。\n\n完成。"));

      expect(stored(h)).toEqual([
        [undefined, "先查余额。"],
        ["text-0-1", "最便宜的是 mini"],
        ["text-0-1", "最便宜的是 mini。"],
        ["text-0-2", "完成。"],
      ]);
    });

    it("sends nothing for a token that adds no text after a cut", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent(token("一段话"));
      await h.processor.processSandboxEvent(toolCall("call-1"));
      await h.processor.processSandboxEvent(token("一段话\n\n"));

      expect(stored(h)).toEqual([[undefined, "一段话"]]);
    });

    it("leaves tokens that already name their part alone", async () => {
      const h = createProcessor();
      const event = token("opencode part", { partId: "part-9" } as Partial<SandboxEvent>);
      await h.processor.processSandboxEvent(event);
      await h.processor.processSandboxEvent(toolCall("call-1"));

      expect(h.eventRepository.upsertTokenEvent).toHaveBeenCalledWith(
        "msg-1",
        event,
        expect.any(Number)
      );
    });

    it("picks up after a restart from the text already stored", async () => {
      const h = createProcessor();
      vi.mocked(h.eventRepository.listTurnText).mockReturnValue({
        text: "先查余额。",
        parts: [{ partId: "text-0-1", content: "最便宜的是 mini。" }],
        compactions: 0,
      });
      await h.processor.processSandboxEvent(token("先查余额。\n\n最便宜的是 mini。\n\n完成。"));

      expect(stored(h)).toEqual([["text-0-2", "完成。"]]);
    });

    it("starts over as an ordinary token after compaction, with parts that cannot collide", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent(token("压缩前"));
      await h.processor.processSandboxEvent(toolCall("call-1"));
      await h.processor.processSandboxEvent(token("压缩前\n\n第二段"));
      await h.processor.processSandboxEvent({
        type: "context_compacted",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      } as SandboxEvent);
      await h.processor.processSandboxEvent(token("压缩后"));
      await h.processor.processSandboxEvent(toolCall("call-2"));
      await h.processor.processSandboxEvent(token("压缩后\n\n再一段"));

      expect(stored(h)).toEqual([
        [undefined, "压缩前"],
        ["text-0-1", "第二段"],
        [undefined, "压缩后"],
        ["text-1-1", "再一段"],
      ]);
    });
  });

  it("persists each context compaction marker and broadcasts it", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "context_compacted",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);
    await h.processor.processSandboxEvent({ ...event, timestamp: 1001 });

    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenCalledTimes(2);
    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenNthCalledWith(1, {
      id: expect.any(String),
      type: "context_compacted",
      data: JSON.stringify(event),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenNthCalledWith(2, {
      id: expect.any(String),
      type: "context_compacted",
      data: JSON.stringify({ ...event, timestamp: 1001 }),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, { type: "sandbox_event", event });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: { ...event, timestamp: 1001 },
    });
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });

  it("persists artifact events into artifacts and broadcasts both channels", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "artifact",
      artifactType: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: {
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      },
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.artifactRepository.createArtifact).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: JSON.stringify({
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      }),
      createdAt: expect.any(Number),
    });
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "artifact",
      data: expect.any(String),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, {
      type: "artifact_created",
      artifact: {
        id: expect.any(String),
        type: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 512,
        },
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "artifact",
        artifactType: "screenshot",
        messageId: "msg-1",
        sandboxId: "sb-1",
        url: "sessions/session-1/media/artifact-1.png",
      }),
    });
  });

  describe("a turn's cost from the gateway's ledger", () => {
    const stepFinish = (): SandboxEvent => ({
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 2000,
      cost: 0.16,
      messageCostUsd: 0.16,
    });
    const completion = (): SandboxEvent => ({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2001,
      messageCostUsd: 0.16,
    });
    const withLedger = (turnCost: TurnCostSource["turnCost"]) => {
      const h = createProcessor(undefined, undefined, { turnCost });
      h.repository.getMessageById.mockReturnValue({ started_at: 1_000 });
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
      return h;
    };

    it("replaces the runtime's estimate before the budget and the timeline read it", async () => {
      const turnCost = vi.fn(async () => 0.0099);
      const h = withLedger(turnCost);

      await h.processor.processSandboxEvent(stepFinish());

      expect(turnCost).toHaveBeenCalledWith({ sinceMs: 1_000, untilMs: expect.any(Number) });
      const corrected = expect.objectContaining({ cost: 0.0099, messageCostUsd: 0.0099 });
      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        corrected,
        "msg-1",
        expect.any(Number)
      );
      expect(h.usageRepository.recordStepUsage).toHaveBeenCalledWith(
        corrected,
        "msg-1",
        expect.any(Number)
      );
      expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event: corrected });
    });

    it("corrects the completion's cost the same way", async () => {
      const h = withLedger(async () => 0.0099);

      await h.processor.processSandboxEvent(completion());

      expect(h.budgetService.observeExecutionCost).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.0099 }),
        expect.any(Number)
      );
    });

    it("keeps the runtime's figure when the ledger has none", async () => {
      const h = withLedger(async () => null);

      await h.processor.processSandboxEvent(stepFinish());
      await h.processor.processSandboxEvent(completion());

      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        expect.objectContaining({ cost: 0.16, messageCostUsd: 0.16 }),
        "msg-1",
        expect.any(Number)
      );
      expect(h.budgetService.observeExecutionCost).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.16 }),
        expect.any(Number)
      );
    });

    it("leaves other events, and events that carry no cost, alone and unasked", async () => {
      const turnCost = vi.fn(async () => 0.0099);
      const h = withLedger(turnCost);

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1500,
      });
      await h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 2000,
        cost: 0.5,
      });
      h.repository.getMessageById.mockReturnValue({ started_at: null });
      await h.processor.processSandboxEvent(stepFinish());

      expect(
        turnCost,
        "no cumulative cost, or no start of the turn, no question"
      ).not.toHaveBeenCalled();
      expect(h.budgetService.ingestStepFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ cost: 0.16 }),
        "msg-1",
        expect.any(Number)
      );
    });

    it("handles the step before the completion even when the step's answer is slower", async () => {
      const answers = [
        new Promise<number>((resolve) => setTimeout(() => resolve(0.01), 20)),
        Promise.resolve(0.02),
      ];
      const h = withLedger(async () => answers.shift() ?? null);

      await Promise.all([
        h.processor.processSandboxEvent(stepFinish()),
        h.processor.processSandboxEvent(completion()),
      ]);

      const [step] = h.budgetService.ingestStepFinish.mock.invocationCallOrder;
      const [complete] = h.budgetService.observeExecutionCost.mock.invocationCallOrder;
      expect(step).toBeLessThan(complete);
      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.01 }),
        "msg-1",
        expect.any(Number)
      );
      expect(h.budgetService.observeExecutionCost).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.02 }),
        expect.any(Number)
      );
    });

    it("handles the event with the runtime's figure when the lookup itself throws", async () => {
      const turnCost = vi
        .fn<TurnCostSource["turnCost"]>()
        .mockRejectedValueOnce(new Error("lookup blew up"))
        .mockResolvedValueOnce(0.02);
      const h = withLedger(turnCost);

      await h.processor.processSandboxEvent(stepFinish());
      await h.processor.processSandboxEvent(completion());

      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        expect.objectContaining({ cost: 0.16, messageCostUsd: 0.16 }),
        "msg-1",
        expect.any(Number)
      );
      expect(h.budgetService.observeExecutionCost).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.02 }),
        expect.any(Number)
      );
      expect(h.log.warn).toHaveBeenCalledWith(
        "Turn cost lookup failed",
        expect.objectContaining({ event_type: "step_finish" })
      );
    });
  });

  it("routes step_finish through atomic budget ingestion", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: 0.0123,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.usageRepository.recordStepUsage).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
  });

  it("records step usage before budget delivery rejects", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const storage = createNodeSqlStorage(db);
      initSchema(storage.sql);
      const usage = new UsageRepository(storage.sql, storage.transactionSync);
      const h = createProcessor(undefined, usage);
      const event: SandboxEvent = {
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        tokens: { input: 10 },
      };
      h.budgetService.ingestStepFinish.mockRejectedValueOnce(new Error("stop failed"));

      await expect(h.processor.processSandboxEvent(event)).rejects.toThrow("stop failed");
      expect(usage.listStepUsage(null, 10).items).toEqual([
        expect.objectContaining({ messageId: "msg-1", inputTokens: 10 }),
      ]);
      expect(usage.getSessionTotals().rowCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "ingests cost and preserves the usage error when budget delivery rejects: %s",
    async (budgetRejects) => {
      const h = createProcessor();
      const event: SandboxEvent = {
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        cost: 0.25,
      };
      const persistenceError = new Error("usage write failed");
      h.usageRepository.recordStepUsage.mockImplementationOnce(() => {
        throw persistenceError;
      });
      if (budgetRejects) {
        h.budgetService.ingestStepFinish.mockRejectedValueOnce(new Error("budget delivery failed"));
      }

      await expect(h.processor.processSandboxEvent(event)).rejects.toBe(persistenceError);
      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        event,
        "msg-1",
        expect.any(Number)
      );
    }
  );

  it("keeps a recorded step's result when refreshing its metrics fails", async () => {
    const h = createProcessor();
    const refreshError = new Error("Malformed persisted session row");
    h.refreshMetricsAfterStep.mockImplementation(() => {
      throw refreshError;
    });

    await expect(
      h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        tokens: { input: 10 },
      })
    ).resolves.toBeUndefined();
    expect(h.backgroundTasks.failures).toEqual([refreshError]);
  });

  it("reports the usage error rather than a failed metrics refresh", async () => {
    const h = createProcessor();
    const persistenceError = new Error("usage write failed");
    h.usageRepository.recordStepUsage.mockImplementationOnce(() => {
      throw persistenceError;
    });
    h.refreshMetricsAfterStep.mockImplementation(() => {
      throw new Error("Malformed persisted session row");
    });

    await expect(
      h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        cost: 0.25,
      })
    ).rejects.toBe(persistenceError);
  });

  it("records unavailable cost tracking for positive-token steps without cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      tokens: { input: 10 },
    };

    await h.processor.processSandboxEvent(event);

    expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
  });

  it("does not add session cost for step_finish with NaN cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.NaN,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
  });

  it("does not add session cost for step_finish with negative cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: -0.05,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
  });

  it("does not add session cost for step_finish with Infinity cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.POSITIVE_INFINITY,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
      event,
      "msg-1",
      expect.any(Number)
    );
  });

  it("completes processing message and schedules post-completion work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      event,
      expect.any(Number),
      "processing"
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.broadcastPromptQueue).toHaveBeenCalledOnce();
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith("msg-1", true, undefined);
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith("completed");
    expect(h.repository.recordMessageCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      h.projectTerminalMessage.mock.invocationCallOrder[0]
    );
    expect(h.projectTerminalMessage.mock.invocationCallOrder[0]).toBeLessThan(
      h.broadcastPromptQueue.mock.invocationCallOrder[0]
    );
    expect(h.broadcastPromptQueue.mock.invocationCallOrder[0]).toBeLessThan(
      h.callbackService.notifyComplete.mock.invocationCallOrder[0]
    );
    expect(h.callbackService.notifyComplete.mock.invocationCallOrder[0]).toBeLessThan(
      h.statusService.reconcileAfterExecution.mock.invocationCallOrder[0]
    );
    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.scheduleInactivityCheck).toHaveBeenCalledTimes(1);
    expect(h.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(h.backgroundTasks.submissions).not.toHaveLength(0);
  });

  it("offers the prompt's first line as the title once the turn settles", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.repository.getMessageContent.mockReturnValue("Fix the flaky checkout test\nIt times out.");

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    // Always offered: whether the title is still unset is decided by the
    // atomic write behind the callback, never by a second read here.
    expect(h.repository.getMessageContent).toHaveBeenCalledWith("msg-1");
    expect(h.offerFallbackTitle).toHaveBeenCalledWith("Fix the flaky checkout test");
  });

  it("offers no title when the prompt has no usable text", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.repository.getMessageContent.mockReturnValue("  \n\t ");

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    expect(h.offerFallbackTitle).not.toHaveBeenCalled();
  });

  it("offers no title from a link or from a card's answer", async () => {
    for (const content of [
      "https://www.instagram.com/reel/Dc_RhWSB-Qg/?utm_source=ig_web_copy_link",
      "[回答 q_e91f「想做哪种版本？」] 选了：制作拆解版（breakdown）",
    ]) {
      const h = createProcessor();
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
      h.repository.getMessageContent.mockReturnValue(content);

      await h.processor.processSandboxEvent({
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
      });

      expect(h.offerFallbackTitle).not.toHaveBeenCalled();
    }
  });

  it("offers no title for a completion with no processing owner", async () => {
    const h = createProcessor();
    h.repository.getMessageContent.mockReturnValue("A late prompt");

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-late",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    expect(h.repository.getMessageContent).not.toHaveBeenCalled();
    expect(h.offerFallbackTitle).not.toHaveBeenCalled();
  });

  it("waits for terminal projection before snapshot, queue drain, and acknowledgement", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
    let resolveCompletion!: () => void;
    h.projectTerminalMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      })
    );

    const processing = h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2,
      ackId: "ack-1",
    });

    expect(h.triggerSnapshot).not.toHaveBeenCalled();
    expect(h.processMessageQueue).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();

    resolveCompletion();
    await processing;

    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "ack", ackId: "ack-1" });
  });

  it("delegates a late terminal event with no processing owner", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-current" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: false,
      sandboxId: "sb-1",
      timestamp: 2_000,
    });

    expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
    expect(h.repository.clearMessageAwaitingStopConfirmation).toHaveBeenCalledWith("msg-1");
  });

  it("delegates a failed sandbox completion", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-failed" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-failed",
      success: false,
      error: "Agent failed",
      sandboxId: "sb-1",
      timestamp: 2_000,
    });

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg-failed", success: false }),
      expect.any(Number),
      "processing"
    );
  });

  it("keeps a refused turn's reason on its record and broadcast, and logs it", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-refused" });
    const event = sandboxEventSchema.parse({
      type: "execution_complete",
      messageId: "msg-refused",
      success: false,
      error:
        "API Error: Request rejected (429) · You've used this month's AI budget ($20.13 of $20.00). [llm_budget=user resets_at=2026-11-01T00:00:00.000Z]",
      errorCode: "model_budget_user",
      resetsAt: "2026-11-01T00:00:00.000Z",
      sandboxId: "sb-1",
      timestamp: 2_000,
    });

    await h.processor.processSandboxEvent(event);

    const reason = { errorCode: "model_budget_user", resetsAt: "2026-11-01T00:00:00.000Z" };
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining(reason),
      expect.any(Number),
      "processing"
    );
    expect(h.broadcast).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: expect.objectContaining(reason),
    });
    expect(h.log.info).toHaveBeenCalledWith(
      "prompt.complete",
      expect.objectContaining({ outcome: "failure", error_code: "model_budget_user" })
    );
  });

  it("resolves pending push when push_complete event arrives", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "dispatch", socket: sandboxWs });

    const pushPromise = h.pushService.pushBranchToRemote(
      createPushSpec("acme", "web", "feature/test")
    );

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "feature/test",
      repoOwner: "acme",
      repoName: "web",
      timestamp: 1000,
    });

    await expect(pushPromise).resolves.toEqual({ success: true });
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "push" })
    );
  });

  describe("activity tracking for intermediate events", () => {
    it("resets activity timer on tool_call", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "tool_call",
        tool: "bash",
        args: { command: "ls" },
        callId: "call-1",
        status: "running",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
      expect(h.eventRepository.upsertToolCallEvent).toHaveBeenCalledWith(
        "msg-1",
        expect.objectContaining({ callId: "call-1", status: "running" }),
        expect.any(Number)
      );
    });

    it("notifies tool_call regardless of status (provider-agnostic)", async () => {
      // Anthropic lifecycle uses status="running"; OpenAI's Responses API may
      // only emit status="completed". Both should reach notifyToolCall so the
      // service-level dedup decides whether to fire.
      for (const status of ["running", "completed", "in_progress"]) {
        const h = createProcessor();
        await h.processor.processSandboxEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "ls" },
          callId: `call-${status}`,
          status,
          messageId: "msg-1",
          sandboxId: "sb-1",
          timestamp: 1000,
        });

        expect(h.callbackService.notifyToolCall).toHaveBeenCalledWith(
          "msg-1",
          expect.objectContaining({ type: "tool_call", status, callId: `call-${status}` })
        );
      }
    });

    it("persists a truncated tool call without sending incomplete arguments to callbacks", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "tool_call",
        tool: "bash",
        args: { command: "partial" },
        callId: "call-1",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        truncated: { fields: ["args.command"], originalBytes: 2_000_000 },
      });

      expect(h.eventRepository.upsertToolCallEvent).toHaveBeenCalledWith(
        "msg-1",
        expect.objectContaining({
          truncated: { fields: ["args.command"], originalBytes: 2_000_000 },
        }),
        expect.any(Number)
      );
      expect(h.callbackService.notifyToolCall).not.toHaveBeenCalled();
    });

    it("resets activity timer on step_start", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_start",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on step_finish", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("does not reset activity timer on heartbeat while idle", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });

    it("resets activity timer on heartbeat while a message is processing", async () => {
      const h = createProcessor();
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("refreshes the slack activity indicator on heartbeat while a message is processing", async () => {
      const h = createProcessor();
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.refreshSlackActivity).toHaveBeenCalledWith("msg-1", expect.any(Number));
    });

    it("does not refresh the slack activity indicator on heartbeat while idle", async () => {
      const h = createProcessor();

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.refreshSlackActivity).not.toHaveBeenCalled();
    });

    it("does not reset activity timer on token", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });
  });

  describe("the running turn's budget", () => {
    it("is prompted by every event while a turn runs, and by none between turns", async () => {
      const observe = vi.fn();
      const h = createProcessor(undefined, undefined, undefined, { observe });

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });
      expect(observe).not.toHaveBeenCalled();

      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        timestamp: 1000,
      });
      await h.processor.processSandboxEvent({
        type: "token",
        messageId: "msg-1",
        content: "working",
        sandboxId: "sb-1",
        timestamp: 1001,
      });
      expect(observe).toHaveBeenCalledTimes(2);
      expect(typeof observe.mock.calls[0][0]).toBe("number");
    });

    it("does not let a failing look at the budget fail the event", async () => {
      const h = createProcessor(undefined, undefined, undefined, {
        observe: () => {
          throw new Error("storage busy");
        },
      });
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      await expect(
        h.processor.processSandboxEvent({
          type: "heartbeat",
          sandboxId: "sb-1",
          timestamp: 1000,
        })
      ).resolves.toBeUndefined();
      expect(h.log.warn).toHaveBeenCalledWith(
        "budget.running_turn_observe_failed",
        expect.objectContaining({ event_type: "heartbeat" })
      );
    });

    it("is prompted after a step's cost from the ledger has been counted", async () => {
      const order: string[] = [];
      const turnCost = vi.fn(async () => {
        order.push("ledger");
        return 0.0099;
      });
      const observe = vi.fn(() => order.push("observe"));
      const h = createProcessor(undefined, undefined, { turnCost }, { observe });
      h.repository.getMessageById.mockReturnValue({ started_at: 1_000 });
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      await h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 2000,
        cost: 0.16,
        messageCostUsd: 0.16,
      });

      expect(h.budgetService.ingestStepFinish).toHaveBeenCalledWith(
        expect.objectContaining({ messageCostUsd: 0.0099 }),
        "msg-1",
        expect.any(Number)
      );
      expect(order).toEqual(["ledger", "observe"]);
    });
  });

  describe("ACK mechanism", () => {
    it.each([
      {
        event: {
          type: "sandbox_generation_ready",
          sandboxId: "sb-1",
          generation: { sandboxId: "sb-1", createdAt: 4000 },
          timestamp: 1000,
          ackId: "sandbox_generation_ready:2",
        } satisfies SandboxEvent,
      },
      {
        event: {
          type: "preservation_prepared",
          sandboxId: "sb-1",
          operationId: "operation-1",
          generation: { sandboxId: "sb-1", createdAt: 4000 },
          executionStopped: true,
          timestamp: 1000,
          ackId: "preservation_prepared:2",
        } satisfies SandboxEvent,
      },
    ])("rejects $event.type without shutdown handlers and does not ACK", async ({ event }) => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      await expect(h.processor.processSandboxEvent(event)).rejects.toThrow(
        "Sandbox graceful shutdown event handlers are not configured"
      );
      expect(h.wsManager.send).not.toHaveBeenCalled();
    });

    it("ACKs a shutdown event only after its configured handler succeeds", async () => {
      const prepared = vi.fn();
      const h = createProcessor({ generationReady: vi.fn(), prepared });
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      const event = {
        type: "preservation_prepared",
        sandboxId: "sb-1",
        operationId: "operation-1",
        generation: { sandboxId: "sb-1", createdAt: 4000 },
        executionStopped: true,
        timestamp: 1000,
        ackId: "preservation_prepared:2",
      } satisfies SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(prepared).toHaveBeenCalledWith(event);
      expect(prepared.mock.invocationCallOrder[0]).toBeLessThan(
        h.wsManager.send.mock.invocationCallOrder[0]
      );
      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "preservation_prepared:2",
      });
    });

    it("does not ACK when a configured shutdown handler throws", async () => {
      const h = createProcessor({
        generationReady: vi.fn(() => {
          throw new Error("generation rejected");
        }),
        prepared: vi.fn(),
      });
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "sandbox_generation_ready",
        sandboxId: "sb-1",
        generation: { sandboxId: "sb-1", createdAt: 4000 },
        timestamp: 1000,
        ackId: "sandbox_generation_ready:2",
      } satisfies SandboxEvent;

      await expect(h.processor.processSandboxEvent(event)).rejects.toThrow("generation rejected");
      expect(h.wsManager.send).not.toHaveBeenCalled();
    });

    it("sends ACK after execution_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
    });

    it("sends ACK for push_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 2000,
        ackId: "push_complete:msg-2",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "push_complete:msg-2",
      });
    });

    it("sends ACK for error events when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "error",
        error: "something failed",
        messageId: "msg-3",
        sandboxId: "sb-1",
        timestamp: 3000,
        ackId: "error:msg-3",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "error:msg-3",
      });
    });

    it("does not send ACK when ackId is absent (backward compatibility)", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      const event: SandboxEvent = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
      };

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).not.toHaveBeenCalled();
    });

    it("ACKs duplicate completions while safely repeating lifecycle reconciliation", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      // No processing message — triggers the "already_stopped" branch
      h.repository.getProcessingMessage.mockReturnValue(null);

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
      expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
      expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
      expect(h.updateLastActivity).toHaveBeenCalledOnce();
      expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
      expect(h.processMessageQueue).toHaveBeenCalledOnce();
    });

    it("does not send ACK for non-critical events even with ackId", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        ackId: "token:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      // Token events return early before ACK logic
      expect(h.wsManager.send).not.toHaveBeenCalled();
    });
  });
});
