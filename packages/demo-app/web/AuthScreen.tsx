import { useState, type FormEvent } from "react";
import { api, ApiError, type User } from "./api.ts";
import { Brand } from "./Brand.tsx";
import type { ThemeControl } from "./design/theme.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { Button, FormField, Notice, TextField } from "./ui/index.ts";
import "./AuthScreen.css";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match an account.",
  invalid_credentials_format: "Use a valid email and a password of at least 8 characters.",
  email_taken: "There is already an account with that email. Sign in instead.",
};

export function AuthScreen({
  onSignedIn,
  theme,
}: {
  onSignedIn: (user: User) => void;
  theme: ThemeControl;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } =
        mode === "signup" ? await api.signUp(email, password) : await api.signIn(email, password);
      onSignedIn(user);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      setError(MESSAGES[code] ?? "Something went wrong. Is the demo backend running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth__theme">
        <ThemeToggle {...theme} />
      </div>
      <form className="auth__card" onSubmit={submit}>
        <Brand large />
        <div className="auth__intro">
          <h1>{mode === "signup" ? "Create an account" : "Welcome back"}</h1>
          <p>
            A reference product on Mate Agent. Accounts live on this machine only; new accounts
            start with free credits.
          </p>
        </div>
        <FormField label="Email">
          <TextField
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={error !== null}
            required
          />
        </FormField>
        <FormField label="Password">
          <TextField
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={error !== null}
            required
          />
        </FormField>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? "One moment…" : mode === "signup" ? "Sign up" : "Sign in"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setError(null);
          }}
        >
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </Button>
      </form>
    </main>
  );
}
