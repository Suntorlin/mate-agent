/**
 * Builds the session's inline runtime from the engine's environment, or nothing when
 * INLINE_LLM_BASE_URL is unset (then every prompt runs in a sandbox, as before).
 */

import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type { MessageRepository } from "../session/message-repository";
import type { EnvConfig } from "../types";
import type { InlineDispatch } from "./dispatch";
import { createInlineLlm, type InlineMessage } from "./llm";
import { createJevRuntimeRouter } from "./router";
import { InlineRuntime } from "./runtime";
import { appInlineTools, appUserId, readAppConfig } from "../app/product";

export const DEFAULT_INLINE_MODEL = "anthropic/claude-sonnet-4.6";
/** How many earlier turns an inline turn sees. */
const HISTORY_TURNS = 20;

/** The engine's own default; a product on top of the engine brings its persona later. */
export const DEFAULT_INLINE_SYSTEM =
  "You are a capable personal assistant. Answer directly and briefly, in the user's language. " +
  "You have no computer in this mode: when a request needs code or commands, files or " +
  "documents, many web pages, or long multi-step work, call use_sandbox instead of answering.";

export function historyMessages(
  turns: Array<{ content: string; reply: string | null }>
): InlineMessage[] {
  return turns.flatMap((turn): InlineMessage[] =>
    turn.reply
      ? [
          { role: "user", content: turn.content },
          { role: "assistant", content: turn.reply },
        ]
      : []
  );
}

export function createInlineDispatch(deps: {
  env: Pick<
    EnvConfig,
    | "INLINE_LLM_BASE_URL"
    | "INLINE_LLM_API_KEY"
    | "INLINE_MODEL"
    | "JEV_API_KEY"
    | "APP_MCP_URL"
    | "APP_TOKEN_URL"
    | "APP_ENGINE_TOKEN"
    | "APP_MCP_NAME"
  >;
  log: Logger;
  messageRepository: Pick<MessageRepository, "listConversationBefore">;
  emit: (event: SandboxEvent) => Promise<void>;
  /** The session owner's memory block, as a sandbox's agent reads it at session start. */
  memory?: () => Promise<string | null>;
  /** The session's public id, sent with each call to the product's tools. */
  sessionId?: () => string | null;
}): InlineDispatch | undefined {
  const baseUrl = deps.env.INLINE_LLM_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  const app = readAppConfig(deps.env);
  const runtime = new InlineRuntime({
    llm: createInlineLlm({ baseUrl, apiKey: deps.env.INLINE_LLM_API_KEY?.trim() ?? "" }),
    model: deps.env.INLINE_MODEL?.trim() || DEFAULT_INLINE_MODEL,
    system: DEFAULT_INLINE_SYSTEM,
    emit: deps.emit,
    history: (messageId) =>
      historyMessages(deps.messageRepository.listConversationBefore(messageId, HISTORY_TURNS)),
    log: deps.log,
    // A product's user gets the product's tools; anyone else gets none.
    tools: async (userId) => {
      const productUser = appUserId(userId);
      return app && productUser
        ? appInlineTools(app, productUser, fetch, deps.sessionId?.())
        : { tools: [] };
    },
    ...(deps.memory ? { memory: deps.memory } : {}),
  });
  return {
    chooseRuntime: createJevRuntimeRouter({
      apiKey: deps.env.JEV_API_KEY?.trim() || undefined,
      log: deps.log,
    }),
    run: (input) => runtime.run(input),
  };
}
