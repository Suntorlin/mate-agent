import { describe, expect, it, vi } from "vitest";
import { SessionPermissionModeHandler } from "./session-permission-mode.handler";
import type { SessionCoreRepository } from "../../session-core-repository";

function createHandler(session: { id: string } | null = { id: "session-1" }) {
  const repository = { getSession: vi.fn(() => session), setPermissionMode: vi.fn() };
  return {
    handler: new SessionPermissionModeHandler(
      repository as unknown as SessionCoreRepository,
      () => 1000
    ),
    repository,
  };
}

function request(body: unknown): Request {
  return new Request("http://internal/internal/permission-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("SessionPermissionModeHandler", () => {
  it.each(["auto_within_budget", "confirm_edits", "full_auto"] as const)(
    "stores %s and answers with it",
    async (permissionMode) => {
      const h = createHandler();
      const response = await h.handler.update(request({ permissionMode }));

      expect(response.status).toBe(200);
      expect(h.repository.setPermissionMode).toHaveBeenCalledWith(permissionMode, 1000);
      expect(await response.json()).toEqual({ permissionMode });
    }
  );

  it.each([{ permissionMode: "ask_always" }, { permissionMode: "full_auto", extra: true }, {}])(
    "rejects invalid body %#",
    async (body) => {
      const h = createHandler();
      const response = await h.handler.update(request(body));

      expect(response.status).toBe(400);
      expect(h.repository.setPermissionMode).not.toHaveBeenCalled();
    }
  );

  it("answers 404 before a session exists", async () => {
    const h = createHandler(null);
    const response = await h.handler.update(request({ permissionMode: "full_auto" }));

    expect(response.status).toBe(404);
    expect(h.repository.setPermissionMode).not.toHaveBeenCalled();
  });
});
