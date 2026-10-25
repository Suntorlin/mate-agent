/**
 * The signed-in user's workflows: saved script DAGs and their runs.
 *
 * - `GET /workflows` — the caller's workflows
 * - `POST /workflows` — save a definition (validated, skill pins checked)
 * - `GET /workflows/:id` — one workflow
 * - `DELETE /workflows/:id` — soft-delete one
 * - `POST /workflows/:id/runs` — start a run with form params (queued)
 * - `GET /workflows/:id/runs` — recent runs
 * - `GET /workflow-runs/:id` — one run with per-step states
 * - `POST /workflow-runs/:id/cancel` — cancel a run that has not finished
 * - `POST /workflow-runs/:id/events` — the runner reports one step event
 *
 * Workflows are private: every query is keyed by the caller. The runner's
 * event route additionally moves the run between queued/starting/running and
 * to its terminal state; the store refuses transitions outside the shared
 * table, so replays and late reports are dropped.
 */

import { Hono } from "hono";
import { getValidHarnessOrDefault } from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault } from "@open-inspect/shared/models";
import {
  createWorkflowInputSchema,
  createWorkflowRunInputSchema,
  sandboxSaveWorkflowInputSchema,
  workflowDefinitionSchema,
  resolveWorkflowRunParams,
  workflowStepEventSchema,
  type WorkflowRunStatus,
} from "@open-inspect/shared/types/workflows";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import { WorkflowRunStore, WorkflowStore, type Workflow, type WorkflowRun } from "../db/workflows";
import { createLogger } from "../logger";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  actingUserId,
  error,
  appUserSelf,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type SandboxRouteContext,
  type UserOrServiceRouteContext,
} from "./shared";

const log = createLogger("router:workflows");

async function handleList(
  _request: Request,
  _env: Env,
  _params: Record<never, never>,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  return json({ workflows: await new WorkflowStore(ctx.db).list(actingUserId(ctx)) });
}

async function handleCreate(
  request: Request,
  _env: Env,
  _params: Record<never, never>,
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, createWorkflowInputSchema, "Invalid workflow");
  if (parsed instanceof Response) return parsed;
  const userId = actingUserId(ctx);
  const store = new WorkflowStore(ctx.db);
  const pinIssues = await store.validatePins(parsed.definition, userId);
  if (pinIssues.length > 0) return error(pinIssues.join("; "), 400);
  const workflow = await store.create(userId, {
    name: parsed.name,
    description: parsed.description,
    definition: parsed.definition,
    sourceSessionId: parsed.sourceSessionId ?? null,
  });
  log.info("workflows.created", { user_id: userId, workflow_id: workflow.id });
  return json({ workflow }, 201);
}

async function handleGet(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const workflow = await new WorkflowStore(ctx.db).get(params.id, actingUserId(ctx));
  if (!workflow) return error("Workflow not found", 404);
  return json({ workflow });
}

async function handleDelete(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const deleted = await new WorkflowStore(ctx.db).delete(params.id, actingUserId(ctx));
  if (!deleted) return error("Workflow not found", 404);
  return json({ ok: true });
}

/**
 * Dispatch a queued run: a hidden agentless session whose sandbox installs
 * the pinned skills (ids selection) and executes the scripts. The manifest
 * resolves current revisions, so the pins must still be current — a stale
 * workflow is refused here, before anything boots.
 */
async function dispatchRun(
  env: Env,
  ctx: UserOrServiceRouteContext,
  workflow: Workflow,
  run: WorkflowRun,
  userId: string
): Promise<Response | null> {
  const skillIds = [...new Set(workflow.definition.steps.map((step) => step.skill.skillId))];
  let manifest;
  try {
    manifest = await resolveManagedSkills(
      ctx.db,
      { repositories: [], environmentId: null },
      { mode: "ids", skillIds },
      userId
    );
  } catch (e) {
    if (e instanceof SkillResolutionError) return error(e.message, e.status);
    throw e;
  }
  const resolvedRevisions = new Map(manifest.skills.map((s) => [s.skillId, s.revisionId]));
  for (const step of workflow.definition.steps) {
    if (resolvedRevisions.get(step.skill.skillId) !== step.skill.revisionId) {
      return error(
        `Step "${step.id}" pins an outdated revision of ${step.skill.name}; update the workflow`,
        409
      );
    }
  }

  const harness = getValidHarnessOrDefault(env.DEFAULT_SESSION_HARNESS);
  let providerAuth;
  try {
    providerAuth = await resolveSessionProviderAuth(ctx.db, { unattended: true, harness });
  } catch (e) {
    if (e instanceof ProviderAccountSelectionPolicyError) return error(e.message, e.status);
    throw e;
  }
  const sessionId = generateId();
  const input: SessionInitInput = {
    sessionId,
    repoOwner: null,
    repoName: null,
    title: `[Workflow] ${workflow.name}`,
    harness,
    model: getValidModelOrDefault(undefined),
    reasoningEffort: null,
    participantUserId: userId,
    platformUserId: userId,
    ownerTeamId: null,
    visibility: "private",
    spawnSource: "automation",
    automationRunId: run.id,
    managedSkillsManifest: manifest,
    providerAuth,
  };
  await initializeSession(env, input, ctx);
  await new WorkflowRunStore(ctx.db).bindSession(run.id, sessionId);
  return null;
}

async function handleCreateRun(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, createWorkflowRunInputSchema, "Invalid run request");
  if (parsed instanceof Response) return parsed;
  const userId = actingUserId(ctx);
  const workflow = await new WorkflowStore(ctx.db).get(params.id, userId);
  if (!workflow) return error("Workflow not found", 404);
  if (!workflow.enabled) return error("Workflow is disabled", 409);
  const resolved = resolveWorkflowRunParams(workflow.definition, parsed.params);
  if (resolved.issues.length > 0) return error(resolved.issues.join("; "), 400);
  const runs = new WorkflowRunStore(ctx.db);
  const run = await runs.create(workflow, userId, resolved.values);
  try {
    const refusal = await dispatchRun(env, ctx, workflow, run, userId);
    if (refusal) {
      await runs.transition(run.id, "failed", { failureReason: "boot_failed" });
      return refusal;
    }
  } catch (e) {
    await runs.transition(run.id, "failed", { failureReason: "internal_error" });
    log.error("workflows.dispatch_failed", {
      run_id: run.id,
      error: e instanceof Error ? e.message : String(e),
      trace_id: ctx.trace_id,
    });
    return error("Failed to start the workflow run", 500);
  }
  log.info("workflows.run_created", { user_id: userId, workflow_id: workflow.id, run_id: run.id });
  return json({ run: await runs.get(run.id, userId) }, 201);
}

async function handleListRuns(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const userId = actingUserId(ctx);
  const workflow = await new WorkflowStore(ctx.db).get(params.id, userId);
  if (!workflow) return error("Workflow not found", 404);
  return json({ runs: await new WorkflowRunStore(ctx.db).listForWorkflow(params.id, userId) });
}

async function handleGetRun(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const run = await new WorkflowRunStore(ctx.db).get(params.id, actingUserId(ctx));
  if (!run) return error("Run not found", 404);
  return json({ run });
}

async function handleCancelRun(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const userId = actingUserId(ctx);
  const store = new WorkflowRunStore(ctx.db);
  const run = await store.get(params.id, userId);
  if (!run) return error("Run not found", 404);
  const moved = await store.transition(params.id, "canceled", { failureReason: "canceled" });
  if (!moved) return error("Run already finished", 409);
  return json({ run: await store.get(params.id, userId) });
}

const stepEventBodySchema = workflowStepEventSchema.omit({ runId: true }).extend({
  /** The runner may fold the run transition into the same report. */
  runStatus: z.enum(["starting", "running", "completed", "failed"]).optional(),
  failureReason: z.enum(["step_failed", "boot_failed", "internal_error"]).optional(),
  executorId: z.string().min(1).optional(),
});

/**
 * Fold one runner report into a run: a step event, optionally moving the
 * run itself. The transition guards make replays and out-of-order reports
 * harmless. Shared by the owner-facing and sandbox-facing routes.
 */
async function applyRunEvent(
  env: Env,
  ctx: RequestContext & { db: UserOrServiceRouteContext["db"] },
  runs: WorkflowRunStore,
  runId: string,
  ownerUserId: string,
  parsed: z.infer<typeof stepEventBodySchema>
): Promise<Response> {
  if (parsed.runStatus === "starting" || parsed.runStatus === "running") {
    // A claim is implicit in the first report: queued → starting → running.
    await runs.transition(runId, "starting", { executorId: parsed.executorId });
    if (parsed.runStatus === "running") {
      await runs.transition(runId, "running", { executorId: parsed.executorId });
    }
  }
  const applied = await runs.applyStepEvent({ ...parsed, runId }, ownerUserId);
  if (parsed.runStatus === "completed" || parsed.runStatus === "failed") {
    const moved = await runs.transition(runId, parsed.runStatus as WorkflowRunStatus, {
      failureReason:
        parsed.runStatus === "failed" ? (parsed.failureReason ?? "step_failed") : undefined,
    });
    if (!moved) return error("Run already finished", 409);
    const run = await runs.get(runId, ownerUserId);
    if (run?.sessionId) await archiveRunSession(env, ctx, run.sessionId, runId);
    return json({ run });
  }
  if (!applied) return error("Event is not a legal step transition", 409);
  return json({ run: await runs.get(runId, ownerUserId) });
}

/** A finished run's session is a never-prompted draft; archiving releases its sandbox. */
async function archiveRunSession(
  env: Env,
  ctx: RequestContext,
  sessionId: string,
  runId: string
): Promise<void> {
  try {
    const response = await createSessionRuntimeClient(env, ctx).fetch(
      sessionId,
      SessionInternalPaths.archive,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    if (!response.ok) throw new Error(`archive answered ${response.status}`);
  } catch (e) {
    // The sandbox still dies by inactivity; losing the early release is not fatal.
    log.warn("workflows.run_session_archive_failed", {
      run_id: runId,
      session_id: sessionId,
      error: e instanceof Error ? e.message : String(e),
      trace_id: ctx.trace_id,
    });
  }
}

async function handleRunEvent(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserOrServiceRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, stepEventBodySchema, "Invalid run event");
  if (parsed instanceof Response) return parsed;
  const userId = actingUserId(ctx);
  const runs = new WorkflowRunStore(ctx.db);
  if (!(await runs.get(params.id, userId))) return error("Run not found", 404);
  return applyRunEvent(env, ctx, runs, params.id, userId, parsed);
}

/** The session owner, for runs addressed through the session's sandbox. */
async function sandboxRunOwner(
  ctx: SandboxRouteContext,
  sessionId: string
): Promise<string | null> {
  return (await new SessionIndexStore(ctx.db).get(sessionId))?.userId ?? null;
}

/** The sandbox asks what it should execute: the run bound to its session. */
async function handleSandboxGetRun(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const run = await new WorkflowRunStore(ctx.db).activeRunForSession(params.id);
  if (!run) return error("No workflow run for this session", 404);
  return json({
    run: { id: run.id, definition: run.definition, params: run.params, status: run.status },
  });
}

/** The executor's liveness ping; renews the sandbox's inactivity window. */
async function handleWorkflowHeartbeat(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  if (!(await new WorkflowRunStore(ctx.db).activeRunForSession(params.id))) {
    return error("No workflow run for this session", 404);
  }
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    params.id,
    SessionInternalPaths.workflowActivity,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!response.ok) return error("Could not renew activity", 502);
  return json({ ok: true });
}

/**
 * `save-workflow`: a session saves its procedure as its owner's
 * workflow. Steps name skills; the control plane resolves each name to the
 * owner's (or the shared) skill at its current revision and pins it. Saving
 * again under the same name replaces the definition.
 */
async function handleSandboxSaveWorkflow(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, sandboxSaveWorkflowInputSchema, "Invalid workflow");
  if (parsed instanceof Response) return parsed;
  const owner = await sandboxRunOwner(ctx, params.id);
  if (!owner) return error("Session not found", 404);
  const store = new WorkflowStore(ctx.db);
  const names = parsed.definition.steps.map((step) => step.skill);
  const pins = await store.resolvePinsByName(names, owner);
  const missing = [...new Set(names)].filter((name) => !pins.has(name));
  if (missing.length > 0) {
    return error(`No runnable skill named: ${missing.join(", ")}. Save the skill first`, 400);
  }
  const definition = workflowDefinitionSchema.parse({
    params: parsed.definition.params,
    steps: parsed.definition.steps.map((step) => ({
      ...step,
      skill: { ...pins.get(step.skill)!, name: step.skill },
    })),
  });
  const existing = await store.findByName(parsed.name, owner);
  const workflow = existing
    ? await store.replaceDefinition(existing.id, owner, {
        description: parsed.description,
        definition,
      })
    : await store.create(owner, {
        name: parsed.name,
        description: parsed.description,
        definition,
        sourceSessionId: params.id,
      });
  log.info("workflows.saved_from_session", {
    session_id: params.id,
    workflow_id: workflow!.id,
    created: !existing,
  });
  return json(
    { created: !existing, workflow: { id: workflow!.id, name: workflow!.name } },
    existing ? 200 : 201
  );
}

/** The runner reports a step event through its sandbox identity. */
async function handleSandboxRunEvent(
  request: Request,
  env: Env,
  params: { id: string; runId: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, stepEventBodySchema, "Invalid run event");
  if (parsed instanceof Response) return parsed;
  const owner = await sandboxRunOwner(ctx, params.id);
  if (!owner) return error("Session not found", 404);
  const runs = new WorkflowRunStore(ctx.db);
  const run = await runs.get(params.runId, owner);
  if (!run || run.sessionId !== params.id) return error("Run not found", 404);
  return applyRunEvent(env, ctx, runs, params.runId, owner, parsed);
}

export const workflowRoutes = new Hono<ControlPlaneHonoEnv>();

const READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf(),
  cacheControl: "private, no-store",
});
const WRITE = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: appUserSelf({ auditAllowed: true }),
});

workflowRoutes.get("/workflows", READ, (c) => dispatch(c, handleList));
workflowRoutes.post("/workflows", WRITE, (c) => dispatch(c, handleCreate));
workflowRoutes.get("/workflows/:id", READ, (c) => dispatch(c, handleGet));
workflowRoutes.delete("/workflows/:id", WRITE, (c) => dispatch(c, handleDelete));
workflowRoutes.post("/workflows/:id/runs", WRITE, (c) => dispatch(c, handleCreateRun));
workflowRoutes.get("/workflows/:id/runs", READ, (c) => dispatch(c, handleListRuns));
workflowRoutes.get("/workflow-runs/:id", READ, (c) => dispatch(c, handleGetRun));
workflowRoutes.post("/workflow-runs/:id/cancel", WRITE, (c) => dispatch(c, handleCancelRun));
workflowRoutes.post("/workflow-runs/:id/events", WRITE, (c) => dispatch(c, handleRunEvent));

const SANDBOX = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  cacheControl: "no-store",
  authorization: NO_AUTHORIZATION,
});

workflowRoutes.get("/sessions/:id/workflow-run", SANDBOX, (c) => dispatch(c, handleSandboxGetRun));
workflowRoutes.post("/sessions/:id/saved-workflows", SANDBOX, (c) =>
  dispatch(c, handleSandboxSaveWorkflow)
);
workflowRoutes.post("/sessions/:id/workflow-heartbeat", SANDBOX, (c) =>
  dispatch(c, handleWorkflowHeartbeat)
);
workflowRoutes.post("/sessions/:id/workflow-runs/:runId/events", SANDBOX, (c) =>
  dispatch(c, handleSandboxRunEvent)
);
