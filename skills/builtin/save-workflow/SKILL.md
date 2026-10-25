---
name: save-workflow
description:
  Register this session's fixed pipeline as a repeatable workflow the user can run again without an
  agent. Use when the user asks to save the procedure as a workflow, make it rerunnable, automate
  it, "存成工作流" or similar — after its scripts are saved as a skill.
---

# save-workflow

A workflow is a saved pipeline of skill scripts: the user fills a small form and the platform runs
the steps in a sandbox with no agent, so reruns cost nothing and come out the same every time. Save
one when this session's procedure is a fixed sequence of script invocations.

## 1. The scripts come first

Each step runs one executable from a saved skill. If this session's commands are not yet scripts in
a skill, do that first with save-as-skill (compile the fixed command sequence into `scripts/*.sh`,
parameters as arguments). A workflow step references the skill **by name**; the platform pins its
current revision when you save.

## 2. Write the workflow file

```json
{
  "name": "咖啡店周更",
  "description": "每周一条 9:16 的门店短视频",
  "definition": {
    "params": {
      "ratio": { "type": "select", "label": "画幅", "options": ["9:16", "1:1"], "default": "9:16" }
    },
    "steps": [
      {
        "id": "asr",
        "title": "转写",
        "skill": "cafe-weekly-cutter",
        "entry": "scripts/transcribe.sh",
        "outputs": { "srt": "out/captions.srt" }
      },
      {
        "id": "cut",
        "title": "剪辑",
        "skill": "cafe-weekly-cutter",
        "entry": "scripts/cut.sh",
        "needs": ["asr"],
        "args": ["--ratio", "{{params.ratio}}", "{{steps.asr.out.srt}}"],
        "outputs": { "video": "out/final.mp4" }
      }
    ]
  }
}
```

- `params`: the form the user fills per run (`string`/`number`/`boolean`/`select`; every value
  reaches scripts as a string). Declare one for everything that changes between runs.
- `steps[].skill`: the skill's name; `entry` is the executable inside it. `needs` orders steps;
  `{{steps.<id>.out.<name>}}` in `args` becomes the real path of that declared output.
- `outputs`: workspace-relative paths the script promises to produce; a clean exit without them
  fails the step. Ids and names: lowercase, digits, `-`/`_`.
- Steps run one after another in one sandbox; a failed step skips everything after it.

## 3. Save

```bash
python3 "${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/skills/save-workflow/scripts/save-workflow" workflow.json
```

It prints JSON with the workflow's id and whether it was `created` or replaced (saving the same name
again replaces the definition; past runs keep what they ran). Then tell the user, in their language,
what the workflow is called, what a run will do, and what the form asks. If a skill name is refused,
save that skill first and retry.
