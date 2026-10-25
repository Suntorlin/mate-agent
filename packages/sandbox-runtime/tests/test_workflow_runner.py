"""The workflow runner executes a real DAG with real scripts and files."""

import json
import stat
from pathlib import Path

from sandbox_runtime.workflow_runner import WorkflowRunner, execution_order, render_argument


def write_script(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def definition() -> dict:
    return {
        "params": {"ratio": {"type": "string", "label": "画幅"}},
        "steps": [
            {
                "id": "asr",
                "title": "转写",
                "skill": {"skillId": "s1", "revisionId": "r1", "name": "clip-cutter"},
                "entry": "scripts/asr.sh",
                "args": [],
                "needs": [],
                "outputs": {"srt": "out/captions.srt"},
            },
            {
                "id": "cut",
                "title": "剪辑",
                "skill": {"skillId": "s1", "revisionId": "r1", "name": "clip-cutter"},
                "entry": "scripts/cut.sh",
                "args": ["--ratio", "{{params.ratio}}", "{{steps.asr.out.srt}}"],
                "needs": ["asr"],
                "outputs": {"video": "out/final.mp4"},
            },
        ],
    }


def make_runner(tmp_path: Path, asr_body: str, cut_body: str, events: list) -> WorkflowRunner:
    skills = tmp_path / "skills"
    write_script(skills / "clip-cutter/scripts/asr.sh", asr_body)
    write_script(skills / "clip-cutter/scripts/cut.sh", cut_body)
    return WorkflowRunner(
        definition=definition(),
        params={"ratio": "9:16"},
        run_dir=tmp_path / "run",
        skills_root=skills,
        report=events.append,
        step_timeout_seconds=20,
    )


def test_completes_a_two_step_pipeline_and_projects_the_canvas(tmp_path: Path) -> None:
    events: list = []
    runner = make_runner(
        tmp_path,
        asr_body="mkdir -p out && echo hello > out/captions.srt\n",
        # The cut step proves rendered templates: it reads the srt path argument.
        cut_body='mkdir -p out && cat "$3" > out/final.mp4 && echo "ratio=$2" >> out/final.mp4\n',
        events=events,
    )
    result = runner.run()

    assert result.status == "completed"
    assert result.failure_reason is None
    assert [e["stepId"] for e in events] == ["asr", "asr", "cut", "cut"]
    assert [e["status"] for e in events] == ["running", "completed", "running", "completed"]
    final = (tmp_path / "run/out/final.mp4").read_text()
    assert "hello" in final and "ratio=9:16" in final

    canvas = json.loads((tmp_path / "run/run.canvas.json").read_text())
    labels = [item for row in canvas["rows"] for item in row["items"]]
    assert any("转写 · 完成" in item for item in labels)
    assert any("剪辑 · 完成" in item for item in labels)
    # Lineage: the cut node points back at the asr node, outputs at their step.
    assert any("srt: out/captions.srt" in key for key in canvas["from"])


def test_failed_step_skips_downstream_and_reports_the_log(tmp_path: Path) -> None:
    events: list = []
    runner = make_runner(
        tmp_path,
        asr_body="echo boom >&2; exit 3\n",
        cut_body="exit 0\n",
        events=events,
    )
    result = runner.run()

    assert result.status == "failed"
    assert result.failure_reason == "step_failed"
    assert result.steps["asr"].status == "failed"
    assert result.steps["asr"].exit_code == 3
    assert "boom" in result.steps["asr"].log_tail
    assert result.steps["cut"].status == "skipped"
    assert events[-1] == {"stepId": "cut", "status": "skipped"}
    canvas = json.loads((tmp_path / "run/run.canvas.json").read_text())
    labels = [item for row in canvas["rows"] for item in row["items"]]
    assert any("· 失败" in item for item in labels)
    assert any("· 未执行" in item for item in labels)


def test_missing_declared_output_fails_the_step(tmp_path: Path) -> None:
    events: list = []
    runner = make_runner(
        tmp_path,
        asr_body="exit 0\n",  # exits clean but never writes out/captions.srt
        cut_body="exit 0\n",
        events=events,
    )
    result = runner.run()
    assert result.status == "failed"
    assert "outputs missing" in result.steps["asr"].log_tail


def test_execution_order_respects_needs() -> None:
    order = execution_order(definition())
    assert order.index("asr") < order.index("cut")


def test_render_argument_substitutes_params_and_outputs(tmp_path: Path) -> None:
    rendered = render_argument(
        "--in {{ steps.asr.out.srt }} --ratio {{params.ratio}} $HOME",
        {"ratio": "1:1"},
        {"asr": {"srt": tmp_path / "captions.srt"}},
    )
    assert rendered == f"--in {tmp_path / 'captions.srt'} --ratio 1:1 $HOME"
