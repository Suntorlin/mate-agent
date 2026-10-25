import { useCallback, useEffect, useState } from "react";
import { api, type User } from "./api.ts";
import { AuthScreen } from "./AuthScreen.tsx";
import { useTheme } from "./design/theme.ts";
import { AppShell } from "./AppShell.tsx";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const theme = useTheme();

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null));
  }, []);

  const signOut = useCallback(() => {
    api.signOut().finally(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="boot">Loading…</div>;
  if (user === null) return <AuthScreen onSignedIn={setUser} theme={theme} />;
  return <AppShell user={user} onUser={setUser} onSignOut={signOut} theme={theme} />;
}
