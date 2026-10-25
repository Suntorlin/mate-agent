import { useCallback, useEffect, useState } from "react";
import { api, type Conversation, type User } from "./api.ts";
import { Brand } from "./Brand.tsx";
import { ChatPane } from "./ChatPane.tsx";
import { ChatsList } from "./ChatsList.tsx";
import type { ThemeControl } from "./design/theme.ts";
import { MePage } from "./MePage.tsx";
import { Preview } from "./Preview.tsx";
import { useRoute, type Route } from "./route.ts";
import { NavRail, Sheet, TabBar, type NavItem } from "./ui/index.ts";
import { ChatsIcon, MeIcon } from "./ui/icons.tsx";
import { useConversation } from "./useConversation.ts";
import { PHONE_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import "./AppShell.css";

type Page = Route["page"];

const CHATS_TAB: NavItem<Page> = {
  key: "chats",
  label: "Chats",
  icon: (active) => <ChatsIcon filled={active} />,
};
const ME_TAB: NavItem<Page> = {
  key: "me",
  label: "Me",
  icon: (active) => <MeIcon filled={active} />,
};

interface AppShellProps {
  user: User;
  onUser: (user: User) => void;
  onSignOut: () => void;
  theme: ThemeControl;
}

/**
 * The signed-in app. On a phone every page is a screen and a tab bar switches the top-level ones
 * (a chat is a screen of its own, with a back button); on a desktop an icon rail, the chat list,
 * the chat and its preview sit side by side.
 */
export function AppShell({ user, onUser, onSignOut, theme }: AppShellProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const { route, navigate } = useRoute();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeId = route.page === "chats" ? route.conversationId : null;

  const refreshUser = useCallback(() => {
    api
      .me()
      .then(({ user }) => onUser(user))
      .catch(() => {});
    api
      .conversations()
      .then(({ conversations }) => setConversations(conversations))
      .catch(() => {});
  }, [onUser]);

  const state = useConversation(activeId, refreshUser);

  useEffect(() => {
    api
      .conversations()
      .then(({ conversations }) => setConversations(conversations))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // A desktop has room for a chat next to the list, so it opens the newest one by itself.
  useEffect(() => {
    if (phone || !loaded || route.page !== "chats" || route.conversationId) return;
    if (conversations[0])
      navigate({ page: "chats", conversationId: conversations[0].id }, { replace: true });
  }, [phone, loaded, route, conversations, navigate]);

  // The pane opens by itself on the first thing the agent publishes.
  useEffect(() => {
    if (!state.newestArtifactId) return;
    setSelectedArtifact(state.newestArtifactId);
    setPreviewOpen(true);
  }, [state.newestArtifactId]);

  useEffect(() => {
    setPreviewOpen(false);
    setSelectedArtifact(null);
  }, [activeId]);

  async function newConversation() {
    setCreating(true);
    try {
      const { conversation } = await api.createConversation();
      setConversations((current) => [conversation, ...current]);
      navigate({ page: "chats", conversationId: conversation.id });
    } finally {
      setCreating(false);
    }
  }

  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const showPreview = previewOpen && active !== null;
  const openPreview = (artifactId?: string) => {
    if (artifactId) setSelectedArtifact(artifactId);
    setPreviewOpen(true);
  };

  const list = (
    <ChatsList
      conversations={conversations}
      activeId={activeId}
      creating={creating}
      onNew={() => void newConversation()}
      onSelect={(id) => navigate({ page: "chats", conversationId: id })}
    />
  );
  const chat = (
    <ChatPane
      conversation={active}
      user={user}
      state={state}
      creating={creating}
      onBack={phone ? () => navigate({ page: "chats", conversationId: null }) : undefined}
      previewOpen={showPreview}
      onOpenPreview={openPreview}
      onNew={() => void newConversation()}
    />
  );
  const preview = showPreview && active && (
    <Preview
      conversationId={active.id}
      artifacts={state.artifacts}
      selectedId={selectedArtifact}
      onSelect={setSelectedArtifact}
      onClose={() => setPreviewOpen(false)}
    />
  );
  const me = <MePage user={user} theme={theme} onSignOut={onSignOut} />;
  const goTo = (page: Page) =>
    navigate(page === "me" ? { page: "me" } : { page: "chats", conversationId: null });

  if (phone) {
    const inChat = route.page === "chats" && route.conversationId !== null;
    return (
      <div className="app app--phone">
        <div className="app__screen">{route.page === "me" ? me : inChat ? chat : list}</div>
        {!inChat && <TabBar items={[CHATS_TAB, ME_TAB]} active={route.page} onSelect={goTo} />}
        <Sheet open={Boolean(preview)} onClose={() => setPreviewOpen(false)} label="Preview">
          {preview}
        </Sheet>
      </div>
    );
  }

  return (
    <div className="app">
      <NavRail
        brand={<Brand mark />}
        items={[CHATS_TAB]}
        footerItems={[ME_TAB]}
        active={route.page}
        onSelect={goTo}
      />
      {route.page === "me" ? (
        <div className="app__main">{me}</div>
      ) : (
        <>
          <aside className="app__list">{list}</aside>
          <div className={showPreview ? "app__main app__main--split" : "app__main"}>
            {chat}
            {preview}
          </div>
        </>
      )}
    </div>
  );
}
