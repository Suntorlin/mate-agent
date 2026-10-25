"""A loopback proxy that keeps the product's MCP server authorized for the whole session.

The product a session belongs to hands the sandbox its MCP server as the session's entry with id
``app``, with a short-lived bearer token. Claude Code sends an HTTP MCP server's headers unchanged
for as long as it runs, so a static ``Authorization`` header stops working partway through a long
session. The Claude harness therefore points the product's server at this proxy, which forwards
every request to the product with a current token: it renews the token from the control plane
(``POST /sessions/<id>/app-token``) before it expires, and once more when the product answers
401, then replays the request. Claude Code never sees the token change.

Once the session has used up the spending cap its owner set (``budget``), a tool call is answered
here with a refusal and never reaches the product.

The proxy speaks just enough HTTP/1.1 for MCP's streamable HTTP transport: one request per
connection, request bodies by ``Content-Length`` or chunked, responses (including SSE streams)
relayed chunk by chunk as they arrive. Tokens never reach the logs.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote

import httpx

from .budget import SPEND_TIMEOUT_SECONDS, budget_refusal, refusal_result, spend_url

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Mapping, Sequence

    from .log_config import StructuredLogger

# The id of the session's ``mcp_servers`` entry that is the product's own MCP server. Its name is
# the one the product chose (APP_MCP_NAME on the control plane, "app" unless set), so the agent
# sees the product's tools as ``mcp__<name>__<tool>``.
APP_MCP_SERVER_ID: Final = "app"
# Renew a token this long after it was obtained when its expiry is not known, and this long
# before its expiry when it is: room for a slow renewal and for clock drift.
TOKEN_REFRESH_AFTER_SECONDS: Final = 40 * 60
TOKEN_REFRESH_MARGIN_SECONDS: Final = 5 * 60
TOKEN_TIMEOUT_SECONDS: Final = 30.0
UPSTREAM_CONNECT_TIMEOUT_SECONDS: Final = 30.0
# Some fronts reject default library user agents.
USER_AGENT: Final = "agent-engine-sandbox/1 (mcp-proxy)"
# The engine session a request comes from, so the product can file what a tool makes under it.
# The control plane sends the same header from the inline runtime (src/app/product.ts).
SESSION_HEADER: Final = "X-Agent-Session"
PROXY_PATH: Final = "/mcp"
# Headers that describe one hop, plus the ones the proxy sets itself.
_REQUEST_HEADERS_DROPPED: Final = frozenset(
    {
        "authorization",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        # Set by the proxy alone: the agent cannot name another session.
        SESSION_HEADER.lower(),
    }
)
_RESPONSE_HEADERS_DROPPED: Final = frozenset(
    {
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
_BODYLESS_STATUSES: Final = frozenset({204, 304})


@dataclass(frozen=True)
class AppToken:
    token: str
    # Epoch seconds, or None when the control plane did not say.
    expires_at: float | None = None


class AppTokenError(Exception):
    """The control plane did not issue a fresh product token."""


class AppTokenClient:
    """Fetches a fresh product MCP token from the control plane (``POST .../app-token``)."""

    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        http_client: httpx.AsyncClient | None = None,
        timeout_seconds: float = TOKEN_TIMEOUT_SECONDS,
    ) -> None:
        session = quote(session_id, safe="")
        self._url = f"{control_plane_url.rstrip('/')}/sessions/{session}/app-token"
        self._auth_token = auth_token
        self._http_client = http_client
        self._timeout_seconds = timeout_seconds

    async def fetch(self) -> AppToken:
        headers = {
            "Authorization": f"Bearer {self._auth_token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        try:
            if self._http_client is not None:
                response = await self._http_client.post(
                    self._url, content=b"{}", headers=headers, timeout=self._timeout_seconds
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                    response = await client.post(self._url, content=b"{}", headers=headers)
        except httpx.HTTPError as error:
            raise AppTokenError(f"request failed: {type(error).__name__}") from error
        if response.status_code != 200:
            raise AppTokenError(f"control plane answered {response.status_code}")
        try:
            body = response.json()
            token = body.get("access_token")
            expires_at_ms = body.get("expires_at")
        except (ValueError, AttributeError) as error:
            raise AppTokenError("control plane answered with malformed JSON") from error
        if not isinstance(token, str) or not token:
            raise AppTokenError("control plane returned no access_token")
        usable_expiry = (
            isinstance(expires_at_ms, (int, float))
            and not isinstance(expires_at_ms, bool)
            and math.isfinite(expires_at_ms)
        )
        return AppToken(token=token, expires_at=expires_at_ms / 1000 if usable_expiry else None)


class SpendClient:
    """Reads the session's spend from the control plane (``GET /sessions/<id>/spend``)."""

    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        http_client: httpx.AsyncClient | None = None,
        timeout_seconds: float = SPEND_TIMEOUT_SECONDS,
    ) -> None:
        self._url = spend_url(control_plane_url, session_id)
        self._auth_token = auth_token
        self._http_client = http_client
        self._timeout_seconds = timeout_seconds

    async def fetch(self) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._auth_token}", "User-Agent": USER_AGENT}
        if self._http_client is not None:
            response = await self._http_client.get(
                self._url, headers=headers, timeout=self._timeout_seconds
            )
        else:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.get(self._url, headers=headers)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("control plane answered with a spend that is not an object")
        return body


def app_mcp_proxy(
    mcp_servers: Sequence[Mapping[str, Any]],
    *,
    control_plane_url: str,
    session_id: str,
    auth_token: str,
    log: StructuredLogger,
) -> tuple[str, McpProxy] | None:
    """The product's MCP server's name and a proxy for it, or ``None`` when it cannot renew its token."""
    server = next(
        (
            entry
            for entry in mcp_servers
            if entry.get("id") == APP_MCP_SERVER_ID and entry.get("enabled") is not False
        ),
        None,
    )
    if server is None or server.get("type") != "remote" or not server.get("name"):
        return None
    url = server.get("url")
    headers = server.get("headers") or {}
    authorization = next(
        (str(value) for key, value in headers.items() if str(key).lower() == "authorization"), ""
    )
    token = authorization.removeprefix("Bearer ").strip()
    if not url or not token or not control_plane_url or not session_id or not auth_token:
        return None
    identity = {
        "control_plane_url": control_plane_url,
        "session_id": session_id,
        "auth_token": auth_token,
    }
    return str(server["name"]), McpProxy(
        upstream_url=str(url),
        token=token,
        refresh=AppTokenClient(**identity).fetch,
        log=log,
        budget=SpendClient(**identity).fetch,
        session_id=session_id,
    )


class _BadRequest(Exception):
    pass


class McpProxy:
    """Serves ``http://127.0.0.1:<port>/mcp`` and forwards it upstream with a fresh token."""

    def __init__(
        self,
        *,
        upstream_url: str,
        token: str,
        refresh: Callable[[], Awaitable[AppToken]],
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.time,
        refresh_after_seconds: float = TOKEN_REFRESH_AFTER_SECONDS,
        budget: Callable[[], Awaitable[Mapping[str, Any]]] | None = None,
        session_id: str | None = None,
    ) -> None:
        self._upstream_url = upstream_url
        self._session_id = session_id
        # The session's spend, read before each tool call; None checks nothing.
        self._budget = budget
        self._token = token
        self._refresh_source = refresh
        self._log = log
        self._clock = clock
        self._refresh_after_seconds = refresh_after_seconds
        self._refresh_at = clock() + refresh_after_seconds
        self._refresh_lock = asyncio.Lock()
        self._owns_client = http_client is None
        self._client = http_client
        self._server: asyncio.Server | None = None
        self._url: str | None = None
        self._connections: set[asyncio.Task[Any]] = set()

    @property
    def url(self) -> str | None:
        return self._url

    async def start(self) -> str:
        if self._url is not None:
            return self._url
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(UPSTREAM_CONNECT_TIMEOUT_SECONDS, read=None)
            )
        self._server = await asyncio.start_server(self._accept, host="127.0.0.1", port=0)
        port = self._server.sockets[0].getsockname()[1]
        self._url = f"http://127.0.0.1:{port}{PROXY_PATH}"
        self._log.info("mcp_proxy.started", port=port)
        return self._url

    async def aclose(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
        for task in list(self._connections):
            task.cancel()
        if self._connections:
            await asyncio.gather(*self._connections, return_exceptions=True)
        if server is not None:
            with contextlib.suppress(Exception):
                await server.wait_closed()
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None
        self._url = None

    # --- budget ----------------------------------------------------------------

    async def _refuse_over_budget(
        self, method: str, body: bytes, writer: asyncio.StreamWriter
    ) -> bool:
        """Answers a tool call once the session's cap is used up; True when it did."""
        if self._budget is None or method != "POST":
            return False
        try:
            message = json.loads(body)
        except ValueError:
            return False
        if not isinstance(message, dict) or message.get("method") != "tools/call":
            return False
        params = message.get("params")
        tool = params.get("name") if isinstance(params, dict) else None
        try:
            refusal = budget_refusal(await self._budget())
        except Exception as error:
            # The control plane still stops a session over its budget.
            self._log.warn("mcp_proxy.budget_unavailable", tool=tool, exc=error)
            return False
        if refusal is None:
            return False
        self._log.info("mcp_proxy.over_budget", tool=tool)
        payload = {"jsonrpc": "2.0", "id": message.get("id"), "result": refusal_result(refusal)}
        await _write_json(writer, json.dumps(payload, ensure_ascii=False).encode())
        return True

    # --- tokens ----------------------------------------------------------------

    async def _current_token(self) -> str:
        if self._clock() >= self._refresh_at:
            await self._refresh(self._token, reason="age")
        return self._token

    async def _refresh(self, stale_token: str, *, reason: str) -> bool:
        """Replace ``stale_token``; True when a newer token is in place afterwards."""
        async with self._refresh_lock:
            if self._token != stale_token:
                # Another request renewed it while this one waited.
                return True
            try:
                fresh = await self._refresh_source()
            except Exception as error:
                self._log.warn("mcp_proxy.refresh_failed", reason=reason, exc=error)
                return False
            self._token = fresh.token
            now = self._clock()
            self._refresh_at = (
                fresh.expires_at - TOKEN_REFRESH_MARGIN_SECONDS
                if fresh.expires_at is not None
                else now + self._refresh_after_seconds
            )
            self._log.info("mcp_proxy.token_refreshed", reason=reason)
            return True

    # --- HTTP ------------------------------------------------------------------

    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._connections.add(task)
        try:
            await self._serve(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as error:
            self._log.warn("mcp_proxy.request_error", exc=error)
        finally:
            if task is not None:
                self._connections.discard(task)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            method, headers, body = await _read_request(reader)
        except _BadRequest:
            await _write_simple(writer, 400, b"bad request")
            return
        if method is None:
            return
        if await self._refuse_over_budget(method, body, writer):
            return
        token = await self._current_token()
        response = await self._send(method, headers, body, token)
        if response is None:
            await _write_simple(writer, 502, b"The MCP server is unreachable")
            return
        if response.status_code == 401 and await self._refresh(token, reason="unauthorized"):
            # Replayed once with the renewed token; a second 401 reaches Claude Code as is.
            await response.aclose()
            response = await self._send(method, headers, body, self._token)
            if response is None:
                await _write_simple(writer, 502, b"The MCP server is unreachable")
                return
        try:
            await _relay(writer, method, response)
        finally:
            await response.aclose()

    async def _send(
        self, method: str, headers: list[tuple[str, str]], body: bytes, token: str
    ) -> httpx.Response | None:
        assert self._client is not None
        forwarded = [(k, v) for k, v in headers if k.lower() not in _REQUEST_HEADERS_DROPPED]
        forwarded.append(("Authorization", f"Bearer {token}"))
        if self._session_id:
            forwarded.append((SESSION_HEADER, self._session_id))
        request = self._client.build_request(
            method, self._upstream_url, headers=forwarded, content=body
        )
        try:
            return await self._client.send(request, stream=True)
        except httpx.HTTPError as error:
            self._log.warn("mcp_proxy.upstream_error", exc_type=type(error).__name__)
            return None


async def _read_request(
    reader: asyncio.StreamReader,
) -> tuple[str | None, list[tuple[str, str]], bytes]:
    request_line = await reader.readline()
    if not request_line.strip():
        return None, [], b""
    parts = request_line.decode("latin-1").split()
    if len(parts) != 3:
        raise _BadRequest
    method = parts[0].upper()
    headers: list[tuple[str, str]] = []
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, sep, value = line.decode("latin-1").partition(":")
        if not sep:
            raise _BadRequest
        headers.append((name.strip(), value.strip()))
    lowered = {name.lower(): value for name, value in headers}
    if "chunked" in lowered.get("transfer-encoding", "").lower():
        body = await _read_chunked(reader)
    elif "content-length" in lowered:
        try:
            length = int(lowered["content-length"])
        except ValueError as error:
            raise _BadRequest from error
        body = await reader.readexactly(length) if length > 0 else b""
    else:
        body = b""
    return method, headers, body


async def _read_chunked(reader: asyncio.StreamReader) -> bytes:
    chunks: list[bytes] = []
    while True:
        size_line = await reader.readline()
        try:
            size = int(size_line.split(b";", 1)[0].strip() or b"x", 16)
        except ValueError as error:
            raise _BadRequest from error
        if size == 0:
            # Trailers, if any, end with a blank line.
            while (await reader.readline()) not in (b"\r\n", b"\n", b""):
                pass
            return b"".join(chunks)
        chunks.append(await reader.readexactly(size))
        await reader.readline()


async def _relay(writer: asyncio.StreamWriter, method: str, response: httpx.Response) -> None:
    has_body = method != "HEAD" and response.status_code not in _BODYLESS_STATUSES
    lines = [f"HTTP/1.1 {response.status_code} {response.reason_phrase}".encode("latin-1")]
    for name, value in response.headers.multi_items():
        if name.lower() not in _RESPONSE_HEADERS_DROPPED:
            lines.append(f"{name}: {value}".encode("latin-1"))
    if has_body:
        lines.append(b"Transfer-Encoding: chunked")
    lines.append(b"Connection: close")
    writer.write(b"\r\n".join(lines) + b"\r\n\r\n")
    await writer.drain()
    if not has_body:
        return
    # Raw bytes keep Content-Encoding intact, and each chunk goes out as it arrives so
    # server-sent events are not held back.
    async for chunk in response.aiter_raw():
        if chunk:
            writer.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            await writer.drain()
    writer.write(b"0\r\n\r\n")
    await writer.drain()


async def _write_json(writer: asyncio.StreamWriter, body: bytes) -> None:
    writer.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("latin-1")
        + body
    )
    await writer.drain()


async def _write_simple(writer: asyncio.StreamWriter, status: int, body: bytes) -> None:
    reason = {
        202: "Accepted",
        400: "Bad Request",
        405: "Method Not Allowed",
        502: "Bad Gateway",
    }.get(status, "Error")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("latin-1")
        + body
    )
    await writer.drain()
