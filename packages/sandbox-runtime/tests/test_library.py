"""library against a stand-in control plane and object store on loopback."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime import library as library_module
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import HarnessId
from sandbox_runtime.library import (
    Client,
    LibraryError,
    get,
    inputs_note,
    sync,
    sync_inputs,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

TOKEN = "sandbox-token"
SESSION = "session-1"


def payload(size: int, seed: int = 1) -> bytes:
    return bytes((i * 7 + seed) % 251 for i in range(size))


class FakeControlPlane:
    """The sandbox file routes plus a signed-URL store, sharing one HTTP server."""

    def __init__(self) -> None:
        self.files: dict[str, dict[str, Any]] = {}
        self.blobs: dict[str, bytes] = {}
        self.inputs: list[str] = []
        self.library: list[str] = []
        self.direct = False
        self.requests: list[tuple[str, str, str | None]] = []
        self.uploads: dict[str, dict[int, bytes]] = {}
        self.fail_content: set[str] = set()
        self.agents: set[str] = set()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, file_id: str, name: str, data: bytes, **extra: Any) -> None:
        self.files[file_id] = {
            "id": file_id,
            "name": name,
            "kind": extra.get("kind", "other"),
            "sizeBytes": len(data),
            "attachedAt": extra.get("attachedAt"),
            "updatedAt": 1,
        }
        self.blobs[file_id] = data

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        plane = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None):
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _json(self, status: int, value: Any) -> None:
                self._send(status, json.dumps(value).encode(), {"Content-Type": "application/json"})

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _ranged(self, data: bytes) -> None:
                header = self.headers.get("Range")
                if not header:
                    self._send(200, data)
                    return
                start, end = (int(x) for x in header.removeprefix("bytes=").split("-"))
                self._send(206, data[start : end + 1], {"Content-Range": f"bytes {start}-{end}"})

            def _authorized(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {TOKEN}"

            def do_GET(self) -> None:
                plane.requests.append(("GET", self.path, self.headers.get("Authorization")))
                plane.agents.add(self.headers.get("User-Agent", ""))
                if self.path.startswith("/store/"):
                    file_id = self.path.split("/")[2].split("?")[0]
                    self._ranged(plane.blobs[file_id])
                    return
                if not self._authorized():
                    self._json(401, {"error": "Unauthorized"})
                    return
                base = f"/sessions/{SESSION}/files"
                rest = self.path.removeprefix(base)
                if rest == "":
                    self._json(
                        200,
                        {
                            "inputs": [plane.files[i] for i in plane.inputs],
                            "library": [plane.files[i] for i in plane.library],
                        },
                    )
                    return
                file_id, action = rest.strip("/").split("/")
                if action == "download":
                    url = f"{plane.url}/store/{file_id}?sig=1" if plane.direct else None
                    self._json(
                        200,
                        {
                            "transfer": "direct" if plane.direct else "relay",
                            "url": url,
                            "sizeBytes": len(plane.blobs[file_id]),
                            "expiresAt": 0,
                        },
                    )
                    return
                if action == "content":
                    if file_id in plane.fail_content:
                        self._json(500, {"error": "boom"})
                        return
                    self._ranged(plane.blobs[file_id])
                    return
                self._json(404, {"error": "not found"})

            def do_POST(self) -> None:
                plane.requests.append(("POST", self.path, self.headers.get("Authorization")))
                plane.agents.add(self.headers.get("User-Agent", ""))
                if not self._authorized():
                    self._json(401, {"error": "Unauthorized"})
                    return
                body = json.loads(self._body() or b"{}")
                base = f"/sessions/{SESSION}/files"
                rest = self.path.removeprefix(base)
                if rest == "/uploads":
                    file_id = f"up-{len(plane.uploads) + 1}"
                    plane.uploads[file_id] = {}
                    plane.files[file_id] = {"id": file_id, "name": body["name"], "kind": "other"}
                    plane.files[file_id]["sizeBytes"] = body["sizeBytes"]
                    count = -(-body["sizeBytes"] // 10)
                    self._json(
                        201,
                        {
                            "file": plane.files[file_id],
                            "upload": {
                                "partSizeBytes": 10,
                                "partCount": count,
                                "uploadedParts": [],
                            },
                        },
                    )
                    return
                file_id = rest.split("/")[1]
                if rest.endswith("/upload/parts"):
                    parts = [
                        {
                            "partNumber": n,
                            "url": f"{plane.url}/store-put/{file_id}/{n}" if plane.direct else None,
                        }
                        for n in body["partNumbers"]
                    ]
                    transfer = "direct" if plane.direct else "relay"
                    self._json(200, {"transfer": transfer, "parts": parts, "expiresAt": 0})
                    return
                if rest.endswith("/upload/complete"):
                    parts = plane.uploads[file_id]
                    plane.blobs[file_id] = b"".join(parts[n] for n in sorted(parts))
                    plane.library.append(file_id)
                    self._json(200, {"file": plane.files[file_id]})
                    return
                self._json(404, {"error": "not found"})

            def do_PUT(self) -> None:
                plane.requests.append(("PUT", self.path, self.headers.get("Authorization")))
                plane.agents.add(self.headers.get("User-Agent", ""))
                data = self._body()
                if self.path.startswith("/store-put/"):
                    _, _, file_id, number = self.path.split("/")
                    plane.uploads[file_id][int(number)] = data
                    self._send(200, b"")
                    return
                if not self._authorized():
                    self._json(401, {"error": "Unauthorized"})
                    return
                parts = self.path.split("/")
                plane.uploads[parts[4]][int(parts[-1])] = data
                self._json(200, {"partNumber": int(parts[-1])})

        return Handler

    def client(self) -> Client:
        return Client(self.url, SESSION, TOKEN)


@pytest.fixture
def plane(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeControlPlane]:
    # Small ranges so a few KB exercise the parallel, multi-range path.
    monkeypatch.setattr(library_module, "RANGE_BYTES", 1000)
    monkeypatch.setattr(library_module, "STREAM_CHUNK_BYTES", 256)
    fake = FakeControlPlane()
    yield fake
    fake.server.shutdown()


def test_every_request_names_itself_for_cloudflare(plane: FakeControlPlane, tmp_path: Path) -> None:
    # Cloudflare in front of the control plane rejects urllib's default agent (error 1010).
    plane.add("f1", "clip.mp4", payload(3500))
    plane.add("l1", "Warm.cube", payload(50), kind="lut")
    plane.inputs = ["f1"]
    plane.library = ["l1"]
    sync_inputs(plane.client(), tmp_path / "inputs")
    plane.direct = True
    get(plane.client(), ["warm"], tmp_path / "library")
    assert plane.agents
    assert all(agent.startswith("agent-engine-sandbox/") for agent in plane.agents), plane.agents


def test_inputs_arrive_once_with_unique_names(plane: FakeControlPlane, tmp_path: Path) -> None:
    clip, other = payload(4321), payload(10, 9)
    plane.add("f1", "clip.mov", clip, kind="video", attachedAt=1)
    plane.add("f2", "clip.mov", other, kind="video", attachedAt=2)
    plane.inputs = ["f1", "f2"]

    first = sync_inputs(plane.client(), tmp_path)
    assert [path.name for path, _ in first.arrived] == ["clip.mov", "clip (2).mov"]
    assert (tmp_path / "clip.mov").read_bytes() == clip
    assert (tmp_path / "clip (2).mov").read_bytes() == other
    assert inputs_note(first) == (
        f"[Files the user attached are ready: {tmp_path}/clip.mov (4 KB), "
        f"{tmp_path}/clip (2).mov (10 B)]"
    )
    # Relayed reads carry the sandbox token; nothing half-written is left behind.
    assert all(auth == f"Bearer {TOKEN}" for _, _, auth in plane.requests)
    assert not list(tmp_path.glob("*.part"))

    again = sync_inputs(plane.client(), tmp_path)
    assert again.arrived == [] and inputs_note(again) is None


def test_attached_documents_come_with_how_to_read_them(
    plane: FakeControlPlane, tmp_path: Path
) -> None:
    plane.add("f1", "brief.DOC", payload(10))
    plane.add("f2", "budget.xlsx", payload(10))
    plane.add("f3", "notes.txt", payload(10))
    plane.inputs = ["f1", "f2", "f3"]
    note = inputs_note(sync_inputs(plane.client(), tmp_path))
    assert note is not None
    assert note.splitlines()[1] == (
        "[Read them with: .doc catdoc -d utf-8; .xlsx python3 with openpyxl]"
    )


def test_direct_downloads_do_not_send_the_token(plane: FakeControlPlane, tmp_path: Path) -> None:
    plane.direct = True
    plane.add("f1", "big.mp4", payload(3500))
    plane.inputs = ["f1"]
    sync_inputs(plane.client(), tmp_path)
    assert (tmp_path / "big.mp4").read_bytes() == payload(3500)
    store_reads = [r for r in plane.requests if r[1].startswith("/store/")]
    assert len(store_reads) == 4
    assert all(auth is None for _, _, auth in store_reads)


def test_a_failed_input_is_named_not_fatal(plane: FakeControlPlane, tmp_path: Path) -> None:
    plane.add("f1", "ok.wav", payload(100))
    plane.add("f2", "broken.wav", payload(100))
    plane.inputs = ["f1", "f2"]
    plane.fail_content.add("f2")
    result = sync_inputs(plane.client(), tmp_path)
    assert [path.name for path, _ in result.arrived] == ["ok.wav"]
    assert result.failed == ["broken.wav"]
    assert "could not be fetched: broken.wav" in (inputs_note(result) or "")
    assert not (tmp_path / "broken.wav").exists()


def test_get_downloads_library_files_on_first_use(plane: FakeControlPlane, tmp_path: Path) -> None:
    plane.add("l1", "Warm.cube", payload(2500), kind="lut")
    plane.add("l2", "Logo.png", payload(50), kind="logo")
    plane.library = ["l1", "l2"]
    [path] = get(plane.client(), ["warm"], tmp_path)
    assert path == tmp_path / "Warm.cube" and path.read_bytes() == payload(2500)
    index = json.loads((tmp_path / "index.json").read_text())
    assert [(f["name"], f["downloaded"]) for f in index["files"]] == [
        ("Warm.cube", True),
        ("Logo.png", False),
    ]
    with pytest.raises(LibraryError, match="no library file"):
        get(plane.client(), ["missing"], tmp_path)


def test_get_can_download_into_a_directory_of_the_agents_choosing(
    plane: FakeControlPlane,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plane.add("l1", "Warm.cube", payload(2500), kind="lut")
    plane.library = ["l1"]
    out = tmp_path / "work" / "luts"
    [path] = get(plane.client(), ["warm"], tmp_path / "library", output_dir=out)
    assert path == out / "Warm.cube" and path.read_bytes() == payload(2500)
    assert not (tmp_path / "library" / "Warm.cube").exists()

    monkeypatch.setenv("CONTROL_PLANE_URL", plane.url)
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"sessionId": SESSION}))
    target = tmp_path / "cli"
    assert library_module.main(["get", "warm", "-o", str(target)]) == 0
    assert capsys.readouterr().out.strip() == str(target / "Warm.cube")
    assert (target / "Warm.cube").read_bytes() == payload(2500)

    not_a_dir = tmp_path / "file.txt"
    not_a_dir.write_text("x")
    assert library_module.main(["get", "warm", "--output", str(not_a_dir)]) == 1
    assert "is not a directory" in capsys.readouterr().err


def test_put_saves_a_file_through_the_relay_or_signed_urls(
    plane: FakeControlPlane, tmp_path: Path
) -> None:
    source = tmp_path / "final.mp4"
    source.write_bytes(payload(35))
    plane.client().upload(source, "final.mp4", "video")
    assert plane.blobs["up-1"] == payload(35)
    relay_puts = [r for r in plane.requests if r[0] == "PUT"]
    assert len(relay_puts) == 4 and all(auth == f"Bearer {TOKEN}" for *_, auth in relay_puts)

    plane.direct = True
    plane.requests.clear()
    plane.client().upload(source, "again.mp4", None)
    assert plane.blobs["up-2"] == payload(35)
    assert all(auth is None for method, _, auth in plane.requests if method == "PUT")


def test_sync_indexes_the_library_and_says_what_is_there(
    plane: FakeControlPlane, tmp_path: Path
) -> None:
    plane.add("l", "logo.svg", payload(40), kind="logo")
    plane.add("x", "b-roll.mov", payload(90), kind="video")
    plane.library = ["l", "x"]

    library = tmp_path / "library"
    summary = sync(plane.client(), library)

    # Files are indexed, not downloaded: they wait for `library get`.
    assert not (library / "b-roll.mov").exists()
    index = json.loads((library / "index.json").read_text())
    assert [entry["name"] for entry in index["files"]] == ["logo.svg", "b-roll.mov"]
    assert "2 files" in summary and "`library get <name> [-o DIR]`" in summary


def test_sync_says_when_the_library_is_empty(plane: FakeControlPlane, tmp_path: Path) -> None:
    assert "library is empty" in sync(plane.client(), tmp_path / "library")


def test_sync_command_never_fails_the_session_start(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"sessionId": SESSION}))
    assert library_module.main(["sync"]) == 0
    assert "library:" in capsys.readouterr().err


def test_cli_refuses_without_a_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SANDBOX_AUTH_TOKEN", raising=False)
    assert library_module.main(["ls"]) == 1


@pytest.fixture
def bridge() -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id=SESSION,
        control_plane_url="http://127.0.0.1:9",
        auth_token=TOKEN,
        harness_id=HarnessId.OPENCODE,
    )
    bridge._send_media_warning = AsyncMock()  # type: ignore[method-assign]
    return bridge


async def test_bridge_notes_arrived_inputs_and_warns_about_failures(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = library_module.InputsResult(
        arrived=[(Path("/workspace/inputs/a.mov"), 2048)], failed=["b.mov"]
    )
    monkeypatch.setattr("sandbox_runtime.bridge.sync_inputs", lambda client: result)
    note = await bridge._fetch_inputs("m1")
    assert note == (
        "[Files the user attached are ready: /workspace/inputs/a.mov (2 KB)]\n"
        "[These attached files could not be fetched: b.mov]"
    )
    bridge._send_media_warning.assert_awaited_once_with("b.mov could not be loaded.")


async def test_bridge_survives_an_unreachable_control_plane(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:

    def boom(client: Client) -> None:
        raise LibraryError("down")

    monkeypatch.setattr("sandbox_runtime.bridge.sync_inputs", boom)
    assert await bridge._fetch_inputs("m1") is None
