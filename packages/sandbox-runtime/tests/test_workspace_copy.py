"""Workspace copies: taken after turns and before saves, unpacked into a fresh sandbox."""

import asyncio
import io
import json
import os
import tarfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime import workspace_copy
from sandbox_runtime.workspace_copy import (
    CopyRoots,
    WorkspaceCopier,
    fingerprint,
    restore_from_url,
    unpack,
)


def _roots(base: Path) -> CopyRoots:
    return CopyRoots(
        workspace=base / "workspace",
        claude_projects=base / "root/.openinspect/claude/projects",
        session_id_file=base / "tmp/agent-session-id",
        root=base,
    )


def _project(base: Path) -> CopyRoots:
    roots = _roots(base)
    files = {
        "workspace/project/progress.md": "stage 3 done",
        "workspace/project/timeline.json": '{"shots": 10}',
        "workspace/project/renders/v02.mp4": "mp4-bytes",
        "workspace/project/edit/node_modules/react/index.js": "dependency",
        "workspace/project/.cache/remotion/chunk": "cache",
        "workspace/.tunnels.env": "SECRET_TUNNEL=1",
        "root/.openinspect/claude/projects/-workspace/conv-1.jsonl": '{"role":"user"}',
        "root/.openinspect/claude/.credentials.json": "never copied",
        "tmp/agent-session-id": "conv-1",
    }
    for name, text in files.items():
        path = base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return roots


class _ControlPlane:
    """The workspace-copy routes and the store's signed part URLs, behind one transport."""

    def __init__(self, part_size: int = 64, start_status: int = 201) -> None:
        self.part_size = part_size
        self.start_status = start_status
        self.requests: list[httpx.Request] = []
        self.parts: dict[int, bytes] = {}
        self.completed: dict | None = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "PUT":
            number = int(request.url.params["partNumber"])
            self.parts[number] = request.content
            return httpx.Response(200, headers={"etag": f'"e{number}"'})
        body = json.loads(request.content)
        if request.url.path == "/sessions/s1/workspace-copies":
            if self.start_status != 201:
                return httpx.Response(self.start_status, json={"error": "unavailable"})
            count = max(1, -(-body["sizeBytes"] // self.part_size))
            return httpx.Response(
                201,
                json={
                    "key": f"sessions/s1/workspace/20261002T000000000Z-c.{body['extension']}",
                    "uploadId": "up-1",
                    "partSizeBytes": self.part_size,
                    "parts": [
                        {"partNumber": n, "url": f"https://store.test/c?partNumber={n}"}
                        for n in range(1, count + 1)
                    ],
                },
            )
        self.completed = body
        return httpx.Response(201, json={"key": body["key"], "sizeBytes": 1})

    def archive(self) -> bytes:
        return b"".join(self.parts[n] for n in sorted(self.parts))


def _copier(roots: CopyRoots, plane: _ControlPlane, state_file: Path) -> WorkspaceCopier:
    return WorkspaceCopier(
        control_plane_url="https://cp.test",
        session_id="s1",
        auth_token="sandbox-token",
        log=MagicMock(),
        roots=roots,
        state_file=state_file,
        http=httpx.AsyncClient(transport=httpx.MockTransport(plane.handle)),
        settle_seconds=0,
        min_interval_seconds=0,
    )


def test_fingerprint_ignores_dependencies_caches_and_the_tunnel_env(tmp_path: Path) -> None:
    roots = _project(tmp_path)
    before, total = fingerprint(roots)
    (tmp_path / "workspace/project/edit/node_modules/react/index.js").write_text("changed")
    (tmp_path / "workspace/.tunnels.env").write_text("changed")
    assert fingerprint(roots) == (before, total)
    (tmp_path / "workspace/project/progress.md").write_text("stage 4 done")
    assert fingerprint(roots)[0] != before


@pytest.mark.asyncio
@pytest.mark.parametrize("zstd", [True, False])
async def test_a_copy_round_trips_into_a_fresh_sandbox(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, zstd: bool
) -> None:
    if zstd and workspace_copy.shutil.which("zstd") is None:
        pytest.skip("zstd is not installed")
    if not zstd:
        monkeypatch.setattr(workspace_copy.shutil, "which", lambda _name: None)
    source = _project(tmp_path / "old")
    plane = _ControlPlane(part_size=64)
    copier = _copier(source, plane, tmp_path / "state")

    assert await copier.save("turn") is True

    start = plane.requests[0]
    assert start.headers["authorization"] == "Bearer sandbox-token"
    assert json.loads(start.content)["extension"] == ("tar.zst" if zstd else "tar.gz")
    puts = [request for request in plane.requests if request.method == "PUT"]
    assert puts and all("authorization" not in request.headers for request in puts)
    assert plane.completed is not None
    assert plane.completed["uploadId"] == "up-1"
    assert [part["etag"] for part in plane.completed["parts"]] == [
        f'"e{n}"' for n in range(1, len(puts) + 1)
    ]

    # The snapshot is gone: a fresh sandbox unpacks the copy before the agent starts.
    fresh = _roots(tmp_path / "new")
    archive = plane.archive()
    download = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=archive))
    )
    assert await restore_from_url("https://store.test/copy", fresh, MagicMock(), http=download)

    new = tmp_path / "new"
    assert (new / "workspace/project/progress.md").read_text() == "stage 3 done"
    assert (new / "workspace/project/renders/v02.mp4").read_text() == "mp4-bytes"
    assert (new / "root/.openinspect/claude/projects/-workspace/conv-1.jsonl").exists()
    assert (new / "tmp/agent-session-id").read_text() == "conv-1"
    assert not (new / "workspace/project/edit/node_modules").exists()
    assert not (new / "workspace/project/.cache").exists()
    assert not (new / "workspace/.tunnels.env").exists()
    assert not (new / "root/.openinspect/claude/.credentials.json").exists()


@pytest.mark.asyncio
async def test_an_unchanged_project_is_not_copied_again(tmp_path: Path) -> None:
    roots = _project(tmp_path / "fs")
    plane = _ControlPlane()
    copier = _copier(roots, plane, tmp_path / "state")
    assert await copier.save("turn") is True
    count = len(plane.requests)

    assert await copier.save("shutdown") is False
    assert len(plane.requests) == count

    (tmp_path / "fs/workspace/project/progress.md").write_text("stage 4 done")
    assert await copier.save("turn") is True


@pytest.mark.asyncio
async def test_copies_stop_quietly_where_the_deployment_cannot_take_them(tmp_path: Path) -> None:
    roots = _project(tmp_path / "fs")
    plane = _ControlPlane(start_status=501)
    copier = _copier(roots, plane, tmp_path / "state")
    assert await copier.save("turn") is False
    copier.turn_ended()
    assert copier._scheduled is None
    assert len(plane.requests) == 1


@pytest.mark.asyncio
async def test_a_turn_schedules_one_copy(tmp_path: Path) -> None:
    roots = _project(tmp_path / "fs")
    plane = _ControlPlane()
    copier = _copier(roots, plane, tmp_path / "state")
    copier.turn_ended()
    copier.turn_ended()
    assert copier._scheduled is not None
    await copier._scheduled
    starts = [r for r in plane.requests if r.url.path == "/sessions/s1/workspace-copies"]
    assert len(starts) == 1


@pytest.mark.asyncio
async def test_the_save_copy_gives_up_inside_the_stop_deadline(tmp_path: Path) -> None:
    roots = _project(tmp_path / "fs")
    copier = _copier(roots, _ControlPlane(), tmp_path / "state")

    async def slow(_reason: str) -> bool:
        await asyncio.sleep(10)
        return True

    copier.save = slow  # type: ignore[method-assign]
    loop = asyncio.get_running_loop()
    started = loop.time()
    await copier.save_before_shutdown(loop.time() + workspace_copy.SHUTDOWN_MARGIN_SECONDS + 0.2)
    assert loop.time() - started < 1


def test_unpacking_keeps_to_the_copy_roots(tmp_path: Path) -> None:
    roots = _roots(tmp_path)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in (
            ("workspace/ok.txt", b"ok"),
            ("etc/cron.d/evil", b"x"),
            ("workspace/../../escape.txt", b"x"),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo("workspace/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        archive.addfile(link)
    copy = tmp_path / "copy.tar.gz"
    copy.write_bytes(buffer.getvalue())

    assert unpack(copy, roots) == 1
    assert (tmp_path / "workspace/ok.txt").read_text() == "ok"
    assert not (tmp_path / "workspace/link").exists()
    assert not (tmp_path / "etc").exists()
    assert not (tmp_path.parent / "escape.txt").exists()


@pytest.mark.asyncio
async def test_a_failed_download_leaves_the_sandbox_as_it_was(tmp_path: Path) -> None:
    download = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(403, text="expired"))
    )
    log = MagicMock()
    assert not await restore_from_url("https://store.test/x", _roots(tmp_path), log, http=download)
    log.error.assert_called_once()
    assert not (tmp_path / "workspace").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("boot_mode", "restores"),
    [("fresh", True), ("snapshot_restore", False), ("repo_image", False)],
)
async def test_only_a_fresh_sandbox_unpacks_the_copy_and_hides_its_url(
    monkeypatch: pytest.MonkeyPatch, boot_mode: str, restores: bool
) -> None:
    from sandbox_runtime import supervisor as supervisor_module
    from sandbox_runtime.runtime_config import BootMode

    restore = AsyncMock(return_value=True)
    monkeypatch.setattr(supervisor_module, "restore_from_url", restore)
    monkeypatch.setenv(workspace_copy.WORKSPACE_RESTORE_URL_ENV_VAR, "https://store.test/c?sig")
    supervisor = supervisor_module.SandboxSupervisor.__new__(supervisor_module.SandboxSupervisor)
    supervisor.boot_mode = BootMode(boot_mode)
    supervisor.log = MagicMock()

    await supervisor._restore_workspace_copy()

    assert restore.await_count == (1 if restores else 0)
    if restores:
        url, roots, _log = restore.await_args.args
        assert url == "https://store.test/c?sig"
        assert roots.workspace == Path("/workspace")
        assert workspace_copy.WORKSPACE_RESTORE_URL_ENV_VAR not in os.environ
