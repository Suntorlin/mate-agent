import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Artifact, Turn } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { foldSteps } from "./steps.ts";
import {
  Chip,
  IconButton,
  ListGroup,
  ListRow,
  Notice,
  Shimmer,
  StaticChip,
  TextArea,
} from "./ui/index.ts";
import { ArrowUp, Check, FileIcon, Globe, Step, StopSquare } from "./ui/icons.tsx";
import type { ConversationState, LiveTurn } from "./useConversation.ts";
import "./Chat.css";

function TurnMeta({ turn }: { turn: Turn }) {
  if (turn.status !== "settled") return null;
  const where = turn.runtime === "sandbox" ? "Ran on a computer" : "Answered directly";
  const outcome =
    turn.engineStatus && turn.engineStatus !== "completed" ? ` · ${turn.engineStatus}` : "";
  return (
    <div className="turn__meta">
      {where}
      {outcome} · {turn.credits} {turn.credits === 1 ? "credit" : "credits"}
    </div>
  );
}

function Steps({ live }: { live: LiveTurn }) {
  const steps = foldSteps(live.calls);
  if (steps.length === 0) return null;
  return (
    <ul className="steps">
      {steps.map((step, index) => (
        <li key={index} className="step">
          {step.running && !live.complete ? <Step /> : <Check />}
          {step.running && !live.complete ? (
            <Shimmer>{step.label}</Shimmer>
          ) : (
            <span>
              {step.label}
              {step.count > 1 && <span className="step__count"> ×{step.count}</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Deliverables({
  artifacts,
  onOpen,
}: {
  artifacts: Artifact[];
  onOpen: (id: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <ListGroup className="deliverables">
      {artifacts.map((artifact) => (
        <ListRow
          key={artifact.id}
          icon={artifact.type === "page" ? <Globe /> : <FileIcon />}
          title={artifact.name}
          subtitle="Open in preview"
          onClick={() => onOpen(artifact.id)}
        />
      ))}
    </ListGroup>
  );
}

interface ChatProps {
  state: ConversationState;
  credits: number;
  onOpenArtifact: (id: string) => void;
}

/** Artifacts created while a turn ran belong to it (by time; the engine does not link them). */
function artifactsOfTurn(turns: Turn[], index: number, artifacts: Artifact[]): Artifact[] {
  const start = turns[index].createdAt;
  const end = turns[index + 1]?.createdAt ?? Number.POSITIVE_INFINITY;
  return artifacts.filter((artifact) => artifact.createdAt >= start && artifact.createdAt < end);
}

export function Chat({ state, credits, onOpenArtifact }: ChatProps) {
  const [draft, setDraft] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const running =
    state.pendingPrompt !== null || state.turns.some((turn) => turn.status === "running");
  const outOfCredits = credits <= 0;

  useEffect(() => {
    timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" });
  }, [state.turns, state.live, state.pendingPrompt]);

  function submit() {
    const content = draft.trim();
    if (!content || running || outOfCredits) return;
    setDraft("");
    void state.send(content);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className="chat">
      <div className="timeline" ref={timeline}>
        <div className="timeline__inner">
          {state.turns.length === 0 && state.pendingPrompt === null && (
            <div className="empty">
              <h2>What shall we make?</h2>
              <p>
                Ask a question and Pixel answers directly. Ask for a page or a file and it starts a
                computer, builds it, and puts it in the preview.
              </p>
              <div className="suggestions">
                {[
                  "What can you do?",
                  "Make me a small HTML page with a countdown to New Year",
                  "Remember that my favourite colour is coral",
                ].map((suggestion) => (
                  <Chip key={suggestion} onClick={() => setDraft(suggestion)}>
                    {suggestion}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {state.turns.map((turn, index) => {
            const live = state.live[turn.messageId];
            const text = turn.reply || live?.text || "";
            const thinking = turn.status === "running" && !text && !live?.calls.length;
            return (
              <article key={turn.messageId} className="turn">
                <div className="turn__prompt">{turn.prompt}</div>
                <div className="reply">
                  {live && <Steps live={live} />}
                  {thinking && (
                    <div className="turn__thinking">
                      <Shimmer>Thinking…</Shimmer>
                    </div>
                  )}
                  {text && <Markdown source={text} />}
                  {live?.error && <Notice tone="danger">{live.error}</Notice>}
                  <Deliverables
                    artifacts={artifactsOfTurn(state.turns, index, state.artifacts)}
                    onOpen={onOpenArtifact}
                  />
                  <TurnMeta turn={turn} />
                </div>
              </article>
            );
          })}
          {state.pendingPrompt !== null && (
            <article className="turn">
              <div className="turn__prompt">{state.pendingPrompt}</div>
              <div className="reply">
                <div className="turn__thinking">
                  <Shimmer>Thinking…</Shimmer>
                </div>
              </div>
            </article>
          )}
        </div>
      </div>
      <div className="composer-dock">
        {(state.error || outOfCredits) && (
          <Notice tone="danger">
            {state.error ?? "You are out of credits. New prompts are refused."}
          </Notice>
        )}
        <div className="composer">
          <TextArea
            value={draft}
            placeholder={outOfCredits ? "Out of credits" : "Ask Pixel anything…"}
            rows={2}
            disabled={outOfCredits}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Message"
          />
          <div className="composer__row">
            <StaticChip>Claude Sonnet 4.6</StaticChip>
            <div className="composer__actions">
              {running && (
                <IconButton label="Stop" variant="muted" onClick={() => void state.stop()}>
                  <StopSquare />
                </IconButton>
              )}
              <IconButton
                label="Send"
                variant="filled"
                onClick={submit}
                disabled={!draft.trim() || running || outOfCredits}
              >
                <ArrowUp />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
