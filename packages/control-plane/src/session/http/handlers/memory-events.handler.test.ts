import { describe, expect, it, vi } from "vitest";
import { UserMemoryEventsHandler } from "./memory-events.handler";

function post(body: unknown): Request {
  return new Request("http://internal/internal/user-memory-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("UserMemoryEventsHandler", () => {
  it("broadcasts a memory message to the session's clients", async () => {
    const broadcast = vi.fn();
    const handler = new UserMemoryEventsHandler({ broadcast });
    const message = {
      type: "memory_updated",
      batchId: "agent:1",
      source: "user_said",
      changes: [
        { op: "set", key: "pref.voice", layer: "preference", content: "男声", status: "active" },
      ],
    };

    const response = await handler.broadcast(post(message));

    expect(response.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith(message);
  });

  it("refuses anything else without broadcasting", async () => {
    const broadcast = vi.fn();
    const handler = new UserMemoryEventsHandler({ broadcast });

    expect((await handler.broadcast(post("not json"))).status).toBe(400);
    expect(
      (await handler.broadcast(post({ type: "session_status", status: "active" }))).status
    ).toBe(400);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
