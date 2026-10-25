"""The loopback MCP proxy for the product's server: token injection, renewal, relaying."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.mcp_proxy import (
    APP_MCP_SERVER_ID,
    SESSION_HEADER,
    USER_AGENT,
    AppToken,
    AppTokenClient,
    AppTokenError,
    McpProxy,
    SpendClient,
    app_mcp_proxy,
)

UPSTREAM = "https://app.example/mcp"


def _streamed(status: int, payload: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    """A response whose body arrives as a stream, as it does from a real transport."""

    async def body() -> Any:
        yield json.dumps(payload).encode()

    return httpx.Response(
        status, headers={"Content-Type": "application/json", **(headers or {})}, content=body()
    )


class Upstream:
    """A scripted MCP server behind ``httpx.MockTransport``."""

    def __init__(self, valid_tokens: set[str]) -> None:
        self.valid_tokens = valid_tokens
        self.requests: list[httpx.Request] = []
        self.bodies: list[bytes] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.bodies.append(request.content)
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in self.valid_tokens:
            return _streamed(401, {"error": "invalid_token"})
        return _streamed(
            200,
            {"jsonrpc": "2.0", "id": 1, "result": {"echo": request.content.decode()}},
            {"Mcp-Session-Id": "s-1"},
        )

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


class Refresher:
    def __init__(self, *tokens: str, expires_at: float | None = None, fail: bool = False) -> None:
        self.tokens = list(tokens)
        self.expires_at = expires_at
        self.fail = fail
        self.calls = 0

    async def __call__(self) -> AppToken:
        self.calls += 1
        await asyncio.sleep(0)
        if self.fail:
            raise AppTokenError("control plane answered 503")
        return AppToken(token=self.tokens.pop(0), expires_at=self.expires_at)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def _started(upstream: Upstream, refresher: Refresher, **kwargs: Any) -> McpProxy:
    proxy = McpProxy(
        upstream_url=UPSTREAM,
        token=kwargs.pop("token", "boot-token"),
        refresh=refresher,
        log=kwargs.pop("log", MagicMock()),
        http_client=upstream.client(),
        **kwargs,
    )
    await proxy.start()
    return proxy


async def _post(proxy: McpProxy, body: dict[str, Any], **headers: str) -> httpx.Response:
    assert proxy.url is not None
    async with httpx.AsyncClient() as client:
        return await client.post(
            proxy.url,
            content=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", **headers},
        )


@pytest.mark.asyncio
async def test_forwards_with_the_current_token_and_relays_the_response() -> None:
    upstream = Upstream({"boot-token"})
    proxy = await _started(upstream, Refresher())
    try:
        assert proxy.url is not None and proxy.url.startswith("http://127.0.0.1:")
        response = await _post(
            proxy,
            {"method": "tools/list"},
            Authorization="Bearer from-claude",
            **{"Mcp-Session-Id": "s-1"},
        )
    finally:
        await proxy.aclose()
    assert response.status_code == 200
    assert response.headers["mcp-session-id"] == "s-1"
    assert response.json()["result"]["echo"] == '{"method": "tools/list"}'
    sent = upstream.requests[0]
    assert str(sent.url) == UPSTREAM
    assert sent.headers["authorization"] == "Bearer boot-token"
    assert sent.headers["mcp-session-id"] == "s-1"
    assert SESSION_HEADER not in sent.headers


@pytest.mark.asyncio
async def test_names_the_engine_session_and_drops_one_the_agent_sends() -> None:
    upstream = Upstream({"boot-token"})
    proxy = await _started(upstream, Refresher(), session_id="sess-1")
    try:
        response = await _post(proxy, {"method": "tools/list"}, **{SESSION_HEADER: "someone-else"})
    finally:
        await proxy.aclose()
    assert response.status_code == 200
    assert upstream.requests[0].headers.get_list(SESSION_HEADER) == ["sess-1"]


@pytest.mark.asyncio
async def test_a_401_renews_the_token_and_replays_the_request_once() -> None:
    upstream = Upstream({"fresh-token"})
    refresher = Refresher("fresh-token")
    log = MagicMock()
    proxy = await _started(upstream, refresher, log=log)
    try:
        first = await _post(proxy, {"id": 1})
        second = await _post(proxy, {"id": 2})
    finally:
        await proxy.aclose()
    assert first.status_code == 200 and second.status_code == 200
    assert refresher.calls == 1
    assert [r.headers["authorization"] for r in upstream.requests] == [
        "Bearer boot-token",
        "Bearer fresh-token",
        "Bearer fresh-token",
    ]
    # The replay carries the original body.
    assert upstream.bodies[1] == upstream.bodies[0]
    assert "fresh-token" not in repr(log.mock_calls)
    assert "boot-token" not in repr(log.mock_calls)


@pytest.mark.asyncio
async def test_the_token_is_renewed_before_it_ages_out() -> None:
    upstream = Upstream({"boot-token", "fresh-token"})
    clock = Clock()
    refresher = Refresher("fresh-token")
    proxy = await _started(upstream, refresher, clock=clock, refresh_after_seconds=60)
    try:
        await _post(proxy, {"id": 1})
        clock.now += 61
        await _post(proxy, {"id": 2})
        await _post(proxy, {"id": 3})
    finally:
        await proxy.aclose()
    assert refresher.calls == 1
    assert [r.headers["authorization"] for r in upstream.requests] == [
        "Bearer boot-token",
        "Bearer fresh-token",
        "Bearer fresh-token",
    ]


@pytest.mark.asyncio
async def test_a_failed_renewal_keeps_the_old_token_and_passes_the_401_through() -> None:
    upstream = Upstream(set())
    refresher = Refresher(fail=True)
    proxy = await _started(upstream, refresher)
    try:
        response = await _post(proxy, {"id": 1})
    finally:
        await proxy.aclose()
    assert response.status_code == 401
    assert response.json() == {"error": "invalid_token"}
    assert len(upstream.requests) == 1


@pytest.mark.asyncio
async def test_concurrent_401s_renew_once() -> None:
    upstream = Upstream({"fresh-token"})
    refresher = Refresher("fresh-token", "unused")
    proxy = await _started(upstream, refresher)
    try:
        responses = await asyncio.gather(*(_post(proxy, {"id": i}) for i in range(5)))
    finally:
        await proxy.aclose()
    assert [r.status_code for r in responses] == [200] * 5
    assert refresher.calls == 1


@pytest.mark.asyncio
async def test_server_sent_events_stream_through_as_they_arrive() -> None:
    release = asyncio.Event()

    async def events() -> Any:
        yield b'event: message\ndata: {"id":1}\n\n'
        await release.wait()
        yield b'event: message\ndata: {"id":2}\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=events())

    proxy = McpProxy(
        upstream_url=UPSTREAM,
        token="boot-token",
        refresh=Refresher(),
        log=MagicMock(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await proxy.start()
    assert proxy.url is not None
    try:
        async with (
            httpx.AsyncClient() as client,
            client.stream("GET", proxy.url, headers={"Accept": "text/event-stream"}) as response,
        ):
            assert response.headers["content-type"] == "text/event-stream"
            stream = response.aiter_bytes()
            first = await asyncio.wait_for(anext(stream), timeout=5)
            assert b'"id":1' in first
            release.set()
            rest = b"".join([chunk async for chunk in stream])
            assert b'"id":2' in rest
    finally:
        await proxy.aclose()


@pytest.mark.asyncio
async def test_a_chunked_request_body_is_forwarded_whole() -> None:
    upstream = Upstream({"boot-token"})
    proxy = await _started(upstream, Refresher())
    assert proxy.url is not None

    async def body() -> Any:
        yield b'{"part":'
        yield b'"one"}'

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(proxy.url, content=body())
    finally:
        await proxy.aclose()
    assert response.status_code == 200
    assert upstream.bodies == [b'{"part":"one"}']


@pytest.mark.asyncio
async def test_an_unreachable_upstream_is_a_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    proxy = McpProxy(
        upstream_url=UPSTREAM,
        token="boot-token",
        refresh=Refresher(),
        log=MagicMock(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await proxy.start()
    try:
        response = await _post(proxy, {"id": 1})
    finally:
        await proxy.aclose()
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_a_known_expiry_schedules_the_next_renewal() -> None:
    upstream = Upstream({"boot-token", "fresh-token", "third-token"})
    clock = Clock()
    refresher = Refresher("fresh-token", "third-token", expires_at=clock.now + 600)
    proxy = await _started(upstream, refresher, clock=clock, refresh_after_seconds=60)
    try:
        clock.now += 61
        await _post(proxy, {"id": 1})
        # Renewed with ten minutes left: the next one is due five minutes before that expiry.
        clock.now += 200
        await _post(proxy, {"id": 2})
        clock.now += 300
        await _post(proxy, {"id": 3})
    finally:
        await proxy.aclose()
    assert refresher.calls == 2
    assert [r.headers["authorization"] for r in upstream.requests] == [
        "Bearer fresh-token",
        "Bearer fresh-token",
        "Bearer third-token",
    ]


@pytest.mark.asyncio
async def test_token_client_posts_with_the_sandbox_token_and_a_named_agent() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"access_token": "new", "expires_at": 1_800_000_000_000})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = AppTokenClient(
            control_plane_url="https://cp.example/",
            session_id="sess/1",
            auth_token="sandbox-secret",
            http_client=http,
        )
        fresh = await client.fetch()
    assert fresh == AppToken(token="new", expires_at=1_800_000_000.0)
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "https://cp.example/sessions/sess%2F1/app-token"
    assert request.headers["authorization"] == "Bearer sandbox-secret"
    assert request.headers["user-agent"] == USER_AGENT


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "body"),
    [(409, {"error": "reconnect"}), (200, {}), (200, {"access_token": ""}), (200, ["x"])],
)
async def test_token_client_rejects_unusable_answers(status: int, body: Any) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = AppTokenClient(
            control_plane_url="https://cp.example",
            session_id="s",
            auth_token="t",
            http_client=http,
        )
        with pytest.raises(AppTokenError):
            await client.fetch()


@pytest.mark.asyncio
async def test_a_token_without_a_usable_expiry_is_renewed_by_age() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "new", "expires_at": "soon"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = AppTokenClient(
            control_plane_url="https://cp.example", session_id="s", auth_token="t", http_client=http
        )
        assert await client.fetch() == AppToken(token="new", expires_at=None)


APP_SERVER = {
    "id": APP_MCP_SERVER_ID,
    "name": "app",
    "type": "remote",
    "url": UPSTREAM,
    "headers": {"Authorization": "Bearer t"},
}
IDENTITY = {"control_plane_url": "https://cp", "session_id": "s", "auth_token": "a"}


def test_the_proxy_wraps_the_app_server_when_the_control_plane_can_renew_it() -> None:
    found = app_mcp_proxy([APP_SERVER], log=MagicMock(), **IDENTITY)
    assert found is not None
    name, proxy = found
    assert name == "app"
    assert isinstance(proxy, McpProxy)
    assert proxy._budget is not None
    assert APP_MCP_SERVER_ID == "app"


def test_the_product_server_is_found_by_its_id_under_the_name_the_product_chose() -> None:
    # APP_MCP_NAME=acme: the agent calls mcp__acme__<tool>; the proxy is still the product's.
    found = app_mcp_proxy([{**APP_SERVER, "name": "acme"}], log=MagicMock(), **IDENTITY)
    assert found is not None
    assert found[0] == "acme"


@pytest.mark.parametrize(
    "servers",
    [
        [],
        [{**APP_SERVER, "id": "linear", "name": "linear"}],
        [{k: v for k, v in APP_SERVER.items() if k != "id"}],
        [{**APP_SERVER, "enabled": False}],
        [{**APP_SERVER, "type": "local"}],
        [{**APP_SERVER, "headers": {}}],
    ],
)
def test_no_proxy_without_an_app_server_and_its_token(servers: list) -> None:
    assert app_mcp_proxy(servers, log=MagicMock(), **IDENTITY) is None


def test_no_proxy_without_a_control_plane() -> None:
    identity = {**IDENTITY, "control_plane_url": ""}
    assert app_mcp_proxy([APP_SERVER], log=MagicMock(), **identity) is None


class Budget:
    """The spend as the proxy reads it: one answer, or the error reading it raises."""

    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls = 0

    async def __call__(self) -> Any:
        self.calls += 1
        await asyncio.sleep(0)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


SPENT = {"unlimited": False, "budgetUsd": 2.0, "usedUsd": 2.5}
INSIDE = {"unlimited": False, "budgetUsd": 2.0, "usedUsd": 1.0}


def _call(tool: str = "save_note", msg_id: int = 5) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": {"text": "hi"}},
    }


@pytest.mark.asyncio
async def test_a_tool_call_over_the_cap_never_reaches_the_product() -> None:
    upstream = Upstream({"boot-token"})
    log = MagicMock()
    proxy = await _started(upstream, Refresher(), budget=Budget(SPENT), log=log)
    try:
        response = await _post(proxy, _call())
    finally:
        await proxy.aclose()
    assert response.status_code == 200
    message = response.json()
    assert message["id"] == 5
    assert message["result"]["isError"] is True
    assert message["result"]["structuredContent"]["error"]["code"] == "over_session_budget"
    assert message["result"]["content"][0]["text"].startswith("Not submitted")
    assert upstream.requests == []
    log.info.assert_any_call("mcp_proxy.over_budget", tool="save_note")


@pytest.mark.asyncio
async def test_a_tool_call_inside_the_cap_is_forwarded() -> None:
    upstream = Upstream({"boot-token"})
    budget = Budget(INSIDE)
    proxy = await _started(upstream, Refresher(), budget=budget)
    try:
        response = await _post(proxy, _call())
        listing = await _post(proxy, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    finally:
        await proxy.aclose()
    assert "isError" not in response.json()["result"]
    assert listing.status_code == 200
    # Only the tool call reads the spend.
    assert budget.calls == 1
    assert len(upstream.requests) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        httpx.ConnectError("control plane is unreachable"),
        ValueError("not json"),
        {"unlimited": False, "budgetUsd": "2", "usedUsd": "3"},
    ],
)
async def test_a_spend_that_cannot_be_read_stops_nothing(answer: Any) -> None:
    upstream = Upstream({"boot-token"})
    budget = Budget(answer)
    log = MagicMock()
    proxy = await _started(upstream, Refresher(), budget=budget, log=log)
    try:
        response = await _post(proxy, _call())
    finally:
        await proxy.aclose()
    assert "isError" not in response.json()["result"]
    assert len(upstream.requests) == 1
    assert log.warn.call_count == (1 if isinstance(answer, Exception) else 0)


@pytest.mark.asyncio
async def test_a_body_that_is_not_a_tool_call_goes_upstream_unread() -> None:
    upstream = Upstream({"boot-token"})
    budget = Budget(SPENT)
    proxy = await _started(upstream, Refresher(), budget=budget)
    try:
        assert proxy.url is not None
        async with httpx.AsyncClient() as client:
            garbage = await client.post(proxy.url, content=b"{not json")
            batch = await client.post(proxy.url, content=b"[1, 2]")
    finally:
        await proxy.aclose()
    assert [garbage.status_code, batch.status_code] == [200, 200]
    assert budget.calls == 0
    assert len(upstream.requests) == 2


@pytest.mark.asyncio
async def test_spend_client_reads_the_session_spend_with_the_sandbox_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"unlimited": True, "budgetUsd": None})

    client = SpendClient(
        control_plane_url="https://cp.example/",
        session_id="sess 1",
        auth_token="sandbox-token",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    assert await client.fetch() == {"unlimited": True, "budgetUsd": None}
    (request,) = seen
    assert request.method == "GET"
    assert str(request.url) == "https://cp.example/sessions/sess%201/spend"
    assert request.headers["authorization"] == "Bearer sandbox-token"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "body"),
    [(404, {"error": "Session not found"}), (200, ["not", "an", "object"])],
)
async def test_spend_client_rejects_unusable_answers(status: int, body: Any) -> None:
    client = SpendClient(
        control_plane_url="https://cp.example",
        session_id="sess-1",
        auth_token="sandbox-token",
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(status, json=body))
        ),
    )
    with pytest.raises((httpx.HTTPStatusError, ValueError)):
        await client.fetch()
