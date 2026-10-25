/**
 * Workflows and their runs.
 *
 * The store owns every status write and refuses anything outside the shared
 * transition table, so a stale executor or a late runner report can never
 * resurrect a terminal run. A run freezes the definition it executes.
 */

import {
  canTransitionWorkflowRun,
  canTransitionWorkflowStep,
  isTerminalWorkflowRunStatus,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRunFailureReason,
  type WorkflowRunStatus,
  type WorkflowRunStepStatus,
  type WorkflowStepEvent,
} from "@open-inspect/shared/types/workflows";
import { generateId } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export interface Workflow {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  definitionSha256: string;
  enabled: boolean;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunStepState {
  status: WorkflowRunStepStatus;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  logTail?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  failureReason: WorkflowRunFailureReason | null;
  params: Record<string, string>;
  definition: WorkflowDefinition;
  steps: Record<string, WorkflowRunStepState>;
  executorId: string | null;
  sessionId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface WorkflowRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  definition: string;
  definition_sha256: string;
  enabled: number;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  owner_user_id: string;
  status: WorkflowRunStatus;
  failure_reason: WorkflowRunFailureReason | null;
  params: string;
  definition: string;
  steps: string;
  executor_id: string | null;
  session_id: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function parseDefinition(raw: string): WorkflowDefinition {
  return workflowDefinitionSchema.parse(JSON.parse(raw));
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: parseDefinition(row.definition),
    definitionSha256: row.definition_sha256,
    enabled: row.enabled === 1,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    failureReason: row.failure_reason,
    params: JSON.parse(row.params) as Record<string, string>,
    definition: parseDefinition(row.definition),
    steps: JSON.parse(row.steps) as Record<string, WorkflowRunStepState>,
    executorId: row.executor_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WorkflowStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Every pinned step must point at a revision of a skill the owner may run:
   * a shared skill or their own. Returns the problems, empty when saveable.
   */
  async validatePins(definition: WorkflowDefinition, ownerUserId: string): Promise<string[]> {
    const issues: string[] = [];
    for (const step of definition.steps) {
      const row = await this.db
        .prepare(
          `SELECT s.id FROM skills s
           JOIN skill_revisions r ON r.skill_id = s.id
           WHERE s.id = ? AND r.id = ? AND s.deleted_at IS NULL
             AND (s.owner_user_id IS NULL OR s.owner_user_id = ?)`
        )
        .bind(step.skill.skillId, step.skill.revisionId, ownerUserId)
        .first<{ id: string }>();
      if (!row) {
        issues.push(`Step "${step.id}" pins a skill revision the owner cannot run`);
      }
    }
    return issues;
  }

  async create(
    ownerUserId: string,
    input: {
      name: string;
      description: string;
      definition: WorkflowDefinition;
      sourceSessionId?: string | null;
    }
  ): Promise<Workflow> {
    const id = `wf_${generateId()}`;
    const now = Date.now();
    const definition = JSON.stringify(input.definition);
    await this.db
      .prepare(
        `INSERT INTO workflows (id, owner_user_id, name, description, definition, definition_sha256,
           enabled, source_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .bind(
        id,
        ownerUserId,
        input.name,
        input.description,
        definition,
        await sha256Hex(definition),
        input.sourceSessionId ?? null,
        now,
        now
      )
      .run();
    return (await this.get(id, ownerUserId))!;
  }

  async get(id: string, ownerUserId: string): Promise<Workflow | null> {
    const row = await this.db
      .prepare("SELECT * FROM workflows WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL")
      .bind(id, ownerUserId)
      .first<WorkflowRow>();
    return row ? toWorkflow(row) : null;
  }

  /**
   * Resolve step skill names to pins the owner may run: their own skill of
   * that name first, else the shared one. Returns the pins found; a name
   * missing from the map has no runnable skill.
   */
  async resolvePinsByName(
    names: readonly string[],
    ownerUserId: string
  ): Promise<Map<string, { skillId: string; revisionId: string }>> {
    const pins = new Map<string, { skillId: string; revisionId: string }>();
    for (const name of new Set(names)) {
      const row = await this.db
        .prepare(
          `SELECT id, current_revision_id FROM skills
           WHERE name = ? AND deleted_at IS NULL AND current_revision_id IS NOT NULL
             AND (owner_user_id = ? OR owner_user_id IS NULL)
           ORDER BY owner_user_id IS NULL LIMIT 1`
        )
        .bind(name, ownerUserId)
        .first<{ id: string; current_revision_id: string }>();
      if (row) pins.set(name, { skillId: row.id, revisionId: row.current_revision_id });
    }
    return pins;
  }

  async findByName(name: string, ownerUserId: string): Promise<Workflow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM workflows WHERE name = ? AND owner_user_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`
      )
      .bind(name, ownerUserId)
      .first<WorkflowRow>();
    return row ? toWorkflow(row) : null;
  }

  /** Saving again under a name replaces the definition; past runs keep their frozen copy. */
  async replaceDefinition(
    id: string,
    ownerUserId: string,
    input: { description: string; definition: WorkflowDefinition }
  ): Promise<Workflow | null> {
    const definition = JSON.stringify(input.definition);
    const result = await this.db
      .prepare(
        `UPDATE workflows SET description = ?, definition = ?, definition_sha256 = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
      )
      .bind(input.description, definition, await sha256Hex(definition), Date.now(), id, ownerUserId)
      .run();
    return result.meta.changes > 0 ? this.get(id, ownerUserId) : null;
  }

  async list(ownerUserId: string): Promise<Workflow[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM workflows WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
      )
      .bind(ownerUserId)
      .all<WorkflowRow>();
    return rows.results.map(toWorkflow);
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE workflows SET deleted_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL"
      )
      .bind(Date.now(), id, ownerUserId)
      .run();
    return result.meta.changes > 0;
  }
}

export class WorkflowRunStore {
  constructor(private readonly db: SqlDatabase) {}

  /** A run starts queued, with every step pending and the definition frozen. */
  async create(
    workflow: Workflow,
    ownerUserId: string,
    params: Record<string, string>
  ): Promise<WorkflowRun> {
    const id = `wfrun_${generateId()}`;
    const steps = Object.fromEntries(
      workflow.definition.steps.map((step) => [step.id, { status: "pending" }])
    );
    await this.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, owner_user_id, status, params, definition,
           steps, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .bind(
        id,
        workflow.id,
        ownerUserId,
        JSON.stringify(params),
        JSON.stringify(workflow.definition),
        JSON.stringify(steps),
        Date.now()
      )
      .run();
    return (await this.get(id, ownerUserId))!;
  }

  async get(id: string, ownerUserId: string): Promise<WorkflowRun | null> {
    const row = await this.db
      .prepare("SELECT * FROM workflow_runs WHERE id = ? AND owner_user_id = ?")
      .bind(id, ownerUserId)
      .first<WorkflowRunRow>();
    return row ? toRun(row) : null;
  }

  /** Record which session's sandbox a dispatched run executes in. */
  async bindSession(id: string, sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE workflow_runs SET session_id = ? WHERE id = ? AND session_id IS NULL")
      .bind(sessionId, id)
      .run();
  }

  /**
   * The run a session's sandbox should be executing: bound to that session
   * and not finished. The sandbox proves it is the session's current one
   * through route admission, so no owner key is needed here.
   */
  async activeRunForSession(sessionId: string): Promise<WorkflowRun | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE session_id = ?
           AND status IN ('queued', 'starting', 'running')
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(sessionId)
      .first<WorkflowRunRow>();
    return row ? toRun(row) : null;
  }

  async listForWorkflow(workflowId: string, ownerUserId: string): Promise<WorkflowRun[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE workflow_id = ? AND owner_user_id = ?
         ORDER BY created_at DESC LIMIT 100`
      )
      .bind(workflowId, ownerUserId)
      .all<WorkflowRunRow>();
    return rows.results.map(toRun);
  }

  /**
   * Guarded status change: the UPDATE carries the expected source states, so
   * two writers race safely and terminal rows never move. Returns false when
   * the row was not in a source state the transition table allows.
   */
  async transition(
    id: string,
    to: WorkflowRunStatus,
    options: { failureReason?: WorkflowRunFailureReason; executorId?: string } = {}
  ): Promise<boolean> {
    const sources = (
      ["queued", "starting", "running"] as const satisfies readonly WorkflowRunStatus[]
    ).filter((from) => canTransitionWorkflowRun(from, to));
    if (sources.length === 0) return false;
    const reason = options.failureReason ?? null;
    if ((reason !== null) !== (to === "failed" || to === "canceled")) {
      throw new Error(`A ${to} run ${reason ? "cannot carry" : "requires"} a failure reason`);
    }
    const now = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs SET status = ?, failure_reason = ?,
           executor_id = COALESCE(?, executor_id),
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN ? ELSE completed_at END
         WHERE id = ? AND status IN (${sources.map(() => "?").join(", ")})`
      )
      .bind(to, reason, options.executorId ?? null, to, now, to, now, id, ...sources)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Fold one runner step event into the run. Illegal step transitions and
   * events against terminal runs are refused, not applied.
   */
  async applyStepEvent(event: WorkflowStepEvent, ownerUserId: string): Promise<WorkflowRun | null> {
    const run = await this.get(event.runId, ownerUserId);
    if (!run || isTerminalWorkflowRunStatus(run.status)) return null;
    const current = run.steps[event.stepId];
    if (!current || !canTransitionWorkflowStep(current.status, event.status)) return null;
    run.steps[event.stepId] = {
      status: event.status,
      startedAt: event.startedAt ?? current.startedAt,
      completedAt: event.completedAt ?? current.completedAt,
      exitCode: event.exitCode ?? current.exitCode,
      logTail: event.logTail ?? current.logTail,
    };
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs SET steps = ?
         WHERE id = ? AND status IN ('queued', 'starting', 'running')`
      )
      .bind(JSON.stringify(run.steps), event.runId)
      .run();
    return result.meta.changes > 0 ? run : null;
  }
}
