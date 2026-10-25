import type { Conversation, User } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Badge, Button, IconButton, SubPageHeader } from "./ui/index.ts";
import { Coins, PanelRight } from "./ui/icons.tsx";
import type { ConversationState } from "./useConversation.ts";
import "./ChatPane.css";

export interface ChatPaneProps {
  conversation: Conversation | null;
  user: User;
  state: ConversationState;
  creating: boolean;
  /** Set on a phone, where a chat is a page of its own. */
  onBack?: () => void;
  previewOpen: boolean;
  onOpenPreview: (artifactId?: string) => void;
  onNew: () => void;
}

/** One conversation: its header (title, credits, preview), the chat, or an invitation to start one. */
export function ChatPane({
  conversation,
  user,
  state,
  creating,
  onBack,
  previewOpen,
  onOpenPreview,
  onNew,
}: ChatPaneProps) {
  if (!conversation) {
    return (
      <section className="chat-pane chat-pane--empty">
        <h2>Start a conversation</h2>
        <p>Each conversation is one session on the engine.</p>
        <Button onClick={onNew} disabled={creating}>
          New conversation
        </Button>
      </section>
    );
  }
  return (
    <section className="chat-pane">
      <SubPageHeader
        title={conversation.title}
        onBack={onBack}
        backLabel="Chats"
        actions={
          <>
            <Badge
              variant={user.credits > 0 ? "default" : "destructive"}
              icon={<Coins />}
              title="Your credits"
            >
              {user.credits.toLocaleString()}
            </Badge>
            {!previewOpen && (
              <IconButton label="Open preview" onClick={() => onOpenPreview()}>
                <PanelRight />
              </IconButton>
            )}
          </>
        }
      />
      <Chat state={state} credits={user.credits} onOpenArtifact={(id) => onOpenPreview(id)} />
    </section>
  );
}
