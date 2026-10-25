"""Prints the LLM gateway token for Claude Code's ``apiKeyHelper``.

The control plane mints the gateway token for two hours, so that one taken out of a sandbox is
soon worth nothing. Claude Code runs much longer than that, so instead of reading the token once
from its environment it asks this command for one: at start, every
``CLAUDE_CODE_API_KEY_HELPER_TTL_MS`` and whenever the gateway answers 401.

The token in hand is printed while it has a while left, without touching the network: the one in
the environment, or the last one renewed, kept in a file. Closer to its expiry a fresh one comes
from the control plane (``POST /sessions/<id>/credentials``, with the sandbox token). When
that fails the best token in hand is printed anyway: until it expires it still works, and after
that the gateway's 401 brings Claude Code back here.

Standard library only, and run as a file (see ``bin/gateway-key``): Claude Code waits for it.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

TOKEN_ENV_VAR = "GATEWAY_TOKEN"
# Renew a token with less than this left: well over the helper's refresh interval, so the token
# Claude Code holds never expires between two asks.
RENEW_BEFORE_SECONDS = 45 * 60
REQUEST_TIMEOUT_SECONDS = 10
USER_AGENT = "agent-engine-sandbox/1 (gateway-key)"
CACHE_FILE_NAME = "gateway-token"


def expires_at(token: str) -> float:
    """The token's ``exp`` claim, or 0 when it cannot be read (then it is renewed)."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return float(claims.get("exp") or 0)
    except (IndexError, ValueError, TypeError, AttributeError):
        return 0.0


def session_id(environ: Mapping[str, str]) -> str:
    try:
        config = json.loads(environ.get("SESSION_CONFIG") or "{}")
    except json.JSONDecodeError:
        return ""
    if not isinstance(config, dict):
        return ""
    return str(config.get("sessionId") or config.get("session_id") or "")


def cache_path(environ: Mapping[str, str]) -> Path:
    config_dir = environ.get("CLAUDE_CONFIG_DIR")
    base = Path(config_dir) if config_dir else Path(environ.get("HOME") or "/tmp") / ".claude"
    return base / CACHE_FILE_NAME


def read_cached(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def write_cached(path: Path, token: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(token)
        tmp.chmod(0o600)
        tmp.replace(path)
    except OSError:
        pass


def renew(environ: Mapping[str, str]) -> str:
    """A fresh token from the control plane, or "" when it gave none."""
    base = environ.get("CONTROL_PLANE_URL", "").rstrip("/")
    sandbox_token = environ.get("SANDBOX_AUTH_TOKEN", "")
    session = session_id(environ)
    if not base or not sandbox_token or not session:
        return ""
    request = urllib.request.Request(
        f"{base}/sessions/{urllib.parse.quote(session, safe='')}/credentials",
        data=b"{}",
        method="POST",
        headers={
            "Authorization": f"Bearer {sandbox_token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            env = json.load(response).get("env") or {}
    except (urllib.error.URLError, OSError, ValueError, AttributeError):
        return ""
    token = env.get(TOKEN_ENV_VAR) if isinstance(env, dict) else None
    return token if isinstance(token, str) else ""


def current_token(environ: Mapping[str, str], now: float | None = None) -> str:
    now = time.time() if now is None else now
    path = cache_path(environ)
    held = max(
        (t for t in (environ.get(TOKEN_ENV_VAR, ""), read_cached(path)) if t),
        key=expires_at,
        default="",
    )
    if held and expires_at(held) - now > RENEW_BEFORE_SECONDS:
        return held
    fresh = renew(environ)
    if fresh:
        write_cached(path, fresh)
        return fresh
    return held


def main() -> int:
    token = current_token(os.environ)
    if not token:
        print("gateway-key: no gateway token in hand and none issued", file=sys.stderr)
        return 1
    print(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
