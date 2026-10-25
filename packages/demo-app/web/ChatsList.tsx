import type { Conversation } from "./api.ts";
import { formatWhen } from "./format.ts";
import { Avatar, IconButton, ListRow, PageHeader } from "./ui/index.ts";
import { Plus } from "./ui/icons.tsx";
import "./ChatsList.css";

export interface ChatsListProps {
  conversations: Conversation[];
  activeId: string | null;
  creating: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
}

/** The conversations, newest first: a page on a phone, the middle column on a desktop. */
export function ChatsList({ conversations, activeId, creating, onNew, onSelect }: ChatsListProps) {
  return (
    <section className="chats-list">
      <PageHeader
        title="Chats"
        actions={
          <IconButton label="New conversation" onClick={onNew} disabled={creating}>
            <Plus />
          </IconButton>
        }
      />
      <nav className="chats-list__items" aria-label="Conversations">
        {conversations.length === 0 && (
          <p className="chats-list__empty">No conversations yet. Start one with the + above.</p>
        )}
        {conversations.map((conversation) => (
          <ListRow
            key={conversation.id}
            leading={<Avatar seed={conversation.id} />}
            title={conversation.title}
            subtitle={formatWhen(conversation.createdAt)}
            selected={conversation.id === activeId}
            chevron={false}
            onClick={() => onSelect(conversation.id)}
          />
        ))}
      </nav>
    </section>
  );
}
