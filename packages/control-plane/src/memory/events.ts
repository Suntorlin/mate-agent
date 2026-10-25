/** Live memory lines for a session's viewers, delivered through the session's runtime. */

import type {
  UserMemoryLoadedMessage,
  UserMemoryUpdatedMessage,
} from "@open-inspect/shared/types/user-memory";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";

/** Hand `message` to the session, which broadcasts it to its connected clients. */
export async function broadcastUserMemoryEvent(
  sessions: SessionRuntimeClient,
  sessionId: string,
  message: UserMemoryUpdatedMessage | UserMemoryLoadedMessage
): Promise<void> {
  const response = await sessions.fetch(sessionId, SessionInternalPaths.userMemoryEvent, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`The session refused the ${message.type} message (${response.status})`);
  }
}
