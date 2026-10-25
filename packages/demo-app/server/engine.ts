/**
 * The engine as this product's backend calls it: every request is signed as the `app` service
 * principal (sig1, see sig1.ts) and names the product's user as the
 * actor `app:<userId>`. The engine keeps one participant per actor, so sessions, prompts and
 * artifacts are that user's; the user never holds an engine credential.
 */

import { z } from "zod";
import { sig1Headers } from "./sig1.ts";

const ENGINE_REQUEST_TIMEOUT_MS = 30_000;
/** Turns read back at once when settling; a conversation with more running turns settles in steps. */
const MESSAGE_PAGE_LIMIT = 100;

export class EngineError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const engineMessageSchema = z.object({
  id: z.string(),
  status: z.string(),
  costUsd: z.number().optional(),
  runtime: z.string().nullable().optional(),
});
export type EngineMessage = z.infer<typeof engineMessageSchema>;

const artifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  url: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.number(),
});
export type EngineArtifact = z.infer<typeof artifactSchema>;

export interface EngineClientOptions {
  baseUrl: string;
  secret: string;
  fetchFn?: typeof fetch;
}

export class EngineClient {
  readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl;
    this.secret = options.secret;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** A signed request for one of the product's users; the raw response, for streaming. */
  async request(
    userId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const headers = sig1Headers({
      service: "app",
      secret: this.secret,
      method,
      url,
      body: serialized,
      actor: `app:${userId}`,
    });
    return this.fetchFn(url, {
      method,
      body: serialized,
      headers: serialized ? { ...headers, "Content-Type": "application/json" } : headers,
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
    });
  }

  private async json(
    userId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const response = await this.request(userId, method, path, body);
    const text = await response.text();
    if (!response.ok) {
      throw new EngineError(`${method} ${path} -> ${response.status}: ${text}`, response.status);
    }
    return text ? JSON.parse(text) : null;
  }

  async createSession(userId: string, name: string, model: string): Promise<string> {
    const body = await this.json(userId, "POST", "/sessions", { name, model });
    return z.object({ sessionId: z.string() }).parse(body).sessionId;
  }

  async prompt(userId: string, sessionId: string, content: string): Promise<string> {
    const body = await this.json(userId, "POST", `/sessions/${sessionId}/prompt`, { content });
    return z.object({ messageId: z.string() }).parse(body).messageId;
  }

  async stop(userId: string, sessionId: string): Promise<void> {
    await this.json(userId, "POST", `/sessions/${sessionId}/stop`, {});
  }

  async wsToken(userId: string, sessionId: string): Promise<string> {
    const body = await this.json(userId, "POST", `/sessions/${sessionId}/ws-token`, {});
    return z.object({ token: z.string() }).parse(body).token;
  }

  /** The session's latest turns, with what each cost (`costUsd`) and where it ran. */
  async messages(userId: string, sessionId: string): Promise<EngineMessage[]> {
    const body = await this.json(
      userId,
      "GET",
      `/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_LIMIT}`
    );
    return z.object({ messages: z.array(engineMessageSchema) }).parse(body).messages;
  }

  async artifacts(userId: string, sessionId: string): Promise<EngineArtifact[]> {
    const body = await this.json(userId, "GET", `/sessions/${sessionId}/artifacts`);
    return z.object({ artifacts: z.array(artifactSchema) }).parse(body).artifacts;
  }

  /** The bytes of one artifact (a page, a file, an image), streamed through as the engine sends them. */
  media(userId: string, sessionId: string, artifactId: string): Promise<Response> {
    return this.request(
      userId,
      "GET",
      `/sessions/${sessionId}/media/${encodeURIComponent(artifactId)}`
    );
  }
}
