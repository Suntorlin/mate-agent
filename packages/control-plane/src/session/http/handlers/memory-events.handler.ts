import {
  userMemoryLoadedMessageSchema,
  userMemoryUpdatedMessageSchema,
} from "@open-inspect/shared/types/user-memory";
import { z } from "zod";
import type { SessionMessenger } from "../../messenger";

const userMemoryEventSchema = z.discriminatedUnion("type", [
  userMemoryUpdatedMessageSchema,
  userMemoryLoadedMessageSchema,
]);

const INVALID_BODY = "A memory_updated or memory_loaded message is required";

/**
 * HTTP boundary for user memory changes made outside the session: the
 * sandbox's `mem` routes and the after-turn jobs are global, so they hand
 * the session the server message and it fans it out to the people watching
 * ("Remembered: …", "Using memory: …"). Nothing is persisted: the lines show
 * on live pages only.
 */
export class UserMemoryEventsHandler {
  constructor(private readonly messenger: Pick<SessionMessenger, "broadcast">) {}

  async broadcast(request: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: INVALID_BODY }, { status: 400 });
    }
    const message = userMemoryEventSchema.safeParse(raw);
    if (!message.success) return Response.json({ error: INVALID_BODY }, { status: 400 });
    this.messenger.broadcast(message.data);
    return Response.json({ ok: true });
  }
}
