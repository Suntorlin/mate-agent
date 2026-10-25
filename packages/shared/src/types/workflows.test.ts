import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_STEPS,
  canTransitionWorkflowRun,
  canTransitionWorkflowStep,
  deriveWorkflowInvocationStatus,
  isTerminalWorkflowRunStatus,
  resolveWorkflowRunParams,
  workflowDefinitionSchema,
  workflowStepEventSchema,
  type WorkflowStep,
} from "./workflows";

function step(overrides: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return {
    title: overrides.id,
    skill: { skillId: "skill_1", revisionId: "rev_1", name: "cafe-ad" },
    entry: "scripts/run.sh",
    args: [],
    needs: [],
    outputs: {},
    ...overrides,
  };
}

const ratio = { type: "select", label: "画幅", options: ["9:16", "1:1"], default: "9:16" } as const;

describe("workflow definitions", () => {
  it("accepts a two-step pipeline wiring params and outputs", () => {
    const parsed = workflowDefinitionSchema.parse({
      params: { ratio },
      steps: [
        step({ id: "asr", outputs: { srt: "out/captions.srt" } }),
        step({
          id: "cut",
          needs: ["asr"],
          args: ["--ratio", "{{params.ratio}}", "{{ steps.asr.out.srt }}"],
          outputs: { video: "out/final.mp4" },
        }),
      ],
    });
    expect(parsed.steps.map((item) => item.id)).toEqual(["asr", "cut"]);
  });

  it.each([
    [
      "a duplicate step id",
      { steps: [step({ id: "cut" }), step({ id: "cut" })] },
      /Duplicate step id \W*cut/,
    ],
    [
      "an unknown dependency",
      { steps: [step({ id: "cut", needs: ["asr"] })] },
      /needs unknown step \W*asr/,
    ],
    [
      "a dependency cycle",
      { steps: [step({ id: "a", needs: ["b"] }), step({ id: "b", needs: ["a"] })] },
      /cycle through/,
    ],
    [
      "an undeclared param",
      { steps: [step({ id: "cut", args: ["{{params.ratio}}"] })] },
      /undeclared param \W*ratio/,
    ],
    [
      "an undeclared output",
      {
        steps: [
          step({ id: "asr" }),
          step({ id: "cut", needs: ["asr"], args: ["{{steps.asr.out.srt}}"] }),
        ],
      },
      /undeclared output \W*asr\.out\.srt/,
    ],
    [
      "an output of a step it does not depend on",
      {
        steps: [
          step({ id: "asr", outputs: { srt: "out/captions.srt" } }),
          step({ id: "cut", args: ["{{steps.asr.out.srt}}"] }),
        ],
      },
      /uses \W*asr\W* without depending on it/,
    ],
    [
      "a select param without options",
      {
        params: { ratio: { type: "select", label: "画幅" } },
        steps: [step({ id: "cut" })],
      },
      /select without options/,
    ],
  ])("rejects %s", (_name, definition, message) => {
    expect(() => workflowDefinitionSchema.parse(definition)).toThrow(message);
  });

  it("follows outputs through transitive dependencies", () => {
    const parsed = workflowDefinitionSchema.parse({
      steps: [
        step({ id: "a", outputs: { file: "out/a.txt" } }),
        step({ id: "b", needs: ["a"] }),
        step({ id: "c", needs: ["b"], args: ["{{steps.a.out.file}}"] }),
      ],
    });
    expect(parsed.steps).toHaveLength(3);
  });

  it("treats text outside placeholders as literal", () => {
    const parsed = workflowDefinitionSchema.parse({
      steps: [step({ id: "cut", args: ["--label", "{params.missing} $HOME {{not a ref}}"] })],
    });
    expect(parsed.steps[0].args[1]).toContain("$HOME");
  });

  it("bounds the step count", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, index) =>
      step({ id: `s${index}` })
    );
    expect(() => workflowDefinitionSchema.parse({ steps })).toThrow();
  });
});

describe("run and step state machines", () => {
  it("allows only the documented run transitions", () => {
    expect(canTransitionWorkflowRun("queued", "starting")).toBe(true);
    expect(canTransitionWorkflowRun("starting", "running")).toBe(true);
    expect(canTransitionWorkflowRun("running", "completed")).toBe(true);
    expect(canTransitionWorkflowRun("queued", "running")).toBe(false);
    expect(canTransitionWorkflowRun("completed", "failed")).toBe(false);
    expect(canTransitionWorkflowRun("failed", "running")).toBe(false);
    expect(canTransitionWorkflowRun("canceled", "queued")).toBe(false);
  });

  it("keeps terminal states terminal", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(isTerminalWorkflowRunStatus(status)).toBe(true);
    }
    for (const status of ["queued", "starting", "running"] as const) {
      expect(isTerminalWorkflowRunStatus(status)).toBe(false);
    }
  });

  it("lets steps be skipped only before they start", () => {
    expect(canTransitionWorkflowStep("pending", "skipped")).toBe(true);
    expect(canTransitionWorkflowStep("pending", "running")).toBe(true);
    expect(canTransitionWorkflowStep("running", "skipped")).toBe(false);
    expect(canTransitionWorkflowStep("running", "failed")).toBe(true);
    expect(canTransitionWorkflowStep("pending", "completed")).toBe(false);
    expect(canTransitionWorkflowStep("failed", "running")).toBe(false);
  });

  it.each([
    [[], "canceled"],
    [["queued", "queued"], "queued"],
    [["starting", "queued"], "starting"],
    [["running", "queued"], "running"],
    [["completed", "queued"], "running"],
    [["completed", "completed"], "completed"],
    [["completed", "failed"], "partial_failed"],
    [["failed", "failed"], "failed"],
    [["canceled", "canceled"], "canceled"],
    [["completed", "canceled"], "completed"],
  ] as const)("derives invocation status of %j as %s", (runs, expected) => {
    expect(deriveWorkflowInvocationStatus([...runs])).toBe(expected);
  });

  it("validates runner step events", () => {
    const event = workflowStepEventSchema.parse({
      runId: "run_1",
      stepId: "cut",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      exitCode: 0,
      logTail: "done",
    });
    expect(event.stepId).toBe("cut");
    expect(() =>
      workflowStepEventSchema.parse({ runId: "run_1", stepId: "Cut!", status: "completed" })
    ).toThrow();
  });
});

describe("run params", () => {
  const params = {
    ratio: { type: "select", label: "画幅", options: ["9:16", "1:1"], default: "9:16" },
    title: { type: "string", label: "标题", required: true },
    count: { type: "number", label: "条数" },
  } as const;

  it("applies defaults and keeps submitted values", () => {
    const resolved = resolveWorkflowRunParams({ params }, { title: "咖啡" });
    expect(resolved.issues).toEqual([]);
    expect(resolved.values).toEqual({ ratio: "9:16", title: "咖啡" });
  });

  it.each([
    [{}, /required/],
    [{ title: "x", nope: "1" }, /Unknown param \W*nope/],
    [{ title: "x", ratio: "4:3" }, /must be one of/],
    [{ title: "x", count: "abc" }, /must be a number/],
  ] as const)("flags %j", (submitted, message) => {
    const resolved = resolveWorkflowRunParams({ params }, { ...submitted });
    expect(resolved.issues.join("\n")).toMatch(message);
  });
});
