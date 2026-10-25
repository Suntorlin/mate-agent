/**
 * Questions the agent asks the user (see `@open-inspect/shared/types/questions`).
 *
 * `POST /sessions/:id/questions` — the sandbox's `ask_user` tool (sandbox
 * token). The session checks the card, records a `question` event on the
 * running turn and shows it. 201 `{ questionId, messageId }`; 400 with
 * `issues` the agent can fix; 409 outside a turn.
 *
 * `POST /sessions/:id/questions/:questionId/answer` — the user answers,
 * presses a secondary button or closes the card, in the browser or through
 * the product acting for them. Only the session's owner may answer. The
 * answer is queued as a prompt through the same entry and author resolution
 * as `POST /sessions/:id/prompt`, then a `question_answered` event is
 * recorded. 200 `{ questionId, messageId, status: "queued" }`; 404 unknown
 * question; 409 already answered (or the prompt refused, as for a prompt).
 */

import { Hono } from "hono";
import { answerQuestionRequestSchema } from "@open-inspect/shared/types/questions";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { applyIdentityEnforcement } from "../routing/identity-enforcement";
import { SessionInternalPaths } from "../session/contracts";
import type { InternalQuestionAnswerRequest } from "../session/questions";
import type { Env } from "../types";
import { parseJsonBody } from "./body";
import { resolvePromptAuthor, touchSessionAfterPrompt } from "./session-prompt";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import {
  actingUserId,
  error,
  json,
  NO_AUTHORIZATION,
  requireSession,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type UserOrServiceRouteContext,
} from "./shared";

const logger = createLogger("router:session-questions");

async function handleAskUser(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  return ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.question, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}

export async function handleAnswerQuestion(
  request: Request,
  _env: Env,
  params: { id: string; questionId: string },
  ctx: SessionRouteContext & UserOrServiceRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const rawBody = await parseJsonBody(request);
  if (rawBody instanceof Response) return rawBody;

  const enforcement = applyIdentityEnforcement(ctx, "prompt", rawBody);
  if (enforcement.rejection) return enforcement.rejection;

  const answer = answerQuestionRequestSchema.safeParse(rawBody);
  if (!answer.success) {
    return json(
      {
        error: "Invalid answer",
        issues: answer.error.issues.map((issue) =>
          issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
        ),
      },
      400
    );
  }

  // The question was asked of the person whose session this is; collaborators
  // and admins may watch, but the answer is the owner's.
  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!session) return error("Session not found", 404);
  if (!session.userId || session.userId !== actingUserId(ctx)) {
    logger.warn("question.answer_not_owner", {
      event: "question.answer_not_owner",
      session_id: sessionId,
      question_id: params.questionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Only the session's owner can answer its questions", 403);
  }

  const author = await resolvePromptAuthor(request, ctx, enforcement.enforced);
  const internal: InternalQuestionAnswerRequest = {
    questionId: params.questionId,
    answer: answer.data,
    author,
  };
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.questionAnswer, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(internal),
  });
  if (response.ok) touchSessionAfterPrompt(ctx, sessionId);
  return response;
}

export const sessionQuestionRoutes = new Hono<ControlPlaneHonoEnv>();

sessionQuestionRoutes.post(
  "/sessions/:id/questions",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    authorization: NO_AUTHORIZATION,
    cacheControl: "no-store",
  }),
  (c) => dispatchSession(c, handleAskUser)
);

// Open to a service acting for a user as well as to a browser session:
// the product relays the user who owns the session.
sessionQuestionRoutes.post(
  "/sessions/:id/questions/:questionId/answer",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("collaborate"),
    cacheControl: "no-store",
  }),
  (c) => dispatchSession(c, handleAnswerQuestion)
);
