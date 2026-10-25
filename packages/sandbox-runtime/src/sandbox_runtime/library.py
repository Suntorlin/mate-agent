"""library: the user's files in the sandbox (stdlib only).

  library ls [--json]                 the asset library: name, kind, size
  library get NAME [NAME ...] [-o DIR]
                                      download into /workspace/library/, or DIR (prints the paths)
  library put FILE [--name N] [--kind K]
                                      save a file into the library (kept across sessions)
  library sync                        index the library and say what is there
  library inputs                      fetch files the user attached into /workspace/inputs/

Files the user attaches to a message are fetched into /workspace/inputs/ before the turn
starts. The library is indexed at session start and downloaded on first use, so a large
library never slows a session down.

Bytes go straight to and from the object store through short-lived signed URLs, in parallel
ranges, or through the control plane where the store is not reachable from here.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WORKSPACE = Path(os.environ.get("WORKSPACE_DIR", "/workspace"))
LIBRARY_DIR = WORKSPACE / "library"
INPUTS_DIR = WORKSPACE / "inputs"
INPUTS_MANIFEST = ".inputs.json"
INDEX_FILE = "index.json"

KINDS = ("video", "audio", "image", "font", "lut", "logo", "other")
RANGE_BYTES = 32 * 1024 * 1024
STREAM_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_WORKERS = 8
UPLOAD_WORKERS = 4
SIGN_BATCH = 100
ATTEMPTS = 4
REQUEST_TIMEOUT_SECONDS = 120
# Cloudflare in front of the control plane rejects urllib's default "Python-urllib/3.x" agent
# (error 1010), so every request names itself.
USER_AGENT = "agent-engine-sandbox/1 (library)"


class LibraryError(Exception):
    pass


@dataclass(frozen=True)
class RemoteFile:
    id: str
    name: str
    kind: str
    size_bytes: int
    attached_at: int | None
    updated_at: int

    @classmethod
    def parse(cls, value: dict[str, Any]) -> RemoteFile:
        return cls(
            id=str(value["id"]),
            name=safe_name(str(value["name"])),
            kind=str(value.get("kind") or "other"),
            size_bytes=int(value.get("sizeBytes") or 0),
            attached_at=value.get("attachedAt"),
            updated_at=int(value.get("updatedAt") or 0),
        )


def safe_name(name: str) -> str:
    """One path segment: the control plane sanitizes names, this is the sandbox's own guard."""
    cleaned = "".join(ch for ch in name.replace("/", "-").replace("\\", "-") if ch >= " ")
    cleaned = cleaned.strip().lstrip(".").strip()
    return cleaned or "file"


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit in ("B", "KB") else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def session_id_from_env(environ: dict[str, str] | os._Environ[str]) -> str:
    try:
        config = json.loads(environ.get("SESSION_CONFIG") or "{}")
    except json.JSONDecodeError:
        config = {}
    return str(config.get("sessionId") or config.get("session_id") or "")


class Client:
    """The control plane's sandbox file routes, authenticated with the sandbox token."""

    def __init__(self, control_plane_url: str, session_id: str, token: str) -> None:
        if not control_plane_url or not session_id or not token:
            raise LibraryError("this sandbox is not connected to a session")
        self.base = f"{control_plane_url.rstrip('/')}/sessions/{session_id}/files"
        self.token = token

    @classmethod
    def from_env(cls) -> Client:
        return cls(
            os.environ.get("CONTROL_PLANE_URL", ""),
            session_id_from_env(os.environ),
            os.environ.get("SANDBOX_AUTH_TOKEN", ""),
        )

    def _request(
        self,
        method: str,
        url: str,
        *,
        body: bytes | None = None,
        json_body: Any = None,
        headers: dict[str, str] | None = None,
        authorized: bool = True,
    ) -> tuple[int, bytes]:
        all_headers = {"User-Agent": USER_AGENT, **(headers or {})}
        if authorized:
            all_headers["Authorization"] = f"Bearer {self.token}"
        if json_body is not None:
            body = json.dumps(json_body).encode()
            all_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, method=method, headers=all_headers)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def json(self, method: str, path: str, payload: Any = None) -> Any:
        status, data = self._request(method, f"{self.base}{path}", json_body=payload)
        if status >= 400:
            raise LibraryError(error_message(data) or f"HTTP {status}")
        return json.loads(data or b"{}")

    def index(self) -> dict[str, Any]:
        index: dict[str, Any] = self.json("GET", "")
        return index

    def download(self, file: RemoteFile, dest: Path) -> Path:
        """Fetch ``file`` to ``dest`` in parallel ranges; atomic, so a reader never sees half."""
        info = self.json("GET", f"/{file.id}/download")
        direct = info.get("transfer") == "direct" and info.get("url")
        url = info["url"] if direct else f"{self.base}/{file.id}/content"
        size = int(info.get("sizeBytes", file.size_bytes))
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".library-", suffix=".part", dir=dest.parent)
        tmp = Path(tmp_name)
        try:
            os.ftruncate(fd, size)
            ranges = [
                (start, min(start + RANGE_BYTES, size) - 1) for start in range(0, size, RANGE_BYTES)
            ]
            errors: list[BaseException] = []

            def fetch(span: tuple[int, int]) -> None:
                start, end = span
                for attempt in range(ATTEMPTS):
                    try:
                        self._read_range(url, start, end, fd, authorized=not direct)
                        return
                    except (OSError, LibraryError) as error:
                        if attempt == ATTEMPTS - 1:
                            errors.append(error)
                            return
                        time.sleep(0.5 * 2**attempt)

            with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
                list(pool.map(fetch, ranges))
            if errors:
                raise LibraryError(str(errors[0]))
            os.fsync(fd)
        except BaseException:
            os.close(fd)
            tmp.unlink(missing_ok=True)
            raise
        os.close(fd)
        tmp.replace(dest)
        return dest

    def _read_range(self, url: str, start: int, end: int, fd: int, *, authorized: bool) -> None:
        """Stream bytes ``start``..``end`` of ``url`` into ``fd`` at the same offsets."""
        headers = {"Range": f"bytes={start}-{end}", "User-Agent": USER_AGENT}
        if authorized:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            raise LibraryError(f"HTTP {error.code} reading a file") from error
        with response:
            if response.status not in (200, 206):
                raise LibraryError(f"HTTP {response.status} reading a file")
            if response.status == 200 and start != 0:
                raise LibraryError("the server ignored the byte range")
            offset = start
            while offset <= end:
                chunk = response.read(min(STREAM_CHUNK_BYTES, end - offset + 1))
                if not chunk:
                    break
                os.pwrite(fd, chunk, offset)
                offset += len(chunk)
        if offset != end + 1:
            raise LibraryError("the connection closed early")

    def upload(self, path: Path, name: str, kind: str | None) -> dict[str, Any]:
        """Save ``path`` into the owner's library as ``name``; resumes a matching open upload."""
        size = path.stat().st_size
        if size <= 0:
            raise LibraryError(f"{path} is empty")
        request: dict[str, Any] = {"name": name, "sizeBytes": size, "scope": "library"}
        if kind:
            request["kind"] = kind
        created = self.json("POST", "/uploads", request)
        file_id = created["file"]["id"]
        plan = created["upload"]
        part_size = int(plan["partSizeBytes"])
        done = set(plan.get("uploadedParts") or [])
        wanted = [n for n in range(1, int(plan["partCount"]) + 1) if n not in done]
        lock = threading.Lock()
        errors: list[BaseException] = []

        def send(part: dict[str, Any], relay: bool) -> None:
            number = int(part["partNumber"])
            with path.open("rb") as handle:
                handle.seek((number - 1) * part_size)
                data = handle.read(part_size)
            url = f"{self.base}/{file_id}/upload/parts/{number}" if relay else part["url"]
            for attempt in range(ATTEMPTS):
                status, body = self._request("PUT", url, body=data, authorized=relay)
                if status < 300:
                    return
                if attempt == ATTEMPTS - 1:
                    with lock:
                        errors.append(
                            LibraryError(error_message(body) or f"HTTP {status} on part {number}")
                        )
                    return
                time.sleep(0.5 * 2**attempt)

        for offset in range(0, len(wanted), SIGN_BATCH):
            batch = wanted[offset : offset + SIGN_BATCH]
            signed = self.json("POST", f"/{file_id}/upload/parts", {"partNumbers": batch})
            relay = signed.get("transfer") != "direct"
            with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
                list(pool.map(send, signed["parts"], [relay] * len(signed["parts"])))
            if errors:
                raise LibraryError(str(errors[0]))
        completed: dict[str, Any] = self.json("POST", f"/{file_id}/upload/complete")["file"]
        return completed


def error_message(data: bytes) -> str:
    try:
        parsed = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return data.decode("utf-8", "replace")[:200]
    return (
        str(parsed.get("error") or parsed.get("message") or "") if isinstance(parsed, dict) else ""
    )


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------


def library_files(index: dict[str, Any]) -> list[RemoteFile]:
    return [RemoteFile.parse(item) for item in index.get("library") or []]


def write_index(index: dict[str, Any], library_dir: Path = LIBRARY_DIR) -> None:
    library_dir.mkdir(parents=True, exist_ok=True)
    entries = [
        {
            "name": file.name,
            "kind": file.kind,
            "sizeBytes": file.size_bytes,
            "downloaded": (library_dir / file.name).is_file(),
        }
        for file in library_files(index)
    ]
    atomic_write(
        library_dir / INDEX_FILE, json.dumps({"files": entries}, ensure_ascii=False, indent=2)
    )


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text)
    tmp.replace(path)


def find(files: list[RemoteFile], wanted: str) -> RemoteFile:
    for file in files:
        if wanted in (file.name, file.id):
            return file
    lowered = wanted.lower()
    matches = [file for file in files if lowered in file.name.lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise LibraryError(f"no library file named {wanted!r} (see library ls)")
    names = ", ".join(file.name for file in matches[:8])
    raise LibraryError(f"{wanted!r} matches several files: {names}")


def get(
    client: Client,
    names: list[str],
    library_dir: Path = LIBRARY_DIR,
    output_dir: Path | None = None,
) -> list[Path]:
    """Download ``names`` into ``output_dir``, or the library folder when none is given."""
    index = client.index()
    files = library_files(index)
    target_dir = output_dir or library_dir
    paths = []
    for wanted in names:
        file = find(files, wanted)
        dest = target_dir / file.name
        if not (dest.is_file() and dest.stat().st_size == file.size_bytes):
            client.download(file, dest)
        paths.append(dest)
    # The index records what the library folder holds; elsewhere is the agent's own business.
    if output_dir is None:
        write_index(index, library_dir)
    return paths


def sync(client: Client, library_dir: Path = LIBRARY_DIR) -> str:
    """Session start: index the library and say what is there."""
    index = client.index()
    write_index(index, library_dir)
    files = library_files(index)
    lines = []
    if files:
        total = sum(file.size_bytes for file in files)
        lines.append(
            f"The user's asset library has {len(files)} files ({human_size(total)}): "
            f"`library ls` lists them, `library get <name> [-o DIR]` downloads one into "
            f"{library_dir}/ (or DIR), `library put <file>` saves a result there for later "
            "sessions."
        )
    else:
        lines.append(
            "The user's asset library is empty; `library put <file>` saves a result there "
            "for later sessions."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InputsResult:
    arrived: list[tuple[Path, int]]
    failed: list[str]


def _unique_path(directory: Path, name: str, taken: set[str]) -> Path:
    candidate = name
    stem, dot, suffix = name.rpartition(".")
    if not dot:
        stem, suffix = name, ""
    counter = 2
    while candidate in taken:
        candidate = f"{stem} ({counter}){'.' + suffix if suffix else ''}"
        counter += 1
    return directory / candidate


def sync_inputs(client: Client, inputs_dir: Path = INPUTS_DIR) -> InputsResult:
    """Fetch every attached input this sandbox does not have yet into ``inputs_dir``."""
    index = client.index()
    manifest_path = inputs_dir / INPUTS_MANIFEST
    try:
        manifest: dict[str, str] = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        manifest = {}
    taken = set(manifest.values())
    arrived: list[tuple[Path, int]] = []
    failed: list[str] = []
    for item in index.get("inputs") or []:
        file = RemoteFile.parse(item)
        known = manifest.get(file.id)
        if known and (inputs_dir / known).is_file():
            continue
        dest = inputs_dir / known if known else _unique_path(inputs_dir, file.name, taken)
        try:
            client.download(file, dest)
        except (OSError, LibraryError):
            failed.append(file.name)
            continue
        manifest[file.id] = dest.name
        taken.add(dest.name)
        arrived.append((dest, file.size_bytes))
        atomic_write(manifest_path, json.dumps(manifest, ensure_ascii=False))
    return InputsResult(arrived=arrived, failed=failed)


# How the sandbox reads the documents users attach (the media-edit image installs the readers).
DOCUMENT_READERS = {
    ".pdf": "pdftotext -raw (pdftoppm -png for pages to look at)",
    ".doc": "catdoc -d utf-8",
    ".ppt": "catppt -d utf-8",
    ".docx": "pandoc -t plain or python-docx",
    ".xls": "python3 with xlrd",
    ".xlsx": "python3 with openpyxl",
    ".pptx": "python3 with python-pptx",
}


def inputs_note(result: InputsResult) -> str | None:
    """What the agent is told about files that arrived with this message."""
    lines = []
    if result.arrived:
        listed = ", ".join(f"{path} ({human_size(size)})" for path, size in result.arrived)
        lines.append(f"[Files the user attached are ready: {listed}]")
        suffixes = dict.fromkeys(Path(path).suffix.lower() for path, _ in result.arrived)
        readers = [f"{s} {DOCUMENT_READERS[s]}" for s in suffixes if s in DOCUMENT_READERS]
        if readers:
            lines.append(f"[Read them with: {'; '.join(readers)}]")
    if result.failed:
        lines.append(f"[These attached files could not be fetched: {', '.join(result.failed)}]")
    return "\n".join(lines) or None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_ls(client: Client, as_json: bool) -> int:
    index = client.index()
    write_index(index)
    files = library_files(index)
    if as_json:
        print(
            json.dumps(
                json.loads((LIBRARY_DIR / INDEX_FILE).read_text()), ensure_ascii=False, indent=2
            )
        )
        return 0
    if not files:
        print("The library is empty.")
        return 0
    for file in files:
        marks = [file.kind, human_size(file.size_bytes)]
        if (LIBRARY_DIR / file.name).is_file():
            marks.append("downloaded")
        print(f"{file.name}\t{' · '.join(marks)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="library", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    ls = sub.add_parser("ls", help="list the library")
    ls.add_argument("--json", action="store_true")
    get_parser = sub.add_parser("get", help="download library files into /workspace/library")
    get_parser.add_argument("names", nargs="+")
    get_parser.add_argument(
        "-o", "--output", metavar="DIR", help="download into DIR instead (created if missing)"
    )
    put = sub.add_parser("put", help="save a file into the library")
    put.add_argument("file")
    put.add_argument("--name")
    put.add_argument("--kind", choices=KINDS)
    sub.add_parser("sync", help="index the library")
    sub.add_parser("inputs", help="fetch attached files into /workspace/inputs")
    args = parser.parse_args(argv)

    try:
        client = Client.from_env()
        if args.command == "ls":
            return cmd_ls(client, args.json)
        if args.command == "get":
            output = Path(args.output).expanduser() if args.output else None
            if output is not None and output.exists() and not output.is_dir():
                raise LibraryError(f"{output} is not a directory")
            for path in get(client, args.names, output_dir=output):
                print(path)
            return 0
        if args.command == "put":
            path = Path(args.file)
            if not path.is_file():
                raise LibraryError(f"{path} is not a file")
            saved = client.upload(path, safe_name(args.name or path.name), args.kind)
            print(f"Saved to the library as {saved['name']}")
            return 0
        if args.command == "sync":
            # A session-start hook: a library that cannot be reached must not hold the session up.
            try:
                print(sync(client))
            except (LibraryError, OSError, urllib.error.URLError) as error:
                print(f"library: {error}", file=sys.stderr)
            return 0
        if args.command == "inputs":
            note = inputs_note(sync_inputs(client))
            if note:
                print(note)
            return 0
    except LibraryError as error:
        print(f"library: {error}", file=sys.stderr)
        return 1
    except (OSError, urllib.error.URLError) as error:
        print(f"library: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        sys.exit(main())
