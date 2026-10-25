/**
 * Where the app is, kept in the URL hash (`#/chats`, `#/chats/<id>`, `#/me`) so the back button and
 * a reload work without a router library. The backend serves the same page for every path, so the
 * hash is the only part the browser keeps to itself.
 */

import { useCallback, useEffect, useState } from "react";

export type Route = { page: "chats"; conversationId: string | null } | { page: "me" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "me") return { page: "me" };
  return { page: "chats", conversationId: parts[0] === "chats" ? (parts[1] ?? null) : null };
}

export function formatRoute(route: Route): string {
  if (route.page === "me") return "#/me";
  return route.conversationId ? `#/chats/${route.conversationId}` : "#/chats";
}

export function useRoute(): {
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
} {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const hash = formatRoute(next);
    if (location.hash === hash) return;
    if (options?.replace) location.replace(hash);
    else location.hash = hash;
  }, []);

  return { route, navigate };
}
