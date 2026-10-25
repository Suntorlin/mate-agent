"""gateway-key: the token Claude Code sends to the LLM gateway, renewed before it expires."""

import base64
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from sandbox_runtime import gateway_key as key

NOW = 1_800_000_000.0
BIN = Path(key.__file__).parent / "bin" / "gateway-key"


def jwt(exp: float, tag: str = "t") -> str:
    def seg(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{seg({'alg': 'HS256'})}.{seg({'sub': 'u', 'sid': tag, 'exp': int(exp)})}.sig"


class ControlPlane:
    """Answers the credentials route with `token`, counting calls; `status` other than 200 fails."""

    def __init__(self, token: str = "", status: int = 200) -> None:
        self.token, self.status, self.calls, self.auth = token, status, 0, []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_POST(self) -> None:
                outer.calls += 1
                outer.auth.append((self.path, self.headers.get("Authorization")))
                body = json.dumps({"env": {"GATEWAY_TOKEN": outer.token}}).encode()
                self.send_response(outer.status)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def control_plane():
    servers: list[ControlPlane] = []

    def make(**kwargs: object) -> ControlPlane:
        servers.append(ControlPlane(**kwargs))  # type: ignore[arg-type]
        return servers[-1]

    yield make
    for server in servers:
        server.close()


def environ(tmp_path: Path, token: str, cp_url: str = "") -> dict[str, str]:
    return {
        "GATEWAY_TOKEN": token,
        "CONTROL_PLANE_URL": cp_url,
        "SANDBOX_AUTH_TOKEN": "sandbox-token",
        "SESSION_CONFIG": json.dumps({"session_id": "s/1"}),
        "CLAUDE_CONFIG_DIR": str(tmp_path / "claude"),
    }


def test_a_token_with_time_left_is_printed_without_asking(tmp_path: Path, control_plane) -> None:
    cp = control_plane(token=jwt(NOW + 7200, "new"))
    held = jwt(NOW + 3600, "held")
    assert key.current_token(environ(tmp_path, held, cp.url), now=NOW) == held
    assert cp.calls == 0


def test_a_token_near_expiry_is_renewed_and_kept(tmp_path: Path, control_plane) -> None:
    fresh = jwt(NOW + 7200, "new")
    cp = control_plane(token=fresh)
    env = environ(tmp_path, jwt(NOW + 600, "old"), cp.url)
    assert key.current_token(env, now=NOW) == fresh
    assert cp.auth == [("/sessions/s%2F1/credentials", "Bearer sandbox-token")]
    # The renewed token is kept: the next ask needs no request.
    assert key.current_token(env, now=NOW) == fresh
    assert cp.calls == 1


def test_when_renewal_fails_the_token_in_hand_is_printed(tmp_path: Path, control_plane) -> None:
    cp = control_plane(status=503)
    old = jwt(NOW + 600, "old")
    assert key.current_token(environ(tmp_path, old, cp.url), now=NOW) == old
    assert cp.calls == 1


def test_an_unreadable_token_is_renewed(tmp_path: Path, control_plane) -> None:
    fresh = jwt(NOW + 7200, "new")
    cp = control_plane(token=fresh)
    assert key.current_token(environ(tmp_path, "not-a-jwt", cp.url), now=NOW) == fresh


def test_the_command_prints_the_token(tmp_path: Path, control_plane) -> None:
    fresh = jwt(9_999_999_999, "new")
    env = {**os.environ, **environ(tmp_path, fresh)}
    result = subprocess.run([str(BIN)], env=env, capture_output=True, text=True, check=True)
    assert result.stdout.strip() == fresh


def test_the_command_fails_with_no_token_at_all(tmp_path: Path) -> None:
    env = {**os.environ, **environ(tmp_path, "")}
    result = subprocess.run([str(BIN)], env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stdout == ""
