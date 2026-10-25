import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import { describe, expect, it, vi } from "vitest";
import type { InlineLlm, InlineLlmResponse } from "./llm";
import { InlineRuntime, USE_SANDBOX_TOOL } from "./runtime";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 };

function scripted(...responses: Array<InlineLlmResponse | Error>): InlineLlm {
  let i = 0;
  return vi.fn(async (request) => {
    const next = responses[i++];
    if (next instanceof Error) throw next;
    for (const block of next.content) if (block.type === "text") request.onText?.(block.text);
    return next;
  });
}

function build(
  llm: InlineLlm,
  extra: Partial<ConstructorParameters<typeof InlineRuntime>[0]> = {}
) {
  const events: SandboxEvent[] = [];
  const runtime = new InlineRuntime({
    llm,
    model: "anthropic/claude-haiku-4.5",
    system: "be brief",
    emit: async (event) => {
      events.push(event);
    },
    history: () => [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ],
    log: log as never,
    now: () => 1_800_000_000_000,
    ...extra,
  });
  return { runtime, events };
}

describe("InlineRuntime", () => {
  it("streams the reply and completes the turn with schema-valid events", async () => {
    const llm = scripted({
      content: [{ type: "text", text: "饭后吃。" }],
      stopReason: "end_turn",
      usage,
    });
    const { runtime, events } = build(llm);

    await expect(
      runtime.run({ messageId: "m1", content: "饭前还是饭后？", userId: "app:u1" })
    ).resolves.toBe("done");

    for (const event of events) expect(sandboxEventSchema.safeParse(event).success).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["token", "step_finish", "execution_complete"]);
    expect(events[0]).toMatchObject({ content: "饭后吃。", messageId: "m1" });
    expect(events[2]).toMatchObject({ success: true, messageCostUsd: 0.001 });
    const request = (llm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "饭前还是饭后？" },
    ]);
    expect(request.tools.map((t: { name: string }) => t.name)).toEqual([USE_SANDBOX_TOOL]);
  });

  it("gives the model the user's memory, and answers without it when it cannot be read", async () => {
    const reply = {
      content: [{ type: "text" as const, text: "ok" }],
      stopReason: "end_turn",
      usage,
    };
    const llm = scripted(reply, reply);
    const memory = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("<user-memory>\n- pref.language: English\n</user-memory>")
      .mockRejectedValueOnce(new Error("db down"));
    const { runtime, events } = build(llm, { memory });

    await runtime.run({ messageId: "m1", content: "hi", userId: "app:u1" });
    await runtime.run({ messageId: "m2", content: "hi again", userId: "app:u1" });

    const [first, second] = (llm as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(first.system).toContain("- pref.language: English");
    expect(second.system).not.toContain("user-memory");
    expect(events.filter((e) => e.type === "execution_complete")).toHaveLength(2);
  });

  it("hands the turn to a sandbox without completing it when the model asks for one", async () => {
    const llm = scripted({
      content: [{ type: "tool_use", id: "t1", name: USE_SANDBOX_TOOL, input: { reason: "pdf" } }],
      stopReason: "tool_use",
      usage,
    });
    const { runtime, events } = build(llm);

    await expect(
      runtime.run({ messageId: "m1", content: "整理这份 PDF", userId: "app:u1" })
    ).resolves.toBe("escalate");
    expect(events.some((e) => e.type === "execution_complete")).toBe(false);
  });

  it("runs a server tool and feeds its result back to the model", async () => {
    const execute = vi.fn(async () => "3 tasks");
    const llm = scripted(
      {
        content: [{ type: "tool_use", id: "t1", name: "list_tasks", input: {} }],
        stopReason: "tool_use",
        usage,
      },
      { content: [{ type: "text", text: "你有 3 个任务" }], stopReason: "end_turn", usage }
    );
    const tool = {
      definition: { name: "list_tasks", description: "d", input_schema: {} },
      eventName: "mcp__planner__list_tasks",
      execute,
    };
    const { runtime, events } = build(llm, {
      tools: async () => ({ tools: [tool], instructions: "说中文，不用 emoji" }),
    });

    await runtime.run({ messageId: "m1", content: "我今天有什么任务", userId: "app:u1" });

    expect(execute).toHaveBeenCalledOnce();
    const first = (llm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(first.system).toContain("说中文，不用 emoji");
    expect(first.system).toContain("Current date and time (UTC): 2027-01-15T08:00:00.000Z");
    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents.map((e) => (e as { status?: string }).status)).toEqual([
      "running",
      "completed",
    ]);
    // The model calls the tool by its own name; the timeline records the product's name for it.
    expect(toolEvents.map((e) => (e as { tool?: string }).tool)).toEqual([
      "mcp__planner__list_tasks",
      "mcp__planner__list_tasks",
    ]);
    const second = (llm as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(second.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      content: "3 tasks",
    });
    expect(events.at(-1)).toMatchObject({
      type: "execution_complete",
      success: true,
      messageCostUsd: 0.002,
    });
  });

  it("completes the turn as failed when the model call fails", async () => {
    const { runtime, events } = build(scripted(new Error("upstream returned 502")));

    await expect(runtime.run({ messageId: "m1", content: "hi", userId: "app:u1" })).resolves.toBe(
      "done"
    );
    expect(events.map((e) => e.type)).toEqual(["error", "execution_complete"]);
    expect(events[1]).toMatchObject({ success: false, error: "upstream returned 502" });
  });
});
