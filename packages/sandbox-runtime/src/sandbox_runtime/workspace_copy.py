"""Copies of the project files in object storage, so a session outlives its snapshot.

A saved sandbox lives in a provider snapshot. As a safety net the bridge also
keeps an archive of the project in the session's object storage: the
``/workspace`` tree (without dependency folders and caches), the agent's
conversation transcripts and the file naming the conversation to resume. It
is taken after each turn (at most every ``MIN_INTERVAL_SECONDS``) and once
more when the sandbox is being saved, and skipped when nothing changed.

When a saved sandbox cannot be restored (its snapshot is gone), the control
plane starts a fresh one with ``WORKSPACE_RESTORE_URL``; the supervisor
unpacks that copy before the agent starts, so the files and the conversation
come back instead of an empty sandbox.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any, Final

import httpx

from .direct_upload import DirectUploadError, put_parts

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .log_config import StructuredLogger

WORKSPACE_RESTORE_URL_ENV_VAR: Final = "WORKSPACE_RESTORE_URL"

# Rebuildable or private: dependency installs, caches, build output of tools,
# and the tunnel env file (it holds per-sandbox addresses).
EXCLUDED_NAMES: Final = frozenset(
    {
        "node_modules",
        ".cache",
        "__pycache__",
        ".venv",
        "venv",
        ".npm",
        ".pnpm-store",
        ".yarn",
        ".next",
        ".turbo",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tunnels.env",
    }
)
MIN_INTERVAL_SECONDS: Final = 300.0
TURN_SETTLE_SECONDS: Final = 5.0
SHUTDOWN_MARGIN_SECONDS: Final = 5.0
# Matches the control plane's WORKSPACE_COPY_MAX_BYTES; larger projects are not copied.
MAX_COPY_BYTES: Final = 16 * 1024 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS: Final = 60.0
DOWNLOAD_TIMEOUT_SECONDS: Final = 1800.0

ZSTD_MAGIC: Final = b"\x28\xb5\x2f\xfd"
GZIP_MAGIC: Final = b"\x1f\x8b"


@dataclass(frozen=True)
class CopyRoots:
    """What a copy holds, as paths under ``/``; members are stored relative to it."""

    workspace: Path
    claude_projects: Path
    session_id_file: Path
    root: Path = Path("/")

    def existing(self) -> list[Path]:
        return [path for path in self.all() if path.exists()]

    def all(self) -> list[Path]:
        return [self.workspace, self.claude_projects, self.session_id_file]

    def relative(self, path: Path) -> str:
        return str(path.relative_to(self.root))

    def allows(self, member_name: str) -> bool:
        """Whether an archive member lies inside one of the roots (for unpacking)."""
        name = member_name[2:] if member_name.startswith("./") else member_name.lstrip("/")
        for path in self.all():
            prefix = self.relative(path)
            if name == prefix or name.startswith(prefix + "/"):
                return True
        return False


def default_roots(session_id_file: Path) -> CopyRoots:
    from .claude_stager import resolve_claude_config_dir

    return CopyRoots(
        workspace=Path("/workspace"),
        claude_projects=resolve_claude_config_dir() / "projects",
        session_id_file=session_id_file,
    )


def _walk(roots: CopyRoots) -> Iterator[tuple[str, os.stat_result]]:
    for top in roots.existing():
        if top.is_file():
            yield roots.relative(top), top.stat()
            continue
        for directory, dirnames, filenames in os.walk(top):
            dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_NAMES)
            for name in sorted(filenames):
                if name in EXCLUDED_NAMES:
                    continue
                path = Path(directory) / name
                with contextlib.suppress(OSError):
                    if path.is_symlink() or not path.is_file():
                        continue
                    yield roots.relative(path), path.stat()


def fingerprint(roots: CopyRoots) -> tuple[str, int]:
    """A digest of every file's name, size and mtime, and the bytes they add up to."""
    digest = hashlib.sha256()
    total = 0
    for name, info in _walk(roots):
        total += info.st_size
        digest.update(f"{name}\0{info.st_size}\0{info.st_mtime_ns}\n".encode())
    return digest.hexdigest(), total


def _tar_command(roots: CopyRoots, archive: Path, use_zstd: bool) -> list[str]:
    command = ["tar", "-C", str(roots.root), "--create", "--file", str(archive)]
    command += [f"--exclude={name}" for name in sorted(EXCLUDED_NAMES)]
    # Projects are mostly media that does not compress: fast levels, every core zstd has.
    command += [
        "--use-compress-program=zstd -T0 -3" if use_zstd else "--use-compress-program=gzip -1"
    ]
    command += [roots.relative(path) for path in roots.existing()]
    return command


@dataclass
class WorkspaceCopier:
    """Takes and uploads copies; one at a time, skipping unchanged trees."""

    control_plane_url: str
    session_id: str
    auth_token: str
    log: StructuredLogger
    roots: CopyRoots
    state_file: Path = field(default_factory=lambda: Path.home() / ".openinspect/workspace-copy")
    http: httpx.AsyncClient | None = None
    min_interval_seconds: float = MIN_INTERVAL_SECONDS
    settle_seconds: float = TURN_SETTLE_SECONDS
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _scheduled: asyncio.Task[None] | None = None
    _last_saved_at: float = 0.0
    # Set when the deployment cannot take copies (no direct storage access).
    _unavailable: bool = False
    _waiting: bool = False

    def _client(self) -> httpx.AsyncClient:
        if self.http is None:
            self.http = httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS)
        return self.http

    def _url(self, path: str) -> str:
        return f"{self.control_plane_url.rstrip('/')}/sessions/{self.session_id}{path}"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth_token}"}

    def _saved_fingerprint(self) -> str | None:
        try:
            return self.state_file.read_text().strip() or None
        except OSError:
            return None

    def _remember(self, digest: str) -> None:
        with contextlib.suppress(OSError):
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(digest)

    def turn_ended(self) -> None:
        """Copy soon after a turn, but no more often than ``min_interval_seconds``."""
        if self._unavailable:
            return
        if self._scheduled is not None and not self._scheduled.done():
            return
        wait = max(
            self.settle_seconds,
            self._last_saved_at + self.min_interval_seconds - time.monotonic(),
        )

        async def later() -> None:
            self._waiting = True
            try:
                await asyncio.sleep(wait)
            finally:
                self._waiting = False
            await self.save("turn")

        self._scheduled = asyncio.create_task(later())

    async def save_before_shutdown(self, deadline: float) -> None:
        """Bring the copy up to date before the sandbox is saved, within ``deadline``.

        ``deadline`` is an event-loop time. A copy that cannot finish in time is
        abandoned; the previous one stands, and the snapshot is the primary.
        """
        if self._unavailable:
            return
        # A copy still waiting for its turn is replaced by this one; one already
        # running is waited for (the lock), and this one then finds it current.
        if self._scheduled is not None and self._waiting:
            self._scheduled.cancel()
        budget = deadline - asyncio.get_running_loop().time() - SHUTDOWN_MARGIN_SECONDS
        if budget <= 0:
            return
        try:
            async with asyncio.timeout(budget):
                await self.save("shutdown")
        except TimeoutError:
            self.log.warn("workspace_copy.shutdown_timeout", budget_seconds=round(budget, 1))
        except Exception as error:
            self.log.warn("workspace_copy.shutdown_failed", exc=error)

    async def save(self, reason: str) -> bool:
        """Take and upload a copy unless nothing changed; True when one was stored."""
        async with self._lock:
            try:
                return await self._save(reason)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.log.warn("workspace_copy.failed", reason=reason, exc=error)
                return False

    async def _save(self, reason: str) -> bool:
        started = time.monotonic()
        digest, total = await asyncio.to_thread(fingerprint, self.roots)
        if total == 0 or digest == self._saved_fingerprint():
            self._last_saved_at = time.monotonic()
            return False
        if total > MAX_COPY_BYTES:
            self.log.warn("workspace_copy.too_large", total_bytes=total)
            return False

        use_zstd = shutil.which("zstd") is not None
        extension = "tar.zst" if use_zstd else "tar.gz"
        with tempfile.TemporaryDirectory(prefix="oi-workspace-copy-") as scratch:
            archive = Path(scratch) / f"copy.{extension}"
            process = await asyncio.create_subprocess_exec(
                *_tar_command(self.roots, archive, use_zstd),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()
            # 1 is GNU tar's "a file changed as we read it", which a live tree may do.
            if process.returncode not in (0, 1) or not archive.exists():
                raise RuntimeError(f"tar exited {process.returncode}: {stderr.decode()[-300:]}")
            size = archive.stat().st_size

            client = self._client()
            response = await client.post(
                self._url("/workspace-copies"),
                json={"sizeBytes": size, "extension": extension},
                headers=self._headers(),
            )
            if response.status_code == 501:
                self._unavailable = True
                self.log.info("workspace_copy.unavailable")
                return False
            response.raise_for_status()
            upload = response.json()
            parts = await put_parts(
                client, archive, size, list(upload["parts"]), int(upload["partSizeBytes"])
            )
            response = await client.post(
                self._url("/workspace-copies/complete"),
                json={"key": upload["key"], "uploadId": upload["uploadId"], "parts": parts},
                headers=self._headers(),
            )
            response.raise_for_status()

        self._remember(digest)
        self._last_saved_at = time.monotonic()
        self.log.info(
            "workspace_copy.saved",
            reason=reason,
            size_bytes=size,
            source_bytes=total,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return True

    async def aclose(self) -> None:
        if self._scheduled is not None and not self._scheduled.done():
            self._scheduled.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._scheduled
        if self.http is not None:
            await self.http.aclose()
            self.http = None


def _extract(source: IO[bytes] | gzip.GzipFile, roots: CopyRoots) -> int:
    """Unpack a tar stream into ``roots.root``; only members inside the roots, safely."""
    count = 0
    with tarfile.open(fileobj=source, mode="r|") as archive:
        for member in archive:
            if not roots.allows(member.name):
                continue
            try:
                archive.extract(member, path=roots.root, filter="data")
            except tarfile.FilterError:
                # Outside the roots after all (.., absolute links): never written.
                continue
            count += 1
    return count


def unpack(archive: Path, roots: CopyRoots) -> int:
    """Unpack a downloaded copy (zstd or gzip); returns the number of members written."""
    with archive.open("rb") as handle:
        magic = handle.read(4)
    if magic.startswith(GZIP_MAGIC):
        with gzip.open(archive, "rb") as stream:
            return _extract(stream, roots)
    if magic == ZSTD_MAGIC:
        with subprocess.Popen(
            ["zstd", "-dc", str(archive)], stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as process:
            assert process.stdout is not None
            count = _extract(process.stdout, roots)
            process.stdout.close()
            if process.wait() != 0:
                raise RuntimeError("zstd could not read the workspace copy")
            return count
    raise RuntimeError("The workspace copy is neither zstd nor gzip")


async def restore_from_url(
    url: str,
    roots: CopyRoots,
    log: StructuredLogger,
    *,
    http: httpx.AsyncClient | None = None,
) -> bool:
    """Download a copy and unpack it; True on success. Failures are logged, never raised."""
    started = time.monotonic()
    client = http or httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_SECONDS)
    try:
        with tempfile.TemporaryDirectory(prefix="oi-workspace-restore-") as scratch:
            archive = Path(scratch) / "copy"
            async with client.stream("GET", url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                response.raise_for_status()
                with archive.open("wb") as handle:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        handle.write(chunk)
            size = archive.stat().st_size
            members = await asyncio.to_thread(unpack, archive, roots)
        log.info(
            "workspace_copy.restored",
            size_bytes=size,
            members=members,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return True
    except (httpx.HTTPError, OSError, RuntimeError, tarfile.TarError, DirectUploadError) as error:
        log.error("workspace_copy.restore_failed", exc=error)
        return False
    finally:
        if http is None:
            await client.aclose()


def restore_url_from_env(environment: dict[str, str] | Any = os.environ) -> str | None:
    value = environment.get(WORKSPACE_RESTORE_URL_ENV_VAR, "")
    return value or None
