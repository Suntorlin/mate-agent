"""Tests for sandbox media tool scripts."""

import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest

NODE_BINARY = shutil.which("node")
RUNTIME_DIR = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime"
UPLOAD_MEDIA_SCRIPT = RUNTIME_DIR / "bin" / "upload-media.js"
BRIDGE_CLIENT_MODULE = RUNTIME_DIR / "tools" / "_bridge-client.js"
TOOL_SUBPROCESS_TIMEOUT_SECONDS = 10
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"


pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required for media tool tests")


def _tool_env(overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
        }
    )
    if overrides:
        env.update(overrides)
    return env


class _CaptureHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, Any]]] = []
    status_code: ClassVar[int] = 201
    response_body: ClassVar[bytes] = b'{"artifactId":"artifact-1"}'

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        type(self).requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "content_type": self.headers.get("content-type"),
                "body": body,
            }
        )
        self.send_response(type(self).status_code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(type(self).response_body)

    def log_message(self, format: str, *args: Any) -> None:
        return


class _CaptureServer:
    def __init__(
        self, status_code: int = 201, response_body: bytes = b'{"artifactId":"artifact-1"}'
    ):
        self.status_code = status_code
        self.response_body = response_body

    def __enter__(self) -> "_CaptureServer":
        _CaptureHandler.requests = []
        _CaptureHandler.status_code = self.status_code
        _CaptureHandler.response_body = self.response_body
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.requests = _CaptureHandler.requests
        return self

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS)
        self.server.server_close()


class _DirectHandler(BaseHTTPRequestHandler):
    """The control plane's direct-upload routes plus the store's signed part URLs, in one server."""

    calls: ClassVar[list[dict[str, Any]]] = []
    parts: ClassVar[dict[int, bytes]] = {}
    part_size: ClassVar[int] = 4
    fail_parts: ClassVar[int] = 0

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        payload = json.loads(body or b"{}")
        type(self).calls.append(
            {"path": self.path, "authorization": self.headers.get("authorization"), "json": payload}
        )
        base = f"http://127.0.0.1:{self.server.server_port}"
        if self.path == "/sessions/session-1/uploads":
            count = max(1, -(-payload["sizeBytes"] // type(self).part_size))
            self._json(
                201,
                {
                    "artifactId": "file-1",
                    "objectKey": "sessions/session-1/files/file-1.fcpxml",
                    "uploadId": "up-1",
                    "filename": payload["filename"],
                    "partSizeBytes": type(self).part_size,
                    "parts": [
                        {"partNumber": n, "url": f"{base}/store?partNumber={n}"}
                        for n in range(1, count + 1)
                    ],
                },
            )
        elif self.path.endswith("/complete"):
            self._json(201, {"artifactId": "file-1", "filename": payload["filename"]})
        else:
            self._json(200, {"status": "aborted"})

    def do_PUT(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        number = int(self.path.rsplit("=", 1)[1])
        if type(self).fail_parts > 0:
            type(self).fail_parts -= 1
            self.send_response(500)
            self.end_headers()
            return
        type(self).parts[number] = body
        self.send_response(200)
        self.send_header("etag", f'"etag-{number}"')
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return


class _DirectServer:
    def __init__(self, part_size: int = 4, fail_parts: int = 0):
        _DirectHandler.calls = []
        _DirectHandler.parts = {}
        _DirectHandler.part_size = part_size
        _DirectHandler.fail_parts = fail_parts

    def __enter__(self) -> "_DirectServer":
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _DirectHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.calls = _DirectHandler.calls
        self.parts = _DirectHandler.parts
        return self

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS)
        self.server.server_close()


def _run_upload(*args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )


def test_upload_media_sends_any_file_straight_to_storage_in_parts(tmp_path: Path) -> None:
    handoff = tmp_path / "cut.fcpxml"
    handoff.write_bytes(b"<fcpxml version='1.10'/>")

    with _DirectServer(part_size=8) as server:
        result = _run_upload(
            str(handoff),
            "--artifact-type",
            "file",
            "--caption",
            "Final Cut 工程",
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
        )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"artifactId": "file-1", "filename": "cut.fcpxml"}
    start, complete = server.calls
    assert start["path"] == "/sessions/session-1/uploads"
    assert start["authorization"] == "Bearer sandbox-token"
    assert start["json"] == {"artifactType": "file", "filename": "cut.fcpxml", "sizeBytes": 24}
    assert b"".join(server.parts[n] for n in sorted(server.parts)) == handoff.read_bytes()
    assert complete["path"] == "/sessions/session-1/uploads/file-1/complete"
    assert complete["json"] == {
        "artifactType": "file",
        "uploadId": "up-1",
        "filename": "cut.fcpxml",
        "caption": "Final Cut 工程",
        "parts": [{"partNumber": n, "etag": f'"etag-{n}"'} for n in (1, 2, 3)],
    }


def test_upload_media_marks_project_bundles_and_renames(tmp_path: Path) -> None:
    bundle = tmp_path / "x.zip"
    bundle.write_bytes(b"PK\x03\x04zip")

    with _DirectServer(part_size=64) as server:
        result = _run_upload(
            str(bundle),
            "--artifact-type",
            "file",
            "--kind",
            "project",
            "--name",
            "北汉山 project.zip",
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
        )

    assert result.returncode == 0, result.stderr
    start, complete = server.calls
    assert start["json"]["filename"] == "北汉山 project.zip"
    assert complete["json"]["kind"] == "project"


def test_upload_media_retries_a_failed_part(tmp_path: Path) -> None:
    doc = tmp_path / "script.pdf"
    doc.write_bytes(b"%PDF-1.7 tiny")

    with _DirectServer(part_size=64, fail_parts=1) as server:
        result = _run_upload(
            str(doc),
            "--artifact-type",
            "file",
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
        )

    assert result.returncode == 0, result.stderr
    assert server.parts == {1: b"%PDF-1.7 tiny"}


def test_upload_media_aborts_when_storage_keeps_failing(tmp_path: Path) -> None:
    doc = tmp_path / "script.pdf"
    doc.write_bytes(b"%PDF-1.7 tiny")

    with _DirectServer(part_size=64, fail_parts=10) as server:
        result = _run_upload(
            str(doc),
            "--artifact-type",
            "file",
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
        )

    assert result.returncode == 1
    assert "Upload failed" in result.stderr
    assert [call["path"] for call in server.calls] == [
        "/sessions/session-1/uploads",
        "/sessions/session-1/uploads/file-1/abort",
    ]


def _multipart_text(body: bytes) -> str:
    return body.decode("utf-8", errors="ignore")


def test_upload_media_rejects_non_file_paths(tmp_path: Path) -> None:
    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(tmp_path)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "requires a path to a file" in result.stderr


def test_upload_media_rejects_unsupported_extensions(tmp_path: Path) -> None:
    unsupported = tmp_path / "shot.gif"
    unsupported.write_bytes(b"GIF89a")

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(unsupported)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "only previews .png, .jpg, .jpeg, .webp, .mp4, and .html files" in result.stderr
    assert "--artifact-type file" in result.stderr


def test_upload_media_requires_explicit_video_artifact_type(tmp_path: Path) -> None:
    video = tmp_path / "recording.mp4"
    video.write_bytes(MP4_BYTES)

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(video)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "MP4 files must be uploaded with --artifact-type video" in result.stderr


def test_upload_media_posts_video_metadata(tmp_path: Path) -> None:
    video = tmp_path / "recording.mp4"
    video.write_bytes(MP4_BYTES)

    with _CaptureServer() as server:
        result = subprocess.run(
            [
                NODE_BINARY,
                str(UPLOAD_MEDIA_SCRIPT),
                str(video),
                "--artifact-type",
                "video",
                "--caption",
                "Menu opens",
                "--source-url",
                "https://app.example.com/start",
                "--end-url",
                "https://app.example.com/end",
                "--duration-ms",
                "1200",
                "--recording-started-at",
                "1000",
                "--recording-ended-at",
                "2200",
                "--dimensions",
                '{"width":1280,"height":720}',
                "--truncated",
                "false",
            ],
            capture_output=True,
            text=True,
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
            check=False,
            timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
        )

    assert result.returncode == 0
    assert json.loads(result.stdout)["artifactId"] == "artifact-1"
    assert len(server.requests) == 1
    request = server.requests[0]
    assert request["path"] == "/sessions/session-1/media"
    assert request["authorization"] == "Bearer sandbox-token"
    body = _multipart_text(request["body"])
    assert 'name="artifactType"\r\n\r\nvideo' in body
    assert 'name="caption"\r\n\r\nMenu opens' in body
    assert 'name="durationMs"\r\n\r\n1200' in body
    assert 'name="dimensions"\r\n\r\n{"width":1280,"height":720}' in body


def test_upload_media_posts_a_page(tmp_path: Path) -> None:
    page = tmp_path / "storyboard.html"
    page.write_text("<!doctype html><h1>Storyboard</h1>")

    with _CaptureServer() as server:
        result = subprocess.run(
            [
                NODE_BINARY,
                str(UPLOAD_MEDIA_SCRIPT),
                str(page),
                "--artifact-type",
                "page",
                "--caption",
                "Storyboard",
            ],
            capture_output=True,
            text=True,
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
            check=False,
            timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
        )

    assert result.returncode == 0
    body = _multipart_text(server.requests[0]["body"])
    assert 'name="artifactType"\r\n\r\npage' in body
    assert 'name="caption"\r\n\r\nStoryboard' in body
    assert "Content-Type: text/html" in body


@pytest.mark.parametrize(
    ("name", "args", "message"),
    [
        ("page.html", [], "HTML files must be uploaded with --artifact-type page"),
        ("shot.png", ["--artifact-type", "page"], "--artifact-type page requires an .html file"),
    ],
)
def test_upload_media_keeps_pages_and_html_together(
    tmp_path: Path, name: str, args: list[str], message: str
) -> None:
    file = tmp_path / name
    file.write_bytes(b"<p>x</p>")

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(file), *args],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert message in result.stderr


def test_bridge_client_requires_sandbox_auth_token() -> None:
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            (
                "import(process.argv[1]).catch((error) => {"
                "console.error(error.message);"
                "process.exit(1);"
                "});"
            ),
            BRIDGE_CLIENT_MODULE.as_uri(),
        ],
        capture_output=True,
        text=True,
        env=_tool_env({"SANDBOX_AUTH_TOKEN": ""}),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "SANDBOX_AUTH_TOKEN not set" in result.stderr
