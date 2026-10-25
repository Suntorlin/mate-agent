/**
 * User workflows: a session's settled procedure compiled into a reusable,
 * parameterized DAG of skill scripts.
 *
 * A workflow runs without an agent: the runner boots a sandbox, installs the
 * pinned skill revisions, and executes each step's entry script in dependency
 * order, so a run costs no model tokens. The agent is involved only when the
 * workflow is authored (distilling a session) or repaired (a failed run opens
 * an interactive session carrying the pinned skill and the step's log).
 *
 * Definitions are immutable: editing a workflow produces a new version, the
 * same way editing a skill produces a new revision. Runs record the version
 * they executed, so a run's meaning never changes after the fact.
 */

import { z } from "zod";
import { skillNameSchema } from "./skills";

export const MAX_WORKFLOW_NAME_LENGTH = 200;
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 2000;
export const MAX_WORKFLOW_STEPS = 50;
export const MAX_WORKFLOW_PARAMS = 50;
export const MAX_WORKFLOW_STEP_ARGS = 100;
export const MAX_WORKFLOW_ARG_LENGTH = 2000;
export const MAX_WORKFLOW_OUTPUTS_PER_STEP = 20;
export const WORKFLOW_LIST_PAGE_SIZE = 100;

/** Step ids, param names and output names share one shape: short, machine-safe. */
export const workflowIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "Use lowercase letters, digits, '-' or '_', 64 chars max");

/**
 * The only dynamic values an argument template may splice in. `params.*` is
 * the run's input form; `steps.<id>.out.<name>` is a declared output path of
 * an earlier step. Anything else in an argument is literal text.
 */
export const WORKFLOW_TEMPLATE_PATTERN =
  /\{\{\s*(params\.[a-z][a-z0-9_-]*|steps\.[a-z][a-z0-9_-]*\.out\.[a-z][a-z0-9_-]*)\s*\}\}/g;

export const workflowParamSchema = z.strictObject({
  /** Form control the UI renders; every value reaches the script as a string. */
  type: z.enum(["string", "number", "boolean", "select"]),
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  default: z.string().max(MAX_WORKFLOW_ARG_LENGTH).optional(),
  /** Choices for `select`; absent otherwise. */
  options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  required: z.boolean().optional(),
});

export type WorkflowParam = z.infer<typeof workflowParamSchema>;

export const workflowStepSchema = z.strictObject({
  id: workflowIdentifierSchema,
  title: z.string().min(1).max(200),
  /** The pinned script source: a skill the owner can run, at an exact revision. */
  skill: z.strictObject({
    skillId: z.string().min(1),
    revisionId: z.string().min(1),
    /** Denormalized for display; the revision ids are what executes. */
    name: skillNameSchema,
  }),
  /** Path of the executable inside the skill, e.g. "scripts/run.sh". */
  entry: z.string().min(1).max(240),
  /** Literal strings, with {{params.x}} / {{steps.y.out.z}} placeholders. */
  args: z.array(z.string().max(MAX_WORKFLOW_ARG_LENGTH)).max(MAX_WORKFLOW_STEP_ARGS).default([]),
  /** Steps that must complete first; their outputs become referenceable. */
  needs: z.array(workflowIdentifierSchema).max(MAX_WORKFLOW_STEPS).default([]),
  /** Workspace-relative paths this step promises to produce. */
  outputs: z
    .record(workflowIdentifierSchema, z.string().min(1).max(500))
    .refine((value) => Object.keys(value).length <= MAX_WORKFLOW_OUTPUTS_PER_STEP, {
      message: `A step declares at most ${MAX_WORKFLOW_OUTPUTS_PER_STEP} outputs`,
    })
    .default({}),
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/**
 * Structural validity beyond field shapes: unique step ids, needs that exist
 * and form no cycle, and templates that reference declared params and only
 * outputs of (transitive) dependencies.
 */
export const workflowDefinitionSchema = z
  .strictObject({
    steps: z.array(workflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS),
    params: z
      .record(workflowIdentifierSchema, workflowParamSchema)
      .refine((value) => Object.keys(value).length <= MAX_WORKFLOW_PARAMS, {
        message: `A workflow declares at most ${MAX_WORKFLOW_PARAMS} params`,
      })
      .default({}),
  })
  .superRefine((definition, context) => {
    for (const issue of validateWorkflowStructure(definition)) {
      context.addIssue({ code: "custom", message: issue });
    }
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Ordered structural problems; empty means the definition is executable. */
type StructuralStep = Pick<WorkflowStep, "id" | "args" | "needs" | "outputs">;

export function validateWorkflowStructure(definition: {
  steps: StructuralStep[];
  params: Record<string, WorkflowParam>;
}): string[] {
  const issues: string[] = [];
  const stepsById = new Map<string, StructuralStep>();
  for (const step of definition.steps) {
    if (stepsById.has(step.id)) issues.push(`Duplicate step id "${step.id}"`);
    stepsById.set(step.id, step);
  }

  for (const [name, param] of Object.entries(definition.params)) {
    if (param.type === "select" && !param.options) {
      issues.push(`Param "${name}" is a select without options`);
    }
    if (param.type !== "select" && param.options) {
      issues.push(`Param "${name}" has options but is not a select`);
    }
  }

  for (const step of definition.steps) {
    for (const need of step.needs) {
      if (need === step.id) issues.push(`Step "${step.id}" depends on itself`);
      else if (!stepsById.has(need)) {
        issues.push(`Step "${step.id}" needs unknown step "${need}"`);
      }
    }
  }
  if (issues.length > 0) return issues;

  // Cycle check doubles as the reachability map for template references.
  const reachable = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (id: string): Set<string> | null => {
    const known = reachable.get(id);
    if (known) return known;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const ancestors = new Set<string>();
    for (const need of stepsById.get(id)?.needs ?? []) {
      const upstream = visit(need);
      if (upstream === null) return null;
      ancestors.add(need);
      for (const ancestor of upstream) ancestors.add(ancestor);
    }
    visiting.delete(id);
    reachable.set(id, ancestors);
    return ancestors;
  };
  for (const step of definition.steps) {
    if (visit(step.id) === null) {
      return [`Step dependencies contain a cycle through "${step.id}"`];
    }
  }

  for (const step of definition.steps) {
    for (const argument of step.args) {
      for (const match of argument.matchAll(WORKFLOW_TEMPLATE_PATTERN)) {
        const reference = match[1].trim();
        if (reference.startsWith("params.")) {
          const name = reference.slice("params.".length);
          if (!definition.params[name]) {
            issues.push(`Step "${step.id}" references undeclared param "${name}"`);
          }
          continue;
        }
        const [, sourceId, , outputName] = reference.split(".");
        const source = stepsById.get(sourceId);
        if (!source) {
          issues.push(`Step "${step.id}" references unknown step "${sourceId}"`);
        } else if (!(outputName in source.outputs)) {
          issues.push(
            `Step "${step.id}" references undeclared output "${sourceId}.out.${outputName}"`
          );
        } else if (!reachable.get(step.id)?.has(sourceId)) {
          issues.push(`Step "${step.id}" uses "${sourceId}" without depending on it`);
        }
      }
    }
  }
  return issues;
}

export const savedWorkflowStepSchema = workflowStepSchema
  .omit({ skill: true })
  .extend({ skill: skillNameSchema });

export type SavedWorkflowStep = z.infer<typeof savedWorkflowStepSchema>;

/** What `save-workflow` sends from a session: skills by name, no pins. */
export const sandboxSaveWorkflowInputSchema = z.strictObject({
  name: z.string().min(1).max(MAX_WORKFLOW_NAME_LENGTH),
  description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).default(""),
  definition: z
    .strictObject({
      steps: z.array(savedWorkflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS),
      params: z
        .record(workflowIdentifierSchema, workflowParamSchema)
        .refine((value) => Object.keys(value).length <= MAX_WORKFLOW_PARAMS, {
          message: `A workflow declares at most ${MAX_WORKFLOW_PARAMS} params`,
        })
        .default({}),
    })
    .superRefine((definition, context) => {
      for (const issue of validateWorkflowStructure(definition)) {
        context.addIssue({ code: "custom", message: issue });
      }
    }),
});

export type SandboxSaveWorkflowInput = z.infer<typeof sandboxSaveWorkflowInputSchema>;

export const createWorkflowInputSchema = z.strictObject({
  name: z.string().min(1).max(MAX_WORKFLOW_NAME_LENGTH),
  description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).default(""),
  definition: workflowDefinitionSchema,
  sourceSessionId: z.string().min(1).optional(),
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;

/** Values a run starts with; every value reaches the scripts as a string. */
export const workflowRunParamsSchema = z.record(
  workflowIdentifierSchema,
  z.string().max(MAX_WORKFLOW_ARG_LENGTH)
);

export type WorkflowRunParams = z.infer<typeof workflowRunParamsSchema>;

export const createWorkflowRunInputSchema = z.strictObject({
  params: workflowRunParamsSchema.default({}),
});

export type CreateWorkflowRunInput = z.infer<typeof createWorkflowRunInputSchema>;

/**
 * Check submitted run values against the definition's param declarations.
 * Returns the resolved values (defaults applied) or the problems found.
 */
export function resolveWorkflowRunParams(
  definition: Pick<WorkflowDefinition, "params">,
  submitted: WorkflowRunParams
): { values: Record<string, string>; issues: string[] } {
  const issues: string[] = [];
  const values: Record<string, string> = {};
  for (const name of Object.keys(submitted)) {
    if (!definition.params[name]) issues.push(`Unknown param "${name}"`);
  }
  for (const [name, param] of Object.entries(definition.params)) {
    const value = submitted[name] ?? param.default;
    if (value === undefined) {
      if (param.required) issues.push(`Param "${name}" is required`);
      continue;
    }
    if (param.type === "select" && param.options && !param.options.includes(value)) {
      issues.push(`Param "${name}" must be one of: ${param.options.join(", ")}`);
      continue;
    }
    if (param.type === "number" && !Number.isFinite(Number(value))) {
      issues.push(`Param "${name}" must be a number`);
      continue;
    }
    if (param.type === "boolean" && value !== "true" && value !== "false") {
      issues.push(`Param "${name}" must be "true" or "false"`);
      continue;
    }
    values[name] = value;
  }
  return { values, issues };
}

/**
 * The run state machine, shared by the control plane (which owns every row
 * transition, CAS-guarded), the runner (which only reports step events), the
 * canvas projection and the UI.
 *
 *   queued → starting → running → completed
 *      │         │          ├──→ failed
 *      │         │          └──→ canceled
 *      ├────────→│──────────────→ failed   (boot_failed / execution_timeout)
 *      └─────────┴──────────────→ canceled
 *
 * `queued`: the run exists and waits for an executor lease. `starting`: an
 * executor claimed it and is booting/installing pinned skills. `running`:
 * steps are executing. Terminal states are immutable; a late runner report
 * against a terminal run is dropped and logged, never applied.
 */
export const workflowRunStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "canceled",
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const WORKFLOW_RUN_TRANSITIONS: Readonly<
  Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>
> = {
  queued: ["starting", "canceled", "failed"],
  starting: ["running", "failed", "canceled"],
  running: ["completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return WORKFLOW_RUN_TRANSITIONS[status].length === 0;
}

export function canTransitionWorkflowRun(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return WORKFLOW_RUN_TRANSITIONS[from].includes(to);
}

/**
 * Why a run ended short of `completed`; set exactly when the status turns
 * terminal-unsuccessful and never on `completed`.
 */
export const workflowRunFailureReasonSchema = z.enum([
  /** A step's script exited non-zero or a declared output was missing. */
  "step_failed",
  /** The sandbox or skill installation never became ready. */
  "boot_failed",
  /** The run passed its execution deadline; the recovery sweep closed it. */
  "execution_timeout",
  /** The owner canceled the run. */
  "canceled",
  /** The engine's own fault — anything that is a bug on our side. */
  "internal_error",
]);

export type WorkflowRunFailureReason = z.infer<typeof workflowRunFailureReasonSchema>;

/**
 * Step states carry the run's detail. `skipped` means "never ran on
 * purpose": an upstream step failed or the run was canceled first. A step
 * killed mid-flight is `failed`, with the run's failureReason saying why.
 *
 *   pending → running → completed | failed
 *      └──────────────→ skipped
 */
export const workflowRunStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type WorkflowRunStepStatus = z.infer<typeof workflowRunStepStatusSchema>;

export const WORKFLOW_STEP_TRANSITIONS: Readonly<
  Record<WorkflowRunStepStatus, readonly WorkflowRunStepStatus[]>
> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
  skipped: [],
};

export function canTransitionWorkflowStep(
  from: WorkflowRunStepStatus,
  to: WorkflowRunStepStatus
): boolean {
  return WORKFLOW_STEP_TRANSITIONS[from].includes(to);
}

export const MAX_WORKFLOW_STEP_LOG_TAIL_CHARS = 4000;

/**
 * What the runner reports upward; the control plane folds these into run
 * rows and refuses events that are not legal transitions. Timestamps are
 * epoch milliseconds from the control plane's clock domain where possible;
 * runner-local times are advisory for durations only.
 */
export const workflowStepEventSchema = z.strictObject({
  runId: z.string().min(1),
  stepId: workflowIdentifierSchema,
  status: workflowRunStepStatusSchema,
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  /** Last lines of combined output, for the card and the repair session. */
  logTail: z.string().max(MAX_WORKFLOW_STEP_LOG_TAIL_CHARS).optional(),
});

export type WorkflowStepEvent = z.infer<typeof workflowStepEventSchema>;

/**
 * Aggregate of an invocation's runs (an automation firing several
 * workflows). Derived, never stored: `partial_failed` is some-but-not-all
 * failed; otherwise the worst child state wins.
 */
export const workflowInvocationStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "partial_failed",
  "canceled",
]);

export type WorkflowInvocationStatus = z.infer<typeof workflowInvocationStatusSchema>;

export function deriveWorkflowInvocationStatus(
  runs: readonly WorkflowRunStatus[]
): WorkflowInvocationStatus {
  if (runs.length === 0) return "canceled";
  if (runs.some((status) => !isTerminalWorkflowRunStatus(status))) {
    if (runs.every((status) => status === "queued")) return "queued";
    if (runs.some((status) => status === "running" || isTerminalWorkflowRunStatus(status))) {
      return "running";
    }
    return "starting";
  }
  const failed = runs.filter((status) => status === "failed").length;
  if (failed === runs.length) return "failed";
  if (failed > 0) return "partial_failed";
  if (runs.every((status) => status === "canceled")) return "canceled";
  return "completed";
}
