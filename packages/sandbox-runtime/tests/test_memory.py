"""mem against a stand-in control plane on loopback."""

from __future__ import annotations

import io
import json
import os
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlsplit

import pytest

from sandbox_runtime import memory as memory_module
from sandbox_runtime.library import InputsResult, inputs_note
from sandbox_runtime.memory import (
    CONTEXT_UNAVAILABLE,
    USER_AGENT,
    is_substantive,
    op_problem,
    validate_content,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

TOKEN = "sandbox-token"
SESSION = "session-1"
BASE = f"/sessions/{SESSION}/memory"
MODULE_FILE = Path(memory_module.__file__)
BLOCK = "<creator-memory>\n## Preferences\n- pref.voice: 优先男声 (locked)\n</creator-memory>"


@dataclass
class Seen:
    method: str
    route: str
    query: dict[str, str]
    body: Any
    headers: dict[str, str]


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # a client that gave up on a slow answer closes the socket first


class FakeControlPlane:
    """The sandbox memory routes, recording every request."""

    def __init__(self) -> None:
        self.seen: list[Seen] = []
        self.context: dict[str, Any] = {
            "text": BLOCK,
            "entryIds": ["e1", "e2"],
            "counts": {
                "profile": 0,
                "recent": False,
                "preferences": 1,
                "lessons": 0,
                "projects": 0,
                "pending": 0,
            },
            "paused": False,
        }
        self.results: list[dict[str, Any]] = []
        self.listing: dict[str, Any] = {"entries": [], "paused": False}
        self.outcomes: dict[str, dict[str, Any]] = {}
        # Statuses to answer the next requests with, before answering normally.
        self.failures: list[int] = []
        self.raw_reply: bytes | None = None
        self.delay_seconds = 0.0
        self.server = QuietServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        # A short poll interval, so shutting the server down after each test is quick.
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()

    def routes(self, method: str | None = None) -> list[str]:
        return [seen.route for seen in self.seen if method in (None, seen.method)]

    def op_result(self, op: dict[str, Any]) -> dict[str, Any]:
        key = op["key"]
        if key in self.outcomes:
            return {"key": key, **self.outcomes[key]}
        if op["op"] == "forget":
            return {"key": key, "outcome": "applied"}
        pending = op.get("inference") or key.startswith("profile.")
        entry = {
            "id": f"new-{key}",
            "key": key,
            "content": op["content"],
            "status": "pending" if pending else "active",
        }
        return {"key": key, "outcome": "applied", "entry": entry}

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        plane = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def _reply(self, status: int, value: Any) -> None:
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _record(self) -> Seen:
                url = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                seen = Seen(
                    method=self.command,
                    route=url.path.removeprefix(BASE),
                    query={name: values[0] for name, values in parse_qs(url.query).items()},
                    body=json.loads(raw) if raw else None,
                    headers=dict(self.headers.items()),
                )
                plane.seen.append(seen)
                return seen

            def _handle(self) -> None:
                seen = self._record()
                if plane.delay_seconds:
                    time.sleep(plane.delay_seconds)
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self._reply(401, {"error": "Unauthorized"})
                    return
                if plane.failures:
                    self._reply(plane.failures.pop(0), {"error": "Something broke"})
                    return
                if plane.raw_reply is not None:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(plane.raw_reply)))
                    self.end_headers()
                    self.wfile.write(plane.raw_reply)
                    return
                route = (seen.method, seen.route)
                if route == ("GET", "/context"):
                    self._reply(200, plane.context)
                elif route == ("GET", "/search"):
                    self._reply(200, {"results": plane.results})
                elif route == ("GET", ""):
                    self._reply(200, plane.listing)
                elif route == ("POST", "/ops"):
                    results = [plane.op_result(op) for op in seen.body["ops"]]
                    self._reply(200, {"batchId": "batch-1", "results": results})
                else:
                    self._reply(404, {"error": "Not found"})

            do_GET = _handle
            do_POST = _handle

        return Handler


@pytest.fixture
def plane(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[FakeControlPlane]:
    fake = FakeControlPlane()
    monkeypatch.setenv("CONTROL_PLANE_URL", fake.url)
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"sessionId": SESSION}))
    monkeypatch.setenv("WORKSPACE_DIR", str(tmp_path))
    yield fake
    fake.server.shutdown()


@pytest.fixture
def memory(tmp_path: Path) -> Path:
    return tmp_path / ".memory"


def mem(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
    prompt: str | None = None,
) -> tuple[int, str, str]:
    if prompt is not None:
        hook_input = {"hook_event_name": "UserPromptSubmit", "session_id": "c1", "prompt": prompt}
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(hook_input)))
    code = memory_module.main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def ids(memory: Path) -> list[str]:
    return (memory / ".injected").read_text().split()


# --- context (SessionStart) ------------------------------------------------------


def test_context_prints_the_block_and_keeps_a_read_only_copy(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    code, out, _ = mem(capsys, monkeypatch, "context")
    assert code == 0
    assert out == BLOCK + "\n"
    copy = memory / "context.md"
    assert copy.read_text() == BLOCK + "\n"
    assert stat.S_IMODE(copy.stat().st_mode) == 0o444
    assert ids(memory) == ["e1", "e2"]
    [seen] = plane.seen
    assert (seen.method, seen.route) == ("GET", "/context")
    # Cloudflare in front of the control plane rejects urllib's default agent (error 1010).
    assert seen.headers["User-Agent"] == USER_AGENT
    assert seen.headers["Authorization"] == f"Bearer {TOKEN}"


def test_context_runs_again_over_its_own_copy(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    # SessionStart fires again on resume and after compaction: the fresh block replaces the
    # read-only copy and the injected ids start over.
    mem(capsys, monkeypatch, "context")
    (memory / ".injected").write_text("e1\ne2\nrecalled-9\n")
    plane.context = {**plane.context, "text": "<creator-memory>v2</creator-memory>"}
    plane.context["entryIds"] = ["e3"]
    code, out, _ = mem(capsys, monkeypatch, "context")
    assert code == 0 and out == "<creator-memory>v2</creator-memory>\n"
    assert (memory / "context.md").read_text() == "<creator-memory>v2</creator-memory>\n"
    assert ids(memory) == ["e3"]


@pytest.mark.parametrize(
    "break_it",
    [
        pytest.param(lambda plane, mp: plane.failures.extend([500, 503]), id="server-error"),
        pytest.param(lambda plane, mp: plane.failures.append(404), id="not-found"),
        pytest.param(lambda plane, mp: mp.setenv("SANDBOX_AUTH_TOKEN", "wrong"), id="refused"),
        pytest.param(lambda plane, mp: setattr(plane, "raw_reply", b"<html>"), id="garbage"),
        pytest.param(lambda plane, mp: setattr(plane, "context", {"entryIds": []}), id="no-text"),
        pytest.param(
            lambda plane, mp: mp.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9"),
            id="unreachable",
        ),
        pytest.param(lambda plane, mp: mp.delenv("SESSION_CONFIG"), id="no-session"),
    ],
)
def test_context_failure_is_one_line_and_never_fails_the_session(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch, break_it
) -> None:
    break_it(plane, monkeypatch)
    code, out, err = mem(capsys, monkeypatch, "context")
    assert code == 0
    assert out == CONTEXT_UNAVAILABLE + "\n"
    assert "\n" not in CONTEXT_UNAVAILABLE and "not" in CONTEXT_UNAVAILABLE
    assert err.startswith("mem context: ")
    assert not (memory / "context.md").exists()


def test_context_tries_once_more_after_a_dropped_connection(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    plane.failures.append(503)
    code, out, _ = mem(capsys, monkeypatch, "context")
    assert code == 0 and out == BLOCK + "\n"
    assert plane.routes() == ["/context", "/context"]


def test_context_gives_up_within_its_budget(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    monkeypatch.setattr(memory_module, "CONTEXT_BUDGET_SECONDS", 0.3)
    plane.delay_seconds = 2.0
    started = time.monotonic()
    code, out, _ = mem(capsys, monkeypatch, "context")
    assert time.monotonic() - started < 1.5
    assert code == 0 and out == CONTEXT_UNAVAILABLE + "\n"


def test_paused_memory_keeps_recall_quiet_for_the_session(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    plane.context = {**plane.context, "text": "Memory is paused.", "entryIds": [], "paused": True}
    mem(capsys, monkeypatch, "context")
    assert (memory / ".paused").exists()
    plane.results = [{"id": "x", "key": "pref.voice", "layer": "preference", "content": "男声"}]
    code, out, _ = mem(capsys, monkeypatch, "recall", prompt="redo the voice-over please")
    assert code == 0 and out == ""
    assert plane.routes() == ["/context"]

    plane.context = {**plane.context, "paused": False}
    mem(capsys, monkeypatch, "context")
    assert not (memory / ".paused").exists()


# --- recall (UserPromptSubmit) -----------------------------------------------------


@pytest.mark.parametrize(
    "prompt",
    [
        "继续",
        "ok",
        "好的",
        "thanks",
        "Thank you!",
        "好的，谢谢！",  # noqa: RUF001
        "ok, go ahead",
        "Yes please, continue.",
        "可以的，继续吧",  # noqa: RUF001
        "👍👍👍👍👍👍",
        "继续\n\n"
        + inputs_note(InputsResult(arrived=[(Path("/workspace/inputs/a.mov"), 2048)], failed=[])),
        "继续\n\n[用户关闭了卡片「推广片 · 第 3 版」]\n[用户关闭了卡片（产物 art-1）]",  # noqa: RUF001
        "",
    ],
)
def test_recall_skips_messages_that_say_nothing_new(
    plane: FakeControlPlane, capsys, monkeypatch, prompt: str
) -> None:
    assert not is_substantive(prompt)
    code, out, err = mem(capsys, monkeypatch, "recall", prompt=prompt)
    assert (code, out, err) == (0, "", "")
    assert plane.seen == []


@pytest.mark.parametrize(
    "prompt",
    [
        "make the hook shorter",
        "片头再短一点，换成男声",  # noqa: RUF001
        "ok, now the coffee ad in 16:9",
        "继续做咖啡那条",
    ],
)
def test_substantive_messages_are_recalled_for(prompt: str) -> None:
    assert is_substantive(prompt)


def test_recall_searches_by_what_the_user_wrote_not_the_closed_card_notes() -> None:
    prompt = "片头再短一点\n\n[用户关闭了卡片「推广片 · 第 3 版」]\n[用户关闭了卡片（事件 evt-1）]"  # noqa: RUF001
    assert memory_module.search_query(prompt) == "片头再短一点"


def test_recall_prints_entries_the_session_has_not_seen_and_remembers_them(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    memory.mkdir()
    (memory / ".injected").write_text("e1\ne2\n")
    plane.results = [
        {"id": "e2", "key": "pref.voice", "layer": "preference", "content": "男声", "updatedAt": 1},
        {
            "id": "e3",
            "key": "project.2026-10-02.coffee",
            "layer": "project",
            "content": "15 s coffee ad\nloved the hook",
            "updatedAt": 2,
        },
        {
            "id": "e4",
            "key": "lesson.closeups",
            "layer": "lesson",
            "content": "softbox",
            "updatedAt": 3,
        },
    ]
    code, out, err = mem(capsys, monkeypatch, "recall", prompt="Let's redo the coffee video")
    assert (code, err) == (0, "")
    assert out == (
        "<user-memory-recall>\n"
        "- project.2026-10-02.coffee: 15 s coffee ad loved the hook\n"
        "- lesson.closeups: softbox\n"
        "</user-memory-recall>\n"
    )
    [seen] = plane.seen
    assert seen.route == "/search"
    assert seen.query == {"q": "Let's redo the coffee video", "limit": "5", "exclude": "e1,e2"}
    assert seen.headers["User-Agent"] == USER_AGENT
    assert ids(memory) == ["e1", "e2", "e3", "e4"]


def test_recall_asks_with_the_message_alone_and_at_most_300_characters(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    note = inputs_note(InputsResult(arrived=[(Path("/workspace/inputs/a.mov"), 2048)], failed=[]))
    words = " ".join(["coffee"] * 100)
    mem(capsys, monkeypatch, "recall", prompt=f"{words}\n\n{note}")
    [seen] = plane.seen
    assert seen.query["q"] == words[:300]
    assert "exclude" not in seen.query


@pytest.mark.parametrize(
    "break_it",
    [
        pytest.param(lambda plane, mp: plane.failures.append(500), id="server-error"),
        pytest.param(lambda plane, mp: setattr(plane, "raw_reply", b"not json"), id="garbage"),
        pytest.param(lambda plane, mp: setattr(plane, "results", None), id="no-results-list"),
        pytest.param(
            lambda plane, mp: mp.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9"),
            id="unreachable",
        ),
        pytest.param(lambda plane, mp: mp.delenv("SANDBOX_AUTH_TOKEN"), id="no-token"),
    ],
)
def test_recall_failures_are_silent(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch, break_it
) -> None:
    memory.mkdir()
    (memory / ".injected").write_text("e1\n")
    break_it(plane, monkeypatch)
    code, out, err = mem(capsys, monkeypatch, "recall", prompt="make the coffee ad shorter")
    assert (code, out, err) == (0, "", "")
    assert ids(memory) == ["e1"]


def test_recall_gives_up_within_its_budget(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    monkeypatch.setattr(memory_module, "RECALL_BUDGET_SECONDS", 0.2)
    plane.delay_seconds = 1.0
    started = time.monotonic()
    code, out, err = mem(capsys, monkeypatch, "recall", prompt="make the coffee ad shorter")
    assert time.monotonic() - started < 0.9
    assert (code, out, err) == (0, "", "")


def test_recall_ignores_input_that_is_not_a_hook_payload(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("make the coffee ad shorter"))
    assert mem(capsys, monkeypatch, "recall") == (0, "", "")
    assert plane.seen == []


def test_recall_with_nothing_found_prints_nothing(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    assert mem(capsys, monkeypatch, "recall", prompt="a brand new idea") == (0, "", "")
    assert not (memory / ".injected").exists()


# --- set, append, forget -----------------------------------------------------------


def test_set_said_is_one_op_and_reports_it(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch
) -> None:
    said = "配音用男声，语速偏快"  # noqa: RUF001
    code, out, _ = mem(capsys, monkeypatch, "set", "pref.voice", said, "--said")
    assert code == 0
    assert out == "applied pref.voice\n"
    [seen] = plane.seen
    assert (seen.method, seen.route) == ("POST", "/ops")
    assert seen.body == {"ops": [{"op": "set", "key": "pref.voice", "content": said, "said": True}]}
    assert seen.headers["User-Agent"] == USER_AGENT
    # The agent wrote it, so recall need not bring it back this session.
    assert ids(memory) == ["new-pref.voice"]


def test_set_inference_with_a_lifetime_waits_for_the_user(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    code, out, _ = mem(
        capsys, monkeypatch, "set", "pref.grade", "Prefers", "warm", "grades", "--inference",
        "--ttl-days", "30",
    )  # fmt: skip
    assert code == 0
    assert out == "applied pref.grade (pending until the user approves it)\n"
    assert plane.seen[0].body["ops"] == [
        {
            "op": "set",
            "key": "pref.grade",
            "content": "Prefers warm grades",
            "inference": True,
            "ttlDays": 30,
        }
    ]


def test_append_and_forget_send_their_own_ops(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    key = "project.2026-10-02.coffee"
    assert mem(capsys, monkeypatch, "append", key, "creator: 结尾太长", "--said") == (
        0,
        f"applied {key}\n",
        "",
    )
    assert mem(capsys, monkeypatch, "forget", "pref.music", "--reason", "changed mind") == (
        0,
        "applied pref.music (forgotten)\n",
        "",
    )
    assert mem(capsys, monkeypatch, "forget", "lesson.old") == (
        0,
        "applied lesson.old (forgotten)\n",
        "",
    )
    assert [seen.body["ops"][0] for seen in plane.seen] == [
        {"op": "append", "key": key, "content": "creator: 结尾太长", "said": True},
        {"op": "forget", "key": "pref.music", "reason": "changed mind"},
        {"op": "forget", "key": "lesson.old"},
    ]


@pytest.mark.parametrize(
    ("result", "line"),
    [
        (
            {"outcome": "locked"},
            "locked pref.voice: the user locked this; ask them or leave it",
        ),
        (
            {"outcome": "full", "detail": "40 preferences already"},
            "full pref.voice: 40 preferences already; consolidate: merge or forget older entries "
            "in this layer first",
        ),
        (
            {"outcome": "paused"},
            "paused pref.voice: the user paused memory; nothing is saved until they turn it "
            "back on",
        ),
        (
            {"outcome": "invalid", "detail": "looks like a secret"},
            "invalid pref.voice: looks like a secret; rewrite it and try again",
        ),
        (
            {"outcome": "missing"},
            "missing pref.voice: nothing is remembered under this key; `mem show` lists the keys",
        ),
    ],
)
def test_refusals_say_what_to_do_and_fail_the_command(
    plane: FakeControlPlane, memory: Path, capsys, monkeypatch, result, line
) -> None:
    plane.outcomes["pref.voice"] = result
    code, out, _ = mem(capsys, monkeypatch, "set", "pref.voice", "男声")
    assert code == 1
    assert out == line + "\n"
    assert not (memory / ".injected").exists()


def test_unchanged_is_not_a_refusal(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    plane.outcomes["pref.voice"] = {"outcome": "unchanged"}
    assert mem(capsys, monkeypatch, "set", "pref.voice", "男声") == (
        0,
        "unchanged pref.voice (already remembered like this)\n",
        "",
    )


@pytest.mark.parametrize(
    ("argv", "problem"),
    [
        (["set", "Pref.Voice", "男声"], "not a memory key"),
        (["set", "notes.voice", "男声"], "not a memory key"),
        (["set", "pref.a.b.c.d", "男声"], "not a memory key"),
        (["set", f"pref.{'x' * 80}", "男声"], "not a memory key"),
        (["set", "recent.summary", "making coffee ads"], "the platform writes itself"),
        (["set", "profile", "Ada"], "not a memory key"),
        (["set", "profile.Name", "Ada"], "not a memory key"),
        (["set", "profile.name", "x" * 301], "longer than 300 characters"),
        (["set", "pref.voice", "line one\nline two"], "one line only"),
        (["set", "pref.voice", "x" * 301], "longer than 300 characters"),
        (["set", "pref.voice", "😀" * 151], "longer than 300 characters"),
        (["set", "pref.voice", "api_key: sk-abcdefghijklmnopqrstu"], "looks like a secret"),
        (["append", "pref.voice", "see https://s.example/a.mp4?X-Amz-Signature=1"], "signed URL"),
        (["set", "lesson.render", "Traceback (most recent call last):"], "log line"),
        (["forget", "Pref.Voice"], "not a memory key"),
    ],
)
def test_bad_writes_are_refused_before_anything_is_sent(
    plane: FakeControlPlane, capsys, monkeypatch, argv: list[str], problem: str
) -> None:
    code, out, _ = mem(capsys, monkeypatch, *argv)
    assert code == 1
    assert out.startswith(f"invalid {argv[1]}: ") and problem in out
    assert plane.seen == []


@pytest.mark.parametrize(
    ("key", "text"),
    [
        ("profile.name", "Ada"),
        ("profile.role", "runs a small coffee shop"),
        ("profile.time_zone", "Asia/Tokyo"),
    ],
)
def test_profile_fields_are_suggestions_the_user_approves(
    plane: FakeControlPlane, capsys, monkeypatch, key: str, text: str
) -> None:
    code, out, _ = mem(capsys, monkeypatch, "set", key, text)
    assert code == 0 and "pending until the user approves it" in out
    assert plane.seen[0].body["ops"][0]["key"] == key


def test_validate_content_mirrors_the_shared_check() -> None:
    # The cases of the shared memory content check's own tests.
    assert validate_content("字幕用黄色描边，不要 emoji") is None  # noqa: RUF001
    assert validate_content("Prefers a male voice for voice-overs") is None
    for text, reason in [
        ("", "empty"),
        ("x" * 301, "longer"),
        ("line one\nline two", "one line"),
        ("api_key: sk-abcdefghijklmnopqrstu", "secret"),
        ("https://store.example/o.mp4?X-Amz-Signature=abc", "signed URL"),
        ("Traceback (most recent call last):", "log"),
        ('{"status": "ok"}', "log"),
        ("2026-10-03 12:01:02", "log"),
        ("Bearer abcdefghijklmnopqrstuvwxyz0123", "secret"),
    ]:
        assert reason in (validate_content(text) or ""), text
    # JavaScript's \w is ASCII-only: CJK after "at " is not a stack frame.
    assert validate_content("at 片头 (第一秒) 放产品特写") is None


def test_a_project_entry_gets_more_room() -> None:
    assert validate_content("x" * 301, "project.2026-10-03.teaser") is None
    assert "longer than 600" in (validate_content("x" * 601, "project.2026-10-03.teaser") or "")
    assert "longer than 300" in (validate_content("x" * 301, "pref.voice") or "")
    assert (
        op_problem({"op": "set", "key": "project.2026-10-03.teaser", "content": "x" * 400}) is None
    )
    assert "longer than 300" in (
        op_problem({"op": "set", "key": "lesson.hooks", "content": "x" * 400}) or ""
    )


def test_flags_that_contradict_each_other_are_a_usage_error(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        memory_module.main(["set", "pref.voice", "男声", "--said", "--inference"])
    assert exit_info.value.code == 2
    with pytest.raises(SystemExit):
        memory_module.main(["set", "pref.voice", "男声", "--ttl-days", "0"])
    assert plane.seen == []


# --- show, search, errors --------------------------------------------------------------


LISTING = {
    "paused": False,
    "entries": [
        {"key": "pref.voice", "layer": "preference", "content": "男声", "locked": True,
         "status": "active", "forgetAfter": None},
        {"key": "pref.captions", "layer": "preference", "content": "黄色描边", "locked": False,
         "status": "pending", "forgetAfter": None},
        {"key": "project.2026-09-30.tea", "layer": "project", "content": "tea teaser",
         "locked": False, "status": "active", "forgetAfter": None},
        {"key": "project.2026-10-02.coffee", "layer": "project", "content": "coffee ad",
         "locked": False, "status": "active", "forgetAfter": None},
        {"key": "lesson.launch", "layer": "lesson", "content": "launch week: daily posts",
         "locked": False, "status": "active", "forgetAfter": 1793491200000},
        {"key": "profile.name", "layer": "profile", "content": "Ada", "locked": False,
         "status": "active", "forgetAfter": None},
        {"key": "profile.city", "layer": "profile", "content": "Osaka", "locked": False,
         "status": "pending", "forgetAfter": None},
    ],
}  # fmt: skip


def test_show_lists_the_profile_and_every_layer_with_flags(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    plane.listing = LISTING
    code, out, _ = mem(capsys, monkeypatch, "show")
    assert code == 0
    assert out.splitlines() == [
        "## About the user (2)",
        "- profile.city: Osaka (pending)",
        "- profile.name: Ada",
        "## Preferences (2)",
        "- pref.captions: 黄色描边 (pending)",
        "- pref.voice: 男声 (locked)",
        "## Lessons (1)",
        "- lesson.launch: launch week: daily posts (until 2026-11-01)",
        "## Projects (2)",
        "- project.2026-10-02.coffee: coffee ad",
        "- project.2026-09-30.tea: tea teaser",
    ]
    assert plane.routes() == [""]


def test_show_one_layer(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    plane.listing = {**LISTING, "paused": True}
    code, out, _ = mem(capsys, monkeypatch, "show", "prefs")
    assert code == 0
    assert out.splitlines() == [
        "Memory is paused: the user switched it off, so nothing is loaded or saved until they "
        "switch it back on.",
        "## Preferences (2)",
        "- pref.captions: 黄色描边 (pending)",
        "- pref.voice: 男声 (locked)",
    ]
    code, out, _ = mem(capsys, monkeypatch, "show", "recent")
    assert out.splitlines()[1:] == ["## Now (0)"]
    with pytest.raises(SystemExit):
        memory_module.main(["show", "recipes"])


def test_show_says_when_nothing_is_remembered(plane: FakeControlPlane, capsys, monkeypatch) -> None:
    code, out, _ = mem(capsys, monkeypatch, "show")
    assert code == 0
    assert out.splitlines()[-1] == "Nothing is remembered about this user yet."


def test_search_prints_matches_or_says_there_are_none(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    plane.results = [
        {"id": "e1", "key": "pref.voice", "layer": "preference", "content": "男声", "updatedAt": 1}
    ]
    assert mem(capsys, monkeypatch, "search", "配音", "男声") == (
        0,
        "- pref.voice: 男声\n",
        "",
    )
    assert plane.seen[0].query == {"q": "配音 男声", "limit": "5"}
    plane.results = []
    code, out, _ = mem(capsys, monkeypatch, "search", "drone")
    assert code == 0 and out.startswith('Nothing remembered matches "drone".')


def test_errors_name_the_problem_and_fail_the_command(
    plane: FakeControlPlane, capsys, monkeypatch
) -> None:
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "wrong")
    assert mem(capsys, monkeypatch, "show") == (1, "", "mem: Unauthorized (HTTP 401)\n")
    monkeypatch.delenv("SESSION_CONFIG")
    code, _, err = mem(capsys, monkeypatch, "set", "pref.voice", "男声")
    assert code == 1 and "not connected to a session" in err


def test_runs_as_a_file_the_way_bin_mem_runs_it(plane: FakeControlPlane, tmp_path: Path) -> None:
    wrapper = (MODULE_FILE.parent / "bin" / "mem").read_text()
    assert "PYTHONSAFEPATH=1" in wrapper and "/app/sandbox_runtime/memory.py" in wrapper
    plane.listing = LISTING
    env = {
        "PATH": os.environ["PATH"],
        "PYTHONSAFEPATH": "1",
        "CONTROL_PLANE_URL": plane.url,
        "SANDBOX_AUTH_TOKEN": TOKEN,
        "SESSION_CONFIG": json.dumps({"sessionId": SESSION}),
        "WORKSPACE_DIR": str(tmp_path),
    }
    shown = subprocess.run(
        [sys.executable, str(MODULE_FILE), "show", "project"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert shown.returncode == 0, shown.stderr
    assert "- project.2026-10-02.coffee: coffee ad" in shown.stdout
    recalled = subprocess.run(
        [sys.executable, str(MODULE_FILE), "recall"],
        input=json.dumps({"prompt": "继续"}),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert (recalled.returncode, recalled.stdout, recalled.stderr) == (0, "", "")
