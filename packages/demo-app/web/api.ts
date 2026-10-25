/** The demo backend's API as the browser sees it. */

export interface User {
  id: string;
  email: string;
  credits: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
}

export interface Turn {
  messageId: string;
  prompt: string;
  reply: string;
  status: "running" | "settled";
  engineStatus: string | null;
  runtime: string | null;
  credits: number;
  createdAt: number;
}

export interface Artifact {
  id: string;
  type: string;
  name: string;
  caption: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `http_${response.status}`);
  return data as T;
}

export const api = {
  signUp: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/signup", { body: { email, password } }),
  signIn: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/signin", { body: { email, password } }),
  signOut: () => request<{ ok: true }>("/api/auth/signout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/me"),
  conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
  createConversation: () =>
    request<{ conversation: Conversation }>("/api/conversations", { method: "POST" }),
  conversation: (id: string) =>
    request<{ conversation: Conversation; turns: Turn[] }>(`/api/conversations/${id}`),
  prompt: (id: string, content: string) =>
    request<{ turn: Turn }>(`/api/conversations/${id}/prompt`, { body: { content } }),
  stop: (id: string) => request<{ ok: true }>(`/api/conversations/${id}/stop`, { method: "POST" }),
  artifacts: (id: string) =>
    request<{ artifacts: Artifact[] }>(`/api/conversations/${id}/artifacts`),
};

export function artifactUrl(conversationId: string, artifactId: string, download = false): string {
  const base = `/api/conversations/${conversationId}/artifacts/${encodeURIComponent(artifactId)}/content`;
  return download ? `${base}?download=1` : base;
}
