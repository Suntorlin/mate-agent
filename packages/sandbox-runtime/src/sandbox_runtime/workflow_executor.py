"""Bridge between a session's sandbox and its dispatched workflow run.

After boot the supervisor asks the control plane whether this session
carries a workflow run. If it does, the run executes here — in a worker
thread, beside the idle harness — with every step transition reported
through the sandbox's own token:

    GET  /sessions/{id}/workflow-run                   what should I run?
    POST /sessions/{id}/workflow-runs/{runId}/events   one step transition

The first report claims the run (the control plane walks queued → starting
→ running); the last one carries the terminal runStatus, after which the
control plane archives this session and the sandbox goes away.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from pathlib import Path

from .workflow_runner import WorkflowRunner, execution_order

REQUEST_TIMEOUT_SECONDS = 30.0
HEARTBEAT_INTERVAL_SECONDS = 60.0


class WorkflowExecutor:
    def __init__(
        self,
        control_plane_url: str,
        session_id: str,
        sandbox_token: str,
        sandbox_id: str,
        skills_root: Path,
        workspace_root: Path,
        log: Any,
        *,
        transport: httpx.BaseTransport | None = None,
        heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        self._base_url = control_plane_url.rstrip("/")
        self._session_path = f"{self._base_url}/sessions/{quote(session_id, safe='')}"
        self._headers = {"Authorization": f"Bearer {sandbox_token}"}
        self._sandbox_id = sandbox_id
        self._skills_root = skills_root
        self._workspace_root = workspace_root
        self._log = log
        self._transport = transport
        self._heartbeat_interval = heartbeat_interval_seconds

    def run_pending(self) -> bool:
        """Execute this session's run, if any. Synchronous; call in a thread."""
        with httpx.Client(
            transport=self._transport, timeout=REQUEST_TIMEOUT_SECONDS, headers=self._headers
        ) as client:
            run = self._fetch_run(client)
            if run is None:
                return False
            self._log.info("workflow.run_begins", run_id=run["id"])
            # The liveness ping: the control plane renews the sandbox's
            # inactivity window only while this thread keeps beating, so a
            # crashed run is still reclaimed by the ordinary timeout.
            stop = threading.Event()
            beat = threading.Thread(
                target=self._heartbeat_loop, args=(stop,), name="workflow-heartbeat", daemon=True
            )
            beat.start()
            try:
                self._execute(client, run)
            finally:
                stop.set()
                beat.join(timeout=5)
            return True

    def _fetch_run(self, client: httpx.Client) -> dict | None:
        try:
            response = client.get(f"{self._session_path}/workflow-run")
        except httpx.HTTPError as error:
            self._log.warn("workflow.fetch_failed", exc=error)
            return None
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()["run"]

    def _execute(self, client: httpx.Client, run: dict) -> None:
        run_id: str = run["id"]
        definition: dict = run["definition"]
        claimed = False

        def report(event: dict) -> None:
            nonlocal claimed
            payload = dict(event)
            if not claimed:
                payload["runStatus"] = "running"
                payload["executorId"] = self._sandbox_id
                claimed = True
            self._post_event(client, run_id, payload)

        runner = WorkflowRunner(
            definition=definition,
            params=run["params"],
            run_dir=self._workspace_root / "runs" / run_id,
            skills_root=self._skills_root,
            report=report,
        )
        try:
            result = runner.run()
        except Exception as error:  # a runner bug, not a step failure
            self._log.warn("workflow.runner_crashed", run_id=run_id, exc=error)
            last = definition["steps"][-1]["id"]
            self._post_event(
                client,
                run_id,
                {
                    "stepId": last,
                    "status": runner.steps.get(last).status
                    if runner.steps.get(last)
                    else "pending",
                    "runStatus": "failed",
                    "failureReason": "internal_error",
                },
            )
            return
        # The terminal frame; its step repeats a final state, which the
        # control plane ignores while still closing the run.
        last = execution_order(definition)[-1]
        terminal: dict = {
            "stepId": last,
            "status": runner.steps[last].status,
            "runStatus": result.status,
        }
        if result.status == "failed":
            terminal["failureReason"] = result.failure_reason or "step_failed"
        self._post_event(client, run_id, terminal)
        self._log.info("workflow.run_finished", run_id=run_id, status=result.status)

    def _heartbeat_loop(self, stop: threading.Event) -> None:
        with httpx.Client(
            transport=self._transport, timeout=REQUEST_TIMEOUT_SECONDS, headers=self._headers
        ) as client:
            while not stop.wait(self._heartbeat_interval):
                try:
                    client.post(f"{self._session_path}/workflow-heartbeat", json={})
                except httpx.HTTPError as error:
                    self._log.warn("workflow.heartbeat_failed", exc=error)

    def _post_event(self, client: httpx.Client, run_id: str, payload: dict) -> bool:
        url = f"{self._session_path}/workflow-runs/{quote(run_id, safe='')}/events"
        try:
            response = client.post(url, json=payload)
        except httpx.HTTPError as error:
            self._log.warn("workflow.report_failed", run_id=run_id, exc=error)
            return False
        if response.status_code >= 400:
            # 409s are expected for replayed or out-of-order frames.
            self._log.warn("workflow.report_refused", run_id=run_id, status=response.status_code)
            return False
        return True
