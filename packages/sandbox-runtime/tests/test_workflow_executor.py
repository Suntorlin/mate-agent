"""The executor fetches its session's run, executes it, and reports frames."""

import json
import stat
from pathlib import Path

import httpx

from sandbox_runtime.workflow_executor import WorkflowExecutor


class FakeLog:
    def info(self, *args, **kwargs):
        pass

    def warn(self, *args, **kwargs):
        pass


def definition() -> dict:
    step = {
        "skill": {"skillId": "s1", "revisionId": "r1", "name": "clip-cutter"},
        "args": [],
        "needs": [],
        "outputs": {},
    }
    return {
        "params": {},
        "steps": [
            {
                **step,
                "id": "asr",
                "title": "转写",
                "entry": "scripts/asr.sh",
                "outputs": {"srt": "out/captions.srt"},
            },
            {**step, "id": "cut", "title": "剪辑", "entry": "scripts/cut.sh", "needs": ["asr"]},
        ],
    }


def write_script(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def make_executor(tmp_path: Path, run: dict | None, events: list) -> WorkflowExecutor:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer wf-token"
        if request.url.path == "/sessions/sess-1/workflow-run":
            if run is None:
                return httpx.Response(404, json={"error": "No workflow run for this session"})
            return httpx.Response(200, json={"run": run})
        assert request.url.path == f"/sessions/sess-1/workflow-runs/{run['id']}/events"
        events.append(json.loads(request.content))
        return httpx.Response(200, json={"run": {}})

    return WorkflowExecutor(
        "https://cp.test",
        "sess-1",
        "wf-token",
        "sandbox-9",
        tmp_path / "skills",
        tmp_path / "workspace",
        FakeLog(),
        transport=httpx.MockTransport(respond),
    )


def test_no_pending_run_is_a_quiet_no_op(tmp_path: Path) -> None:
    events: list = []
    assert make_executor(tmp_path, None, events).run_pending() is False
    assert events == []


def test_executes_and_reports_claim_steps_and_terminal(tmp_path: Path) -> None:
    write_script(
        tmp_path / "skills/clip-cutter/scripts/asr.sh",
        "mkdir -p out && echo cap > out/captions.srt\n",
    )
    write_script(tmp_path / "skills/clip-cutter/scripts/cut.sh", "exit 0\n")
    events: list = []
    run = {"id": "wfrun_1", "definition": definition(), "params": {}, "status": "queued"}
    assert make_executor(tmp_path, run, events).run_pending() is True

    # First frame claims the run; the last carries the terminal runStatus.
    assert events[0]["runStatus"] == "running"
    assert events[0]["executorId"] == "sandbox-9"
    assert [e["stepId"] for e in events[:-1]] == ["asr", "asr", "cut", "cut"]
    assert events[-1] == {"stepId": "cut", "status": "completed", "runStatus": "completed"}
    # The run worked inside the session workspace, under its own directory.
    assert (tmp_path / "workspace/runs/wfrun_1/out/captions.srt").exists()


def test_failed_step_reports_a_failed_terminal(tmp_path: Path) -> None:
    write_script(tmp_path / "skills/clip-cutter/scripts/asr.sh", "echo no >&2; exit 2\n")
    write_script(tmp_path / "skills/clip-cutter/scripts/cut.sh", "exit 0\n")
    events: list = []
    run = {"id": "wfrun_2", "definition": definition(), "params": {}, "status": "queued"}
    make_executor(tmp_path, run, events).run_pending()

    assert events[-1]["runStatus"] == "failed"
    assert events[-1]["failureReason"] == "step_failed"
    assert events[-1]["status"] == "skipped"  # the last step never ran
    failed = next(e for e in events if e.get("status") == "failed")
    assert "no" in failed["logTail"]


def test_heartbeats_flow_while_a_slow_step_runs(tmp_path: Path) -> None:
    write_script(
        tmp_path / "skills/clip-cutter/scripts/asr.sh",
        "sleep 0.6\nmkdir -p out && echo cap > out/captions.srt\n",
    )
    write_script(tmp_path / "skills/clip-cutter/scripts/cut.sh", "exit 0\n")
    events: list = []
    beats: list = []

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/workflow-heartbeat"):
            beats.append(1)
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/sessions/sess-1/workflow-run":
            return httpx.Response(
                200,
                json={"run": {"id": "wfrun_hb", "definition": definition(), "params": {}}},
            )
        events.append(json.loads(request.content))
        return httpx.Response(200, json={"run": {}})

    executor = WorkflowExecutor(
        "https://cp.test",
        "sess-1",
        "wf-token",
        "sandbox-9",
        tmp_path / "skills",
        tmp_path / "workspace",
        FakeLog(),
        transport=httpx.MockTransport(respond),
        heartbeat_interval_seconds=0.1,
    )
    assert executor.run_pending() is True
    assert len(beats) >= 3  # ~0.6s of work at a 0.1s beat
    assert events[-1]["runStatus"] == "completed"
