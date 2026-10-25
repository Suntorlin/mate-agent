"""Execute one workflow run: a parameterized DAG of skill scripts, no agent.

The control plane freezes a run's definition and params; this module walks
the steps in dependency order, renders each step's argument templates,
executes the entry script as a subprocess, verifies the declared outputs
exist, and reports every step transition through a callback. After each
transition it rewrites the run's canvas document, so the browser's canvas
shows live progress without knowing what a workflow is.

Status vocabulary and transitions mirror shared/types/workflows.ts; the
control plane refuses anything else, so this module never improvises states.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import dataclass, field
from graphlib import TopologicalSorter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

TEMPLATE = re.compile(
    r"\{\{\s*(params\.[a-z][a-z0-9_-]*|steps\.[a-z][a-z0-9_-]*\.out\.[a-z][a-z0-9_-]*)\s*\}\}"
)
LOG_TAIL_CHARS = 4000
DEFAULT_STEP_TIMEOUT_SECONDS = 15 * 60


@dataclass
class StepResult:
    status: str  # completed | failed | skipped
    exit_code: int | None = None
    log_tail: str = ""
    started_at: int | None = None
    completed_at: int | None = None


@dataclass
class RunResult:
    status: str  # completed | failed
    failure_reason: str | None
    steps: dict[str, StepResult] = field(default_factory=dict)


def execution_order(definition: dict) -> list[str]:
    """Steps in dependency order; the definition was validated upstream."""
    sorter: TopologicalSorter[str] = TopologicalSorter()
    for step in definition["steps"]:
        sorter.add(step["id"], *step.get("needs", []))
    return list(sorter.static_order())


def render_argument(
    argument: str, params: dict[str, str], outputs: dict[str, dict[str, Path]]
) -> str:
    def substitute(match: re.Match[str]) -> str:
        reference = match.group(1)
        if reference.startswith("params."):
            return params[reference.removeprefix("params.")]
        _, step_id, _, output_name = reference.split(".")
        return str(outputs[step_id][output_name])

    return TEMPLATE.sub(substitute, argument)


def canvas_spec(definition: dict, steps: dict[str, StepResult], run_dir: Path) -> dict:
    """Project the DAG and its live states onto the canvas document format."""

    # Plain text only: the renderer owns any styling, and emoji age badly on cards.
    def label(step: dict) -> str:
        state = steps.get(step["id"])
        title = step["title"]
        if state is None or state.status == "pending":
            return f"{title} · 排队中"
        if state.status == "running":
            return f"{title} · 运行中"
        if state.status == "completed":
            seconds = ((state.completed_at or 0) - (state.started_at or 0)) // 1000
            return f"{title} · 完成 {seconds}s"
        if state.status == "skipped":
            return f"{title} · 未执行"
        return f"{title} · 失败"

    labels = {step["id"]: label(step) for step in definition["steps"]}
    rows = [{"title": step["title"], "items": [labels[step["id"]]]} for step in definition["steps"]]
    arrows: dict[str, list[str]] = {}
    for step in definition["steps"]:
        if step.get("needs"):
            arrows[labels[step["id"]]] = [labels[need] for need in step["needs"]]
        state = steps.get(step["id"])
        if state and state.status == "completed":
            for name, relative in step.get("outputs", {}).items():
                arrows.setdefault(f"{name}: {relative}", []).append(labels[step["id"]])
    return {"rows": rows, "from": arrows}


class WorkflowRunner:
    """Walks one frozen run. `report` delivers step events upstream; the
    canvas file lands in the run directory for media-preview to publish."""

    def __init__(
        self,
        definition: dict,
        params: dict[str, str],
        run_dir: Path,
        skills_root: Path,
        report: Callable[[dict], None],
        step_timeout_seconds: int = DEFAULT_STEP_TIMEOUT_SECONDS,
    ) -> None:
        self.definition = definition
        self.params = params
        self.run_dir = run_dir
        self.skills_root = skills_root
        self.report = report
        self.step_timeout_seconds = step_timeout_seconds
        self.steps: dict[str, StepResult] = {}

    def run(self) -> RunResult:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        by_id = {step["id"]: step for step in self.definition["steps"]}
        order = execution_order(self.definition)
        produced: dict[str, dict[str, Path]] = {}
        failed = False
        for step_id in order:
            step = by_id[step_id]
            if failed:
                self.steps[step_id] = StepResult(status="skipped")
                self.report({"stepId": step_id, "status": "skipped"})
                self._write_canvas()
                continue
            result = self._run_step(step, produced)
            self.steps[step_id] = result
            if result.status == "failed":
                failed = True
            else:
                produced[step_id] = {
                    name: self.run_dir / relative
                    for name, relative in step.get("outputs", {}).items()
                }
        status = "failed" if failed else "completed"
        self._write_canvas()
        return RunResult(
            status=status, failure_reason="step_failed" if failed else None, steps=self.steps
        )

    def _run_step(self, step: dict, produced: dict[str, dict[str, Path]]) -> StepResult:
        started_at = now_ms()
        self.report({"stepId": step["id"], "status": "running", "startedAt": started_at})
        self.steps[step["id"]] = StepResult(status="running", started_at=started_at)
        self._write_canvas()

        entry = self.skills_root / step["skill"]["name"] / step["entry"]
        arguments = [render_argument(a, self.params, produced) for a in step.get("args", [])]
        try:
            completed = subprocess.run(
                [str(entry), *arguments],
                cwd=self.run_dir,
                capture_output=True,
                text=True,
                timeout=self.step_timeout_seconds,
            )
            exit_code: int | None = completed.returncode
            log_tail = (completed.stdout + completed.stderr)[-LOG_TAIL_CHARS:]
        except subprocess.TimeoutExpired as timeout:
            exit_code = None
            output = (timeout.stdout or "") + (timeout.stderr or "")
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            log_tail = (output + "\n[step timed out]")[-LOG_TAIL_CHARS:]
        except OSError as error:
            exit_code = None
            log_tail = f"[could not start {entry}: {error}]"

        missing = [
            relative
            for relative in step.get("outputs", {}).values()
            if not (self.run_dir / relative).exists()
        ]
        ok = exit_code == 0 and not missing
        if exit_code == 0 and missing:
            log_tail = (log_tail + f"\n[declared outputs missing: {', '.join(missing)}]")[
                -LOG_TAIL_CHARS:
            ]
        completed_at = now_ms()
        status = "completed" if ok else "failed"
        self.report(
            {
                "stepId": step["id"],
                "status": status,
                "startedAt": started_at,
                "completedAt": completed_at,
                **({"exitCode": exit_code} if exit_code is not None else {}),
                "logTail": log_tail,
            }
        )
        result = StepResult(
            status=status,
            exit_code=exit_code,
            log_tail=log_tail,
            started_at=started_at,
            completed_at=completed_at,
        )
        self.steps[step["id"]] = result
        self._write_canvas()
        return result

    def _write_canvas(self) -> None:
        spec = canvas_spec(self.definition, self.steps, self.run_dir)
        (self.run_dir / "run.canvas.json").write_text(json.dumps(spec, ensure_ascii=False))


def now_ms() -> int:
    return int(time.time() * 1000)
