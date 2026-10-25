/**
 * The inline runtime: a short model loop the control plane runs itself, for prompts that need no
 * computer. It emits the same events a sandbox does (`token`, `tool_call`, `step_finish`,
 * `execution_complete`), through the session's sandbox-event processor, so storage, streaming,
 * budgets and clients do not know the difference.
 *
 * The model always has one tool, `use_sandbox`: calling it ends the inline turn without
 * completing it, and the session hands the same message to a sandbox (the router's mistakes
 * correct themselves).
 */

import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type {
  InlineContentBlock,
  InlineLlm,
  InlineMessage,
  InlineToolDefinition,
  InlineToolUseBlock,
} from "./llm";

export const INLINE_SANDBOX_ID = "inline";
export const USE_SANDBOX_TOOL = "use_sandbox";
export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_MAX_TOKENS = 4096;
/** Streamed text is flushed as a `token` event at most this often. */
const TOKEN_FLUSH_MS = 150;

const USE_SANDBOX: InlineToolDefinition = {
  name: USE_SANDBOX_TOOL,
  description:
    "Hand this request to an agent with a full computer (shell, files, code, browser). Call it " +
    "when the request needs code or commands to run, files or documents to be created or read, " +
    "many web pages to be browsed, or long multi-step work. Call it before writing any reply.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "Why a computer is needed" } },
    required: ["reason"],
  },
};

/** A tool the inline loop runs in the control plane. */
export interface InlineTool {
  definition: InlineToolDefinition;
  /** The name the call's `tool_call` events carry; the definition's name when unset. */
  eventName?: string;
  execute(input: Record<string, unknown>): Promise<string>;
}

export interface InlineRuntimeDeps {
  llm: InlineLlm;
  model: string;
  system: string;
  emit: (event: SandboxEvent) => Promise<void>;
  /** The conversation before this message, oldest first. */
  history: (messageId: string) => InlineMessage[];
  log: Logger;
  /**
   * The tools of one turn, for the participant who sent it (e.g. a product's MCP tools), and the
   * instructions that come with them (an MCP server's `instructions`: the product's persona).
   */
  tools?: (userId: string) => Promise<{ tools: InlineTool[]; instructions?: string }>;
  /** The session owner's memory as the agent reads it (`<user-memory>`), or null for none. */
  memory?: () => Promise<string | null>;
  maxRounds?: number;
  maxTokens?: number;
  now?: () => number;
}

export type InlineOutcome = "done" | "escalate";

export class InlineRuntime {
  constructor(private readonly deps: InlineRuntimeDeps) {}

  private event<T extends SandboxEvent["type"]>(
    type: T,
    messageId: string,
    fields: Omit<
      Extract<SandboxEvent, { type: T }>,
      "type" | "sandboxId" | "timestamp" | "messageId"
    >
  ): SandboxEvent {
    const now = this.deps.now ?? Date.now;
    return {
      type,
      sandboxId: INLINE_SANDBOX_ID,
      timestamp: now() / 1000,
      messageId,
      ...fields,
    } as SandboxEvent;
  }

  /** Run one turn. Never throws: a failure completes the turn as failed. */
  async run(input: { messageId: string; content: string; userId: string }): Promise<InlineOutcome> {
    const { messageId } = input;
    const [{ tools, instructions }, memory] = await Promise.all([
      this.loadTools(messageId, input.userId),
      this.loadMemory(messageId),
    ]);
    const now = this.deps.now ?? Date.now;
    // The model has no clock: without the date it writes the wrong year into tasks and plans.
    const system = [
      this.deps.system,
      `Current date and time (UTC): ${new Date(now()).toISOString()}`,
      instructions,
      memory,
    ]
      .filter(Boolean)
      .join("\n\n");
    const definitions = [USE_SANDBOX, ...tools.map((tool) => tool.definition)];
    const messages: InlineMessage[] = [
      ...this.deps.history(messageId),
      { role: "user", content: input.content },
    ];
    const maxRounds = this.deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
    let turnText = "";
    let costUsd = 0;

    try {
      for (let round = 0; round < maxRounds; round++) {
        const flush = this.textFlusher(messageId, () => turnText);
        const response = await this.deps.llm({
          model: this.deps.model,
          system,
          messages,
          tools: definitions,
          maxTokens: this.deps.maxTokens ?? DEFAULT_MAX_TOKENS,
          onText: (delta) => {
            turnText += delta;
            flush.schedule();
          },
        });
        await flush.now();
        costUsd += response.usage.costUsd ?? 0;
        await this.deps.emit(
          this.event("step_finish", messageId, {
            ...(response.usage.costUsd === null ? {} : { cost: response.usage.costUsd }),
            messageCostUsd: costUsd,
            tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
          })
        );

        const calls = response.content.filter(
          (block): block is InlineToolUseBlock => block.type === "tool_use"
        );
        if (calls.length === 0) break;
        if (calls.some((call) => call.name === USE_SANDBOX_TOOL)) {
          this.deps.log.info("inline.escalate", {
            event: "inline.escalate",
            message_id: messageId,
          });
          return "escalate";
        }
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: await this.runTools(messageId, calls, tools) });
        if (turnText && !turnText.endsWith("\n")) turnText += "\n\n";
      }
      await this.deps.emit(
        this.event("execution_complete", messageId, { success: true, messageCostUsd: costUsd })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error("inline.turn_failed", {
        event: "inline.turn_failed",
        message_id: messageId,
        error: message.slice(0, 300),
      });
      await this.deps.emit(this.event("error", messageId, { error: message.slice(0, 500) }));
      await this.deps.emit(
        this.event("execution_complete", messageId, {
          success: false,
          error: message.slice(0, 500),
          messageCostUsd: costUsd,
        })
      );
    }
    return "done";
  }

  /** A product whose tools cannot be listed leaves the turn without them, not failed. */
  private async loadTools(
    messageId: string,
    userId: string
  ): Promise<{ tools: InlineTool[]; instructions?: string }> {
    if (!this.deps.tools) return { tools: [] };
    try {
      return await this.deps.tools(userId);
    } catch (error) {
      this.deps.log.warn("inline.tools_unavailable", {
        event: "inline.tools_unavailable",
        message_id: messageId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      return { tools: [] };
    }
  }

  /** Memory that cannot be read leaves the turn without it, not failed. */
  private async loadMemory(messageId: string): Promise<string | null> {
    if (!this.deps.memory) return null;
    try {
      return await this.deps.memory();
    } catch (error) {
      this.deps.log.warn("inline.memory_unavailable", {
        event: "inline.memory_unavailable",
        message_id: messageId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      return null;
    }
  }

  private async runTools(
    messageId: string,
    calls: InlineToolUseBlock[],
    tools: InlineTool[]
  ): Promise<InlineContentBlock[]> {
    const results: InlineContentBlock[] = [];
    for (const call of calls) {
      const tool = tools.find((candidate) => candidate.definition.name === call.name);
      const base = { tool: tool?.eventName ?? call.name, args: call.input, callId: call.id };
      await this.deps.emit(this.event("tool_call", messageId, { ...base, status: "running" }));
      let output: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`unknown tool ${call.name}`);
        output = await tool.execute(call.input);
      } catch (error) {
        output = error instanceof Error ? error.message : String(error);
        isError = true;
      }
      await this.deps.emit(
        this.event("tool_call", messageId, {
          ...base,
          status: isError ? "error" : "completed",
          output: output.slice(0, 4000),
        })
      );
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: output,
        is_error: isError,
      });
    }
    return results;
  }

  /** Coalesces streamed text into `token` events (each carries the turn's whole text). */
  private textFlusher(messageId: string, text: () => string) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sent = "";
    let pending: Promise<void> = Promise.resolve();
    const send = () => {
      timer = null;
      const content = text();
      if (!content || content === sent) return pending;
      sent = content;
      pending = pending.then(() => this.deps.emit(this.event("token", messageId, { content })));
      return pending;
    };
    return {
      schedule: () => {
        if (!timer) timer = setTimeout(() => void send(), TOKEN_FLUSH_MS);
      },
      now: () => {
        if (timer) clearTimeout(timer);
        return send();
      },
    };
  }
}
