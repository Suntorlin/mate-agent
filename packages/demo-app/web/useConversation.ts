/**
 * One conversation's state in the browser: its turns as the backend keeps them, the live
 * stream of the running turn (relayed engine events over server-sent events), and the files
 * the agent published for the preview.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Artifact, type Turn } from "./api.ts";
import type { ToolCallEvent } from "./steps.ts";

export interface LiveTurn {
  text: string;
  calls: ToolCallEvent[];
  complete: boolean;
  error: string | null;
}

const EMPTY_LIVE: LiveTurn = { text: "", calls: [], complete: false, error: null };

interface EngineEvent {
  type?: string;
  messageId?: string;
  content?: string;
  tool?: string;
  callId?: string;
  status?: string;
  success?: boolean;
  error?: string;
}

function applyEvent(live: LiveTurn, event: EngineEvent): LiveTurn {
  switch (event.type) {
    case "token":
      return typeof event.content === "string" ? { ...live, text: event.content } : live;
    case "tool_call":
      return event.tool && event.callId
        ? {
            ...live,
            calls: [
              ...live.calls,
              { tool: event.tool, callId: event.callId, status: event.status },
            ],
          }
        : live;
    case "error":
      return { ...live, error: event.error ?? "The agent hit an error" };
    case "execution_complete":
      return {
        ...live,
        complete: true,
        error:
          event.success === false ? (event.error ?? live.error ?? "The turn failed") : live.error,
      };
    default:
      return live;
  }
}

export interface ConversationState {
  turns: Turn[];
  live: Record<string, LiveTurn>;
  pendingPrompt: string | null;
  artifacts: Artifact[];
  newestArtifactId: string | null;
  error: string | null;
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function useConversation(
  conversationId: string | null,
  onTurnSettled: () => void
): ConversationState {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<Record<string, LiveTurn>>({});
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [newestArtifactId, setNewestArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settledRef = useRef(onTurnSettled);
  settledRef.current = onTurnSettled;

  const reload = useCallback(async () => {
    if (!conversationId) return;
    const [conversation, list] = await Promise.all([
      api.conversation(conversationId),
      api.artifacts(conversationId).catch(() => ({ artifacts: [] as Artifact[] })),
    ]);
    setTurns(conversation.turns);
    setArtifacts(list.artifacts);
  }, [conversationId]);

  useEffect(() => {
    setTurns([]);
    setLive({});
    setArtifacts([]);
    setNewestArtifactId(null);
    setPendingPrompt(null);
    setError(null);
    if (!conversationId) return;
    reload().catch(() => setError("Could not load this conversation"));

    const source = new EventSource(`/api/conversations/${conversationId}/events`);
    source.addEventListener("sandbox_event", (message) => {
      const { event } = JSON.parse((message as MessageEvent).data) as { event: EngineEvent };
      const messageId = event.messageId;
      if (!messageId) return;
      setLive((current) => ({
        ...current,
        [messageId]: applyEvent(current[messageId] ?? EMPTY_LIVE, event),
      }));
      if (event.type === "execution_complete") {
        // The backend settles the turn when it sees the same event; read the result back.
        setTimeout(() => {
          settledRef.current();
          reload().catch(() => {});
        }, 400);
      }
    });
    source.addEventListener("artifact_created", (message) => {
      const { artifact } = JSON.parse((message as MessageEvent).data) as {
        artifact: { id?: string };
      };
      if (artifact.id) setNewestArtifactId(artifact.id);
      api
        .artifacts(conversationId)
        .then((list) => setArtifacts(list.artifacts))
        .catch(() => {});
    });
    return () => source.close();
  }, [conversationId, reload]);

  const send = useCallback(
    async (content: string) => {
      if (!conversationId) return;
      setError(null);
      setPendingPrompt(content);
      try {
        const { turn } = await api.prompt(conversationId, content);
        setTurns((current) => [...current, turn]);
      } catch (cause) {
        const code = cause instanceof ApiError ? cause.code : "network";
        setError(
          code === "out_of_credits"
            ? "You are out of credits. This demo does not sell more; sign up again to start over."
            : code === "turn_running"
              ? "The agent is still working on your last message."
              : "Could not send the message. Is the engine running?"
        );
      } finally {
        setPendingPrompt(null);
      }
    },
    [conversationId]
  );

  const stop = useCallback(async () => {
    if (conversationId) await api.stop(conversationId).catch(() => {});
  }, [conversationId]);

  return { turns, live, pendingPrompt, artifacts, newestArtifactId, error, send, stop };
}
