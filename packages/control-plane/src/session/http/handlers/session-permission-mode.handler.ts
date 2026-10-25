import { sessionPermissionModeUpdateSchema } from "@open-inspect/shared/types/session-api";
import type { SessionCoreRepository } from "../../session-core-repository";

/** Changes when the session's agent asks before acting; the next prompt carries the new mode. */
export class SessionPermissionModeHandler {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly now: () => number
  ) {}

  async update(request: Request): Promise<Response> {
    if (!this.repository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const parsed = sessionPermissionModeUpdateSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json({ error: "Invalid permission mode request" }, { status: 400 });
    }

    this.repository.setPermissionMode(parsed.data.permissionMode, this.now());
    return Response.json({ permissionMode: parsed.data.permissionMode });
  }
}
