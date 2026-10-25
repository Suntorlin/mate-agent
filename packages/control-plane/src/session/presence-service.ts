/**
 * PresenceService - Presence tracking and typing-triggered sandbox warming.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Building presence lists from the WebSocket manager's client registry
 * - Sending presence sync/update messages to individual or all clients
 * - Updating client presence status
 * - Proactive sandbox warming on typing indicators
 */

import type { Logger } from "../logger";
import type {
  ParticipantPresence,
  ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import type { ClientInfo } from "../types";
import type { SessionMessenger } from "./messenger";
import type { BackgroundTasks, SessionWebSocket } from "../platform-ports";

/** Project one participant per identity from one or more client connections. */
function projectConnectedParticipants(connections: Iterable<ClientInfo>): ParticipantPresence[] {
  const participants = new Map<string, ParticipantPresence>();
  for (const connection of connections) {
    const existing = participants.get(connection.participantId);
    if (!existing) {
      participants.set(connection.participantId, {
        participantId: connection.participantId,
        userId: connection.userId,
        name: connection.name,
        avatar: connection.avatar,
        status: connection.status,
        lastSeen: connection.lastSeen,
      });
      continue;
    }
    if (connection.status === "active") existing.status = "active";
    if (connection.lastSeen > existing.lastSeen) existing.lastSeen = connection.lastSeen;
  }
  return Array.from(participants.values());
}

/**
 * Dependencies injected into PresenceService.
 * All state lives in the WebSocket manager — the service is stateless.
 */
export interface PresenceServiceDeps {
  getAuthenticatedClients: () => IterableIterator<ClientInfo>;
  messenger: SessionMessenger;
  send: (ws: SessionWebSocket, message: ServerMessage) => boolean;
  getSandboxSocket: () => SessionWebSocket | null;
  isSpawning: () => boolean;
  spawnSandbox: () => Promise<void>;
  backgroundTasks: BackgroundTasks;
  log: Logger;
}

export class PresenceService {
  private readonly deps: PresenceServiceDeps;

  constructor(deps: PresenceServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get list of present participants.
   *
   * A single participant can hold multiple WebSocket connections (e.g. two
   * browser tabs), so we dedupe by participantId: any active socket marks the
   * participant active, and we take the most recent lastSeen across sockets.
   */
  getPresenceList(): ParticipantPresence[] {
    return projectConnectedParticipants(this.deps.getAuthenticatedClients());
  }

  /**
   * Send presence info to a specific client.
   */
  sendPresence(ws: SessionWebSocket): void {
    const participants = this.getPresenceList();
    this.deps.send(ws, { type: "presence_sync", participants });
  }

  /**
   * Broadcast presence to all clients.
   */
  broadcastPresence(): void {
    const participants = this.getPresenceList();
    this.deps.messenger.broadcast({ type: "presence_update", participants });
  }

  /**
   * Update client presence status and broadcast.
   */
  updatePresence(
    client: ClientInfo,
    data: { status: "active" | "idle"; cursor?: { line: number; file: string } }
  ): void {
    client.status = data.status;
    client.lastSeen = Date.now();
    this.broadcastPresence();
  }

  /**
   * Handle typing indicator (warm sandbox proactively).
   */
  /**
   * Start the sandbox for a user about to send. Not awaited: a socket's messages run one at a
   * time, and the prompt that follows must not wait behind a restore that takes seconds. It
   * queues at once and runs when the sandbox this started is ready.
   */
  handleTyping(): void {
    if (this.deps.getSandboxSocket() || this.deps.isSpawning()) return;
    this.deps.messenger.broadcast({ type: "sandbox_warming" });
    this.deps.backgroundTasks.submit(() => this.deps.spawnSandbox(), { name: "sandbox.warm" });
  }
}
