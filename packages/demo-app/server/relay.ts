/**
 * The engine's live stream of a session, relayed to the product's browser.
 *
 * This backend, not the browser, holds the engine WebSocket: it asks the engine for a ws-token
 * as the user (`app:<id>`), subscribes, and passes `sandbox_event` and `artifact_created`
 * messages on to the browser over server-sent events. The browser never gets an engine token,
 * so it cannot send prompts around the credit check, and the backend sees every
 * `execution_complete` itself, which is when it keeps the reply and settles the turn.
 */

import type { EngineClient } from "./engine.ts";
import type { Conversation } from "./store.ts";

/** How long a socket stays open after its last listener leaves, unless a turn is running. */
const IDLE_CLOSE_MS = 60_000;
const RECONNECT_DELAY_MS = 2_000;

type RelayMessage =
  | { type: "sandbox_event"; event: Record<string, unknown> }
  | { type: "artifact_created"; artifact: Record<string, unknown> };

type Listener = (message: RelayMessage) => void;

/** The part of a WebSocket the relay uses; tests pass a fake. */
export type SocketLike = Pick<WebSocket, "addEventListener" | "send" | "close">;
export type OpenSocket = (url: string) => SocketLike;

const openWebSocket: OpenSocket = (url) => new WebSocket(url);

export interface RelayHooks {
  /** A turn ended in the engine; `reply` is the last text the agent streamed. */
  onTurnEnded: (conversation: Conversation, messageId: string, reply: string) => void;
  /** Whether a conversation still has a turn the backend is waiting on. */
  hasRunningTurn: (conversation: Conversation) => boolean;
  log: (message: string, error?: unknown) => void;
}

class SessionStream {
  private socket: SocketLike | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly replies = new Map<string, string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private opening: Promise<void> | null = null;
  readonly conversation: Conversation;
  private readonly engine: EngineClient;
  private readonly hooks: RelayHooks;
  private readonly onClosed: () => void;
  private readonly openSocket: OpenSocket;

  constructor(
    conversation: Conversation,
    engine: EngineClient,
    hooks: RelayHooks,
    openSocket: OpenSocket,
    onClosed: () => void
  ) {
    this.conversation = conversation;
    this.engine = engine;
    this.hooks = hooks;
    this.openSocket = openSocket;
    this.onClosed = onClosed;
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    this.cancelIdle();
    return () => {
      this.listeners.delete(listener);
      this.scheduleIdle();
    };
  }

  get idle(): boolean {
    return this.listeners.size === 0;
  }

  /** Connect once; concurrent callers share the same attempt. */
  open(): Promise<void> {
    if (this.socket || this.closed) return Promise.resolve();
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<void> {
    const { userId, engineSessionId } = this.conversation;
    const token = await this.engine.wsToken(userId, engineSessionId);
    if (this.closed) return;
    const url = `${this.engine.baseUrl.replace(/^http/, "ws")}/sessions/${engineSessionId}/ws`;
    const socket = this.openSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", token, clientId: "demo-app" }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.receive(String(event.data));
    });
    socket.addEventListener("error", () => this.hooks.log("engine socket error"));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      if (this.listeners.size > 0 || this.hooks.hasRunningTurn(this.conversation)) {
        setTimeout(() => {
          this.open().catch((error) => this.hooks.log("engine socket reconnect failed", error));
        }, RECONNECT_DELAY_MS);
      } else {
        this.close();
      }
    });
    this.scheduleIdle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdle();
    this.socket?.close();
    this.onClosed();
  }

  private receive(data: string): void {
    let message: { type?: unknown; event?: unknown; artifact?: unknown };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === "sandbox_event" && message.event && typeof message.event === "object") {
      const event = message.event as Record<string, unknown>;
      this.track(event);
      this.emit({ type: "sandbox_event", event });
    } else if (message.type === "artifact_created" && message.artifact) {
      this.emit({
        type: "artifact_created",
        artifact: message.artifact as Record<string, unknown>,
      });
    }
  }

  /** Keep the latest text of each turn (a `token` event carries all of it) and see turns end. */
  private track(event: Record<string, unknown>): void {
    const messageId = typeof event.messageId === "string" ? event.messageId : null;
    if (!messageId) return;
    if (event.type === "token" && typeof event.content === "string") {
      this.replies.set(messageId, event.content);
    } else if (event.type === "execution_complete") {
      const reply = this.replies.get(messageId) ?? "";
      this.replies.delete(messageId);
      this.hooks.onTurnEnded(this.conversation, messageId, reply);
      this.scheduleIdle();
    }
  }

  private emit(message: RelayMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private scheduleIdle(): void {
    if (this.listeners.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size === 0 && !this.hooks.hasRunningTurn(this.conversation)) this.close();
    }, IDLE_CLOSE_MS);
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export class Relay {
  private readonly streams = new Map<string, SessionStream>();
  private readonly engine: EngineClient;
  private readonly hooks: RelayHooks;
  private readonly openSocket: OpenSocket;

  constructor(engine: EngineClient, hooks: RelayHooks, openSocket: OpenSocket = openWebSocket) {
    this.engine = engine;
    this.hooks = hooks;
    this.openSocket = openSocket;
  }

  /** The open stream of a conversation, opening it if needed. */
  async stream(conversation: Conversation): Promise<SessionStream> {
    let stream = this.streams.get(conversation.id);
    if (!stream) {
      stream = new SessionStream(conversation, this.engine, this.hooks, this.openSocket, () =>
        this.streams.delete(conversation.id)
      );
      this.streams.set(conversation.id, stream);
    }
    try {
      await stream.open();
    } catch (error) {
      // Only a stream nobody is listening to is dropped; another request may be using it.
      if (stream.idle) stream.close();
      throw error;
    }
    return stream;
  }

  closeAll(): void {
    for (const stream of [...this.streams.values()]) stream.close();
  }
}
