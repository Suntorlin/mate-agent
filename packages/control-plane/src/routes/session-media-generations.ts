/**
 * A product's media generations (see `@open-inspect/shared/types/media-generation`).
 *
 * `POST /sessions/:id/media-generations` — the session owner's product (`app` service, acting as
 * the owner) reports a generation it started or finished for the session, or the session's
 * sandbox reports one it saw (sandbox token). The session checks the report, merges it into the
 * generation's `media_generation` event and shows it. 201 (new generation) / 200
 * `{ event, recorded }`; 400 with `issues` for a bad report; 409 for a new generation outside a
 * turn.
 */

import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import { requireSession, SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE } from "./shared";

async function handleReportGeneration(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  return ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.mediaGeneration, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}

export const sessionMediaGenerationRoutes = new Hono<ControlPlaneHonoEnv>();

sessionMediaGenerationRoutes.post(
  "/sessions/:id/media-generations",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
    authorization: requireSession("collaborate"),
    cacheControl: "no-store",
  }),
  (c) => dispatchSession(c, handleReportGeneration)
);
