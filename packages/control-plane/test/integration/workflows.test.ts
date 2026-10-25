import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowRun } from "../../src/db/workflows";
import type { Workflow } from "../../src/db/workflows";
import { cleanD1Tables } from "./cleanup";
import { env, SELF } from "cloudflare:test";
import { seedSandboxAuthHash, serviceFetch } from "./helpers";

const USER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const asA = { as: { userId: USER_A, role: "member" as const } };
const asB = { as: { userId: USER_B, role: "member" as const } };

function skillMarkdown(name: string) {
  return `---\nname: ${name}\ndescription: Cut a clip. Use for clips.\n---\n\n# ${name}\n\nRun it.\n`;
}

/** Save a personal skill and return its id and current revision id. */
async function saveSkill(name: string): Promise<{ skillId: string; revisionId: string }> {
  const saved = await serviceFetch("https://test.local/my-skills", {
    method: "POST",
    body: JSON.stringify({
      files: [
        { path: "SKILL.md", content: skillMarkdown(name) },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho ok\n", executable: true },
      ],
    }),
    ...asA,
  });
  expect(saved.status).toBe(201);
  const { skill } = (await saved.json()) as { skill: { key: string } };
  const detail = await serviceFetch(`https://test.local/my-skills/${skill.key}`, asA);
  const body = (await detail.json()) as { skill: { key: string; revisionId?: string } };
  // The personal skill detail does not expose revision ids; read them from D1.
  const { env } = await import("cloudflare:test");
  const row = await env.DB.prepare("SELECT id, current_revision_id FROM skills WHERE id = ?")
    .bind(body.skill.key)
    .first<{ id: string; current_revision_id: string }>();
  return { skillId: row!.id, revisionId: row!.current_revision_id };
}

function definitionWith(pin: { skillId: string; revisionId: string }) {
  return {
    params: {
      ratio: { type: "select", label: "画幅", options: ["9:16", "1:1"], default: "9:16" },
    },
    steps: [
      {
        id: "asr",
        title: "转写",
        skill: { ...pin, name: "clip-cutter" },
        entry: "scripts/run.sh",
        args: [],
        needs: [],
        outputs: { srt: "out/captions.srt" },
      },
      {
        id: "cut",
        title: "剪辑",
        skill: { ...pin, name: "clip-cutter" },
        entry: "scripts/run.sh",
        args: ["--ratio", "{{params.ratio}}", "{{steps.asr.out.srt}}"],
        needs: ["asr"],
        outputs: { video: "out/final.mp4" },
      },
    ],
  };
}

async function createWorkflow(pin: { skillId: string; revisionId: string }): Promise<Workflow> {
  const response = await serviceFetch("https://test.local/workflows", {
    method: "POST",
    body: JSON.stringify({ name: "剪一条", definition: definitionWith(pin) }),
    ...asA,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { workflow: Workflow }).workflow;
}

async function event(runId: string, body: Record<string, unknown>, user = asA) {
  return serviceFetch(`https://test.local/workflow-runs/${runId}/events`, {
    method: "POST",
    body: JSON.stringify(body),
    ...user,
  });
}

describe("workflows", () => {
  beforeEach(cleanD1Tables);

  it("saves, runs and completes a workflow through runner events", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);
    expect(workflow.definitionSha256).toMatch(/^[0-9a-f]{64}$/);

    // Unknown param and bad select value are refused at run creation.
    const bad = await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ params: { ratio: "4:3" } }),
      ...asA,
    });
    expect(bad.status).toBe(400);

    const created = await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ params: {} }),
      ...asA,
    });
    expect(created.status).toBe(201);
    const run = ((await created.json()) as { run: WorkflowRun }).run;
    expect(run.status).toBe("queued");
    expect(run.params).toEqual({ ratio: "9:16" });
    expect(run.steps).toEqual({ asr: { status: "pending" }, cut: { status: "pending" } });

    // The runner claims the run, walks both steps, and finishes it.
    const start = await event(run.id, {
      stepId: "asr",
      status: "running",
      startedAt: 1,
      runStatus: "running",
      executorId: "exec_1",
    });
    expect(start.status).toBe(200);
    await event(run.id, { stepId: "asr", status: "completed", completedAt: 2, exitCode: 0 });
    await event(run.id, { stepId: "cut", status: "running", startedAt: 3 });
    const done = await event(run.id, {
      stepId: "cut",
      status: "completed",
      completedAt: 4,
      exitCode: 0,
      runStatus: "completed",
    });
    expect(done.status).toBe(200);

    const final = (
      (await (await serviceFetch(`https://test.local/workflow-runs/${run.id}`, asA)).json()) as {
        run: WorkflowRun;
      }
    ).run;
    expect(final.status).toBe("completed");
    expect(final.executorId).toBe("exec_1");
    expect(final.steps.cut).toMatchObject({ status: "completed", exitCode: 0 });
    expect(final.startedAt).not.toBeNull();
    expect(final.completedAt).not.toBeNull();

    // Terminal runs reject late reports and double cancels.
    const late = await event(run.id, { stepId: "cut", status: "failed" });
    expect(late.status).toBe(409);
    const cancel = await serviceFetch(`https://test.local/workflow-runs/${run.id}/cancel`, {
      method: "POST",
      body: "{}",
      ...asA,
    });
    expect(cancel.status).toBe(409);
  });

  it("marks a failed step, refuses illegal transitions and cancels queued runs", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);
    const run = (
      (await (
        await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;

    // pending → completed is not a legal step transition.
    const illegal = await event(run.id, { stepId: "asr", status: "completed" });
    expect(illegal.status).toBe(409);

    await event(run.id, { stepId: "asr", status: "running", runStatus: "running" });
    const failed = await event(run.id, {
      stepId: "asr",
      status: "failed",
      exitCode: 1,
      logTail: "ffmpeg: no such file",
      runStatus: "failed",
      failureReason: "step_failed",
    });
    expect(failed.status).toBe(200);
    const after = (
      (await (await serviceFetch(`https://test.local/workflow-runs/${run.id}`, asA)).json()) as {
        run: WorkflowRun;
      }
    ).run;
    expect(after.status).toBe("failed");
    expect(after.failureReason).toBe("step_failed");
    expect(after.steps.asr.logTail).toContain("ffmpeg");

    // A second run can be canceled while still queued.
    const second = (
      (await (
        await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;
    const canceled = await serviceFetch(`https://test.local/workflow-runs/${second.id}/cancel`, {
      method: "POST",
      body: "{}",
      ...asA,
    });
    expect(canceled.status).toBe(200);
    expect(((await canceled.json()) as { run: WorkflowRun }).run.status).toBe("canceled");
  });

  it("keeps workflows private and refuses foreign skill pins", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);

    // Another user sees nothing and cannot touch the run surface.
    const listB = await serviceFetch("https://test.local/workflows", asB);
    expect(((await listB.json()) as { workflows: unknown[] }).workflows).toEqual([]);
    expect((await serviceFetch(`https://test.local/workflows/${workflow.id}`, asB)).status).toBe(
      404
    );

    // B cannot pin A's personal skill either.
    const stolen = await serviceFetch("https://test.local/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "偷技能", definition: definitionWith(pin) }),
      ...asB,
    });
    expect(stolen.status).toBe(400);
    expect(await stolen.text()).toContain("cannot run");

    // A nonexistent revision is refused for everyone.
    const badPin = await serviceFetch("https://test.local/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "坏引用",
        definition: definitionWith({ skillId: pin.skillId, revisionId: "skillrev_missing" }),
      }),
      ...asA,
    });
    expect(badPin.status).toBe(400);
  });
});

describe("workflow run dispatch and sandbox execution", () => {
  beforeEach(cleanD1Tables);

  it("dispatches a run into a hidden session and folds the sandbox's reports", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);

    const created = await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
      ...asA,
    });
    expect(created.status).toBe(201);
    const run = ((await created.json()) as { run: WorkflowRun }).run;
    expect(run.sessionId).toBeTruthy();

    // The hidden session carries the run and the pinned skills via an ids manifest.
    const sessionRow = await env.DB.prepare(
      "SELECT spawn_source, automation_run_id, title FROM sessions WHERE id = ?"
    )
      .bind(run.sessionId)
      .first<{ spawn_source: string; automation_run_id: string; title: string }>();
    expect(sessionRow).toMatchObject({
      spawn_source: "automation",
      automation_run_id: run.id,
      title: "[Workflow] 剪一条",
    });
    const manifest = await env.DB.prepare(
      "SELECT selection_mode, selected_skill_ids FROM session_skill_manifests WHERE session_id = ?"
    )
      .bind(run.sessionId)
      .first<{ selection_mode: string; selected_skill_ids: string }>();
    expect(manifest?.selection_mode).toBe("ids");
    expect(JSON.parse(manifest!.selected_skill_ids)).toEqual([pin.skillId]);

    // The sandbox proves itself with its token, asks for the run, and reports.
    const stub = env.SESSION.get(env.SESSION.idFromName(run.sessionId!));
    await seedSandboxAuthHash(stub, { authToken: "wf-token", sandboxId: "sandbox-wf" });
    const sandboxFetch = (path: string, init?: RequestInit) =>
      SELF.fetch(`https://test.local/sessions/${run.sessionId}${path}`, {
        headers: { Authorization: "Bearer wf-token", "Content-Type": "application/json" },
        ...init,
      });

    const bundle = await sandboxFetch("/workflow-run");
    expect(bundle.status).toBe(200);
    const fetched = (await bundle.json()) as {
      run: { id: string; params: Record<string, string>; definition: { steps: unknown[] } };
    };
    expect(fetched.run.id).toBe(run.id);
    expect(fetched.run.params).toEqual({ ratio: "9:16" });
    expect(fetched.run.definition.steps).toHaveLength(2);

    // The executor's liveness ping renews the DO's inactivity window.
    const beat = await sandboxFetch("/workflow-heartbeat", { method: "POST", body: "{}" });
    expect(beat.status).toBe(200);

    const report = (body: Record<string, unknown>) =>
      sandboxFetch(`/workflow-runs/${run.id}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    expect((await report({ stepId: "asr", status: "running", runStatus: "running" })).status).toBe(
      200
    );
    expect((await report({ stepId: "asr", status: "completed", exitCode: 0 })).status).toBe(200);
    expect((await report({ stepId: "cut", status: "running" })).status).toBe(200);
    const done = await report({
      stepId: "cut",
      status: "completed",
      exitCode: 0,
      runStatus: "completed",
    });
    expect(done.status).toBe(200);

    const final = (
      (await (await serviceFetch(`https://test.local/workflow-runs/${run.id}`, asA)).json()) as {
        run: WorkflowRun;
      }
    ).run;
    expect(final.status).toBe("completed");
    expect(final.steps.cut.status).toBe("completed");

    // The finished run no longer answers the sandbox's "what should I run",
    // and a finished session's heartbeat no longer renews anything.
    expect((await sandboxFetch("/workflow-run")).status).toBe(404);
    expect((await sandboxFetch("/workflow-heartbeat", { method: "POST", body: "{}" })).status).toBe(
      404
    );
  });

  it("refuses a run whose pins are no longer the current revisions", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);

    // Re-saving the skill moves its current revision past the pinned one.
    const resaved = await serviceFetch("https://test.local/my-skills", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "SKILL.md", content: skillMarkdown("clip-cutter") }],
        replace: true,
      }),
      ...asA,
    });
    expect(resaved.status).toBe(200);
    const stale = await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
      ...asA,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("outdated revision");
  });

  it("keeps another session's sandbox away from the run", async () => {
    const pin = await saveSkill("clip-cutter");
    const workflow = await createWorkflow(pin);
    const run = (
      (await (
        await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;

    // A second dispatched session gets its own token; it must not reach run #1.
    const second = (
      (await (
        await serviceFetch(`https://test.local/workflows/${workflow.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;
    const otherStub = env.SESSION.get(env.SESSION.idFromName(second.sessionId!));
    await seedSandboxAuthHash(otherStub, { authToken: "other-token", sandboxId: "sandbox-2" });

    const crossed = await SELF.fetch(
      `https://test.local/sessions/${second.sessionId}/workflow-runs/${run.id}/events`,
      {
        method: "POST",
        headers: { Authorization: "Bearer other-token", "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: "asr", status: "running" }),
      }
    );
    expect(crossed.status).toBe(404);
  });
});

describe("saving a workflow from a session", () => {
  beforeEach(cleanD1Tables);

  async function sandboxSave(sessionId: string, token: string, body: Record<string, unknown>) {
    return SELF.fetch(`https://test.local/sessions/${sessionId}/saved-workflows`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function looseDefinition() {
    return {
      params: { ratio: { type: "select", label: "画幅", options: ["9:16", "1:1"] } },
      steps: [
        {
          id: "cut",
          title: "剪辑",
          skill: "clip-cutter",
          entry: "scripts/run.sh",
          args: ["{{params.ratio}}"],
          needs: [],
          outputs: { video: "out/final.mp4" },
        },
      ],
    };
  }

  it("resolves skill names to current pins and replaces on re-save", async () => {
    const pin = await saveSkill("clip-cutter");
    // A session this user owns, with a seeded sandbox token.
    const wf = await createWorkflow(pin);
    const run = (
      (await (
        await serviceFetch(`https://test.local/workflows/${wf.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;
    const stub = env.SESSION.get(env.SESSION.idFromName(run.sessionId!));
    await seedSandboxAuthHash(stub, { authToken: "save-token", sandboxId: "sandbox-save" });

    const first = await sandboxSave(run.sessionId!, "save-token", {
      name: "咖啡店周更",
      description: "每周一条",
      definition: looseDefinition(),
    });
    expect(first.status).toBe(201);
    const saved = (await first.json()) as { created: boolean; workflow: { id: string } };
    expect(saved.created).toBe(true);

    const detail = (
      (await (
        await serviceFetch(`https://test.local/workflows/${saved.workflow.id}`, asA)
      ).json()) as { workflow: Workflow }
    ).workflow;
    expect(detail.definition.steps[0].skill).toEqual({
      skillId: pin.skillId,
      revisionId: pin.revisionId,
      name: "clip-cutter",
    });

    const second = await sandboxSave(run.sessionId!, "save-token", {
      name: "咖啡店周更",
      description: "改了描述",
      definition: looseDefinition(),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    const workflows = (
      (await (await serviceFetch("https://test.local/workflows", asA)).json()) as {
        workflows: Workflow[];
      }
    ).workflows.filter((w) => w.name === "咖啡店周更");
    expect(workflows).toHaveLength(1);
    expect(workflows[0].description).toBe("改了描述");
  });

  it("refuses a step naming a skill the owner cannot run", async () => {
    const pin = await saveSkill("clip-cutter");
    const wf = await createWorkflow(pin);
    const run = (
      (await (
        await serviceFetch(`https://test.local/workflows/${wf.id}/runs`, {
          method: "POST",
          body: JSON.stringify({}),
          ...asA,
        })
      ).json()) as { run: WorkflowRun }
    ).run;
    const stub = env.SESSION.get(env.SESSION.idFromName(run.sessionId!));
    await seedSandboxAuthHash(stub, { authToken: "save-token2", sandboxId: "sandbox-save2" });

    const refused = await sandboxSave(run.sessionId!, "save-token2", {
      name: "坏引用",
      definition: {
        ...looseDefinition(),
        steps: [{ ...looseDefinition().steps[0], skill: "no-such-skill" }],
      },
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("no-such-skill");
  });
});
