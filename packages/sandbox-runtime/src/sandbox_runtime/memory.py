"""mem: what the platform remembers about this user (stdlib only).

  mem context                     session start (a hook): print the user's memory block
  mem recall                      before each prompt (a hook): print remembered entries the
                                      prompt is about; reads the hook's JSON on stdin
  mem show [LAYER]                everything remembered, or one layer: profile, preference,
                                      lesson, project or recent
  mem search WORDS...             remembered preferences, lessons and projects about WORDS
  mem set KEY TEXT... [--said | --inference] [--ttl-days N]
                                      remember TEXT under KEY (a new version when KEY exists)
  mem append KEY TEXT... [--said] add what happened next to KEY
  mem forget KEY [--reason TEXT]  stop remembering KEY (the user can undo it)

Keys are profile.<field>, pref.<topic>, lesson.<topic> and project.<yyyy-mm-dd>.<name>; text is
one line of at most 300 characters (600 for a project). Secrets, signed URLs, logs and raw output are refused here
and again by the control plane, which decides. The limits and checks mirror the control plane's
memory schemas (MEMORY_LIMITS in packages/shared).

The hooks never fail a session: when memory cannot be reached, `context` says so in one line and
`recall` prints nothing. bin/mem runs this file directly, so it imports nothing from the
package.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import http.client
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, TextIO

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping

# Cloudflare in front of the control plane rejects urllib's default "Python-urllib/3.x" agent
# (error 1010), so every request names itself.
USER_AGENT = "agent-engine-sandbox/1 (mem)"

CONTEXT_FILE = "context.md"
INJECTED_FILE = ".injected"
PAUSED_FILE = ".paused"

# Session start waits for memory, so it gets a budget for the whole fetch; a sandbox that has
# just resumed can drop its first connection, so one retry fits inside it.
CONTEXT_BUDGET_SECONDS = 5.0
CONTEXT_ATTEMPT_SECONDS = 2.3
CONTEXT_RETRY_DELAY_SECONDS = 0.3
# Recall runs before every prompt reaches the model.
RECALL_BUDGET_SECONDS = 2.0
COMMAND_TIMEOUT_SECONDS = 30.0

CONTEXT_UNAVAILABLE = (
    "User memory could not be loaded this time: do not treat it as empty "
    "(`mem show` may reach it later)."
)
RECALL_OPEN = "<user-memory-recall>"
RECALL_CLOSE = "</user-memory-recall>"

# MEMORY_LIMITS and the request schemas in packages/shared.
CONTENT_MAX_CHARS = 300
# A project entry: its reactions are appended to it, so it gets more room.
PROJECT_CONTENT_MAX_CHARS = 600
KEY_MAX_CHARS = 80
RECALL_RESULTS = 5
FORGET_REASON_MAX_CHARS = 200
TTL_DAYS_MAX = 365
# The start of a message is the recall query; shorter messages are acknowledgements.
RECALL_QUERY_CHARS = 300
RECALL_MIN_CHARS = 6
# Ids sent back as `exclude`, newest last; a long session may see its oldest ones again.
RECALL_EXCLUDE_MAX_IDS = 150

KEY_PATTERN = re.compile(r"(pref|lesson|project|recent|profile)(\.[a-z0-9][a-z0-9_-]*){1,3}")
LAYER_BY_PREFIX = {
    "pref": "preference",
    "lesson": "lesson",
    "project": "project",
    "recent": "recent",
    "profile": "profile",
}
LAYER_NAMES = {
    "pref": "preference",
    "prefs": "preference",
    "preference": "preference",
    "preferences": "preference",
    "lesson": "lesson",
    "lessons": "lesson",
    "project": "project",
    "projects": "project",
    "recent": "recent",
    "now": "recent",
    "profile": "profile",
}

# the content check. JavaScript's \w and \d are ASCII-only, so those classes are spelled
# out; Python's would also match CJK text and other digits.
SECRET = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|(api|secret|access)[_-]?key\s*[:=]|password\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,})",
    re.IGNORECASE,
)
SIGNED_URL = re.compile(
    r"[?&](X-Amz-Signature|X-Amz-Credential|Signature|sig|token)=", re.IGNORECASE
)
RAW_OUTPUT = re.compile(r"(\$ |>>> |Traceback|\s*at [A-Za-z0-9_.$]+ \(|\{\s*\"|\[\s*\{|drwx|-rw-)")
TIMESTAMP_ONLY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?\S*\s*")

# Notes the platform appends to a message: the bridge's, for a message that came with files
# (library.inputs_note), and the control plane's, one per card the user closed
# (control-plane session/card-dismissals.ts).
PLATFORM_NOTE = re.compile(
    r"^\[(?:(?:Files the user attached are ready|These attached files could not be fetched): "
    r"|用户关闭了卡片).*\]$",
    re.MULTILINE,
)
# Messages that only keep the conversation going ("ok", "继续", "好的谢谢") recall nothing.
ACKNOWLEDGEMENT = re.compile(
    r"\b(?:ok(?:ay)?|k+|y(?:es|eah|ep|up)?|sure|fine|great|good|nice|cool|perfect|thank you"
    r"|thanks?|thx|ty|please|pls|continue|go on|go ahead|carry on|keep going|proceed|next"
    r"|do it|done|lgtm|sounds good|looks good|alright|all right|got it|right|correct|agreed?"
    r"|approved?)\b"
    r"|继续|好的|好吧|好啊|好|可以|行|嗯|对|是的|是|没问题|谢谢|感谢|多谢|收到|确认|同意|开始"
    r"|下一步|不错|很好|完美|棒|吧|啊|呀|哈|了|的|呢|哦|噢|请"
    r"|はい|お願いします|続けて|ありがとう|네|좋아요|계속|감사합니다",
    re.IGNORECASE,
)
NOT_WORD = re.compile(r"[\W_]+")

# What to do about each refused op (the op outcome schema).
ADVICE = {
    "locked": "the user locked this; ask them or leave it",
    "full": "consolidate: merge or forget older entries in this layer first",
    "paused": "the user paused memory; nothing is saved until they turn it back on",
    "invalid": "rewrite it and try again",
    "missing": "nothing is remembered under this key; `mem show` lists the keys",
}
DONE_OUTCOMES = ("applied", "unchanged")
RECENT_IS_GENERATED = (
    "recent.* is the summary the platform writes itself; record a pref, lesson or project instead"
)


class MemoryAccessError(Exception):
    """Memory could not be reached, or the control plane refused the request."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


@dataclass(frozen=True)
class MemoryContext:
    """The session-start block as the control plane rendered it, and the entries it holds."""

    text: str
    entry_ids: list[str]
    paused: bool


@dataclass(frozen=True)
class Recalled:
    id: str
    key: str
    content: str


def memory_dir(environ: Mapping[str, str]) -> Path:
    return Path(environ.get("WORKSPACE_DIR") or "/workspace") / ".memory"


def session_id_from_env(environ: Mapping[str, str]) -> str:
    """The session id in SESSION_CONFIG, read as library reads it."""
    try:
        config = json.loads(environ.get("SESSION_CONFIG") or "{}")
    except json.JSONDecodeError:
        return ""
    if not isinstance(config, dict):
        return ""
    return str(config.get("sessionId") or config.get("session_id") or "")


class Client:
    """The control plane's sandbox memory routes, authenticated with the sandbox token."""

    def __init__(self, control_plane_url: str, session_id: str, token: str) -> None:
        if not control_plane_url or not session_id or not token:
            raise MemoryAccessError("this sandbox is not connected to a session")
        session = urllib.parse.quote(session_id, safe="")
        self.base = f"{control_plane_url.rstrip('/')}/sessions/{session}/memory"
        self.token = token

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Client:
        return cls(
            environ.get("CONTROL_PLANE_URL", ""),
            session_id_from_env(environ),
            environ.get("SANDBOX_AUTH_TOKEN", ""),
        )

    def request(
        self,
        method: str,
        path: str = "",
        *,
        query: Mapping[str, str] | None = None,
        body: Any = None,
        timeout_seconds: float = COMMAND_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        url = f"{self.base}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": USER_AGENT}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            message = error_message(error.read()) or str(error.reason)
            raise MemoryAccessError(
                f"{message} (HTTP {error.code})", transient=error.code >= 500 or error.code == 429
            ) from error
        except (OSError, http.client.HTTPException) as error:  # unreachable, timed out, cut off
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            raise MemoryAccessError(
                f"cannot reach the platform: {reason}", transient=True
            ) from error
        try:
            parsed = json.loads(raw or b"{}")
        except ValueError as error:
            raise MemoryAccessError("The platform sent a reply mem cannot read") from error
        if not isinstance(parsed, dict):
            raise MemoryAccessError("The platform sent a reply mem cannot read")
        return parsed


def error_message(data: bytes) -> str:
    """The control plane's `{"error": "..."}` message, or the start of a body that is not one."""
    try:
        parsed = json.loads(data)
    except ValueError:
        return data.decode("utf-8", "replace")[:200].strip()
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("message") or "")
    return ""


def within[T](seconds: float, call: Callable[[], T]) -> T:
    """``call()``, or TimeoutError after ``seconds``.

    The call runs on a daemon thread, which exiting abandons, so even a DNS lookup that socket
    timeouts do not bound cannot hold a hook past its budget.
    """
    outcome: list[T] = []
    failure: list[Exception] = []

    def run() -> None:
        try:
            outcome.append(call())
        except Exception as error:
            failure.append(error)

    worker = threading.Thread(target=run, name="mem-request", daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise TimeoutError(f"no answer within {seconds:g} s")
    if failure:
        raise failure[0]
    return outcome[0]


# ---------------------------------------------------------------------------
# Validation (the control plane checks again and decides)
# ---------------------------------------------------------------------------


def utf16_length(text: str) -> int:
    """The length JavaScript sees, so the limits match the control plane's."""
    return len(text.encode("utf-16-le")) // 2


def content_max_chars(key: str | None) -> int:
    """The most characters an entry under ``key`` may hold (``memoryContentChars``)."""
    return PROJECT_CONTENT_MAX_CHARS if key and key.startswith("project.") else CONTENT_MAX_CHARS


def validate_content(text: str, key: str | None = None) -> str | None:
    """Why ``text`` cannot be memory (under ``key``), or None when it can (``the content check``)."""
    trimmed = text.strip()
    if not trimmed:
        return "empty"
    max_chars = content_max_chars(key)
    if utf16_length(trimmed) > max_chars:
        return f"longer than {max_chars} characters; say it shorter"
    if "\r" in trimmed or "\n" in trimmed:
        return "one line only"
    if SECRET.search(trimmed):
        return "looks like a secret"
    if SIGNED_URL.search(trimmed):
        return "contains a signed URL"
    if RAW_OUTPUT.match(trimmed) or TIMESTAMP_ONLY.fullmatch(trimmed):
        return "looks like a log line or raw output"
    return None


def key_problem(key: str) -> str | None:
    """Why ``key`` is not a memory key (``the memory key schema``), or None."""
    if len(key) > KEY_MAX_CHARS or not KEY_PATTERN.fullmatch(key):
        return (
            "not a memory key: use pref.<topic>, lesson.<topic>, project.<yyyy-mm-dd>.<name> "
            "or profile.<field>, in lowercase letters, digits, - and _"
        )
    return None


def op_problem(op: Mapping[str, Any]) -> str | None:
    """Why the control plane would refuse ``op``, as far as it can be told here."""
    key = str(op["key"])
    problem = key_problem(key)
    if problem or op["op"] == "forget":
        return problem
    if key.startswith("recent."):
        return RECENT_IS_GENERATED
    return validate_content(str(op["content"]), key)


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def write_atomic(path: Path, text: str, mode: int = 0o644) -> None:
    staging = path.with_name(f".{path.name}.tmp")
    staging.unlink(missing_ok=True)
    staging.write_text(text, encoding="utf-8")
    staging.chmod(mode)
    staging.replace(path)


def read_injected(directory: Path) -> list[str]:
    """Ids of the entries this session has already seen, oldest first."""
    try:
        ids = (directory / INJECTED_FILE).read_text(encoding="utf-8").split()
    except OSError:
        return []
    return list(dict.fromkeys(ids))


def append_injected(directory: Path, ids: Iterable[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / INJECTED_FILE).open("a", encoding="utf-8") as handle:
        handle.writelines(f"{entry_id}\n" for entry_id in ids)


def parse_context(payload: Mapping[str, Any]) -> MemoryContext:
    text = payload.get("text")
    ids = payload.get("entryIds", [])
    if not isinstance(text, str) or not isinstance(ids, list):
        raise ValueError("The platform sent a memory block mem cannot read")
    return MemoryContext(
        text=text,
        entry_ids=[entry_id for entry_id in ids if isinstance(entry_id, str)],
        paused=payload.get("paused") is True,
    )


def save_context(directory: Path, context: MemoryContext) -> None:
    """Keep the block as injected, read-only since it is what the session started with."""
    directory.mkdir(parents=True, exist_ok=True)
    write_atomic(directory / CONTEXT_FILE, context.text.rstrip("\n") + "\n", mode=0o444)
    write_atomic(directory / INJECTED_FILE, "".join(f"{i}\n" for i in context.entry_ids))
    paused = directory / PAUSED_FILE
    if context.paused:
        paused.touch()
    else:
        paused.unlink(missing_ok=True)


def fetch_context(client: Client) -> dict[str, Any]:
    try:
        return client.request("GET", "/context", timeout_seconds=CONTEXT_ATTEMPT_SECONDS)
    except MemoryAccessError as error:
        if not error.transient:
            raise
    time.sleep(CONTEXT_RETRY_DELAY_SECONDS)
    return client.request("GET", "/context", timeout_seconds=CONTEXT_ATTEMPT_SECONDS)


def cmd_context(environ: Mapping[str, str]) -> int:
    """SessionStart: print the user's memory block and keep a copy. Never fails a session."""
    try:
        client = Client.from_env(environ)
        context = parse_context(within(CONTEXT_BUDGET_SECONDS, lambda: fetch_context(client)))
    except Exception as error:  # whatever went wrong, the session starts
        print(CONTEXT_UNAVAILABLE)
        print(f"mem context: {error}", file=sys.stderr)
        return 0
    if context.text.strip():
        print(context.text.rstrip("\n"))
    try:
        save_context(memory_dir(environ), context)
    except OSError as error:
        print(f"mem context: {error}", file=sys.stderr)
    return 0


def hook_prompt(stdin: TextIO) -> str:
    """The user's message in a UserPromptSubmit hook's JSON input, or "" without one."""
    if stdin.isatty():
        return ""
    try:
        payload = json.loads(stdin.read() or "{}")
    except ValueError:
        return ""
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    return prompt if isinstance(prompt, str) else ""


def is_substantive(prompt: str) -> bool:
    """Whether a message says enough to recall anything by: not "ok", "继续" or "好的谢谢"."""
    text = PLATFORM_NOTE.sub("", prompt)
    if len("".join(text.split())) < RECALL_MIN_CHARS:
        return False
    return bool(NOT_WORD.sub("", ACKNOWLEDGEMENT.sub(" ", text)))


def search_query(prompt: str) -> str:
    return " ".join(PLATFORM_NOTE.sub("", prompt).split())[:RECALL_QUERY_CHARS]


def one_line(text: str) -> str:
    return " ".join(text.split())


def parse_recalled(payload: Mapping[str, Any]) -> list[Recalled]:
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError("The platform sent search results mem cannot read")
    return [
        Recalled(id=item["id"], key=item["key"], content=one_line(item["content"]))
        for item in results
        if isinstance(item, dict)
        and all(isinstance(item.get(field), str) for field in ("id", "key", "content"))
    ]


def render_recall(items: Iterable[Recalled]) -> str:
    lines = [RECALL_OPEN, *(f"- {item.key}: {item.content}" for item in items), RECALL_CLOSE]
    return "\n".join(lines) + "\n"


def cmd_recall(environ: Mapping[str, str], stdin: TextIO) -> int:
    """UserPromptSubmit: print remembered entries this message is about; silent on any failure."""
    try:
        directory = memory_dir(environ)
        prompt = hook_prompt(stdin)
        if not is_substantive(prompt) or (directory / PAUSED_FILE).exists():
            return 0
        injected = read_injected(directory)
        query = {"q": search_query(prompt), "limit": str(RECALL_RESULTS)}
        if injected:
            query["exclude"] = ",".join(injected[-RECALL_EXCLUDE_MAX_IDS:])
        client = Client.from_env(environ)
        found = within(
            RECALL_BUDGET_SECONDS,
            lambda: client.request(
                "GET", "/search", query=query, timeout_seconds=RECALL_BUDGET_SECONDS
            ),
        )
        seen = set(injected)
        items = [item for item in parse_recalled(found) if item.id not in seen][:RECALL_RESULTS]
        if items:
            sys.stdout.write(render_recall(items))
            append_injected(directory, [item.id for item in items])
    except Exception:  # recall only adds to a message; a failure must leave it untouched
        return 0
    return 0


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def layer_of(entry: Mapping[str, Any]) -> str:
    layer = entry.get("layer")
    if isinstance(layer, str):
        return layer
    return LAYER_BY_PREFIX.get(str(entry.get("key", "")).split(".", 1)[0], "")


def entry_line(entry: Mapping[str, Any]) -> str:
    flags = []
    if entry.get("locked") is True:
        flags.append("locked")
    if entry.get("status") == "pending":
        flags.append("pending")
    forget_after = entry.get("forgetAfter")
    if isinstance(forget_after, int | float) and not isinstance(forget_after, bool):
        until = datetime.datetime.fromtimestamp(forget_after / 1000, tz=datetime.UTC)
        flags.append(f"until {until.date().isoformat()}")
    suffix = f" ({', '.join(flags)})" if flags else ""
    return f"- {entry.get('key')}: {one_line(str(entry.get('content', '')))}{suffix}"


SECTIONS = (
    ("profile", "About the user"),
    ("recent", "Now"),
    ("preference", "Preferences"),
    ("lesson", "Lessons"),
    ("project", "Projects"),
)


def render_listing(listing: Mapping[str, Any], layer: str | None = None) -> str:
    """``mem show``: the current entries, grouped by layer."""
    entries = [entry for entry in listing.get("entries") or [] if isinstance(entry, dict)]
    lines = []
    if listing.get("paused") is True:
        lines.append(
            "Memory is paused: the user switched it off, so nothing is loaded or saved until "
            "they switch it back on."
        )
    for name, title in SECTIONS:
        if layer not in (None, name):
            continue
        rows = sorted(
            (entry for entry in entries if layer_of(entry) == name),
            key=lambda entry: str(entry.get("key", "")),
            reverse=name == "project",  # project keys start with their date: newest first
        )
        if rows or layer is not None:
            lines.append(f"## {title} ({len(rows)})")
            lines.extend(entry_line(entry) for entry in rows)
    if layer is None and not entries:
        lines.append("Nothing is remembered about this user yet.")
    return "\n".join(lines)


def result_line(op: str, result: Mapping[str, Any]) -> str:
    key = str(result.get("key") or "")
    outcome = str(result.get("outcome") or "")
    if outcome == "applied":
        entry = result.get("entry")
        if op == "forget":
            return f"applied {key} (forgotten)"
        if isinstance(entry, dict) and entry.get("status") == "pending":
            return f"applied {key} (pending until the user approves it)"
        return f"applied {key}"
    if outcome == "unchanged":
        return f"unchanged {key} (already remembered like this)"
    detail = str(result.get("detail") or "")
    reasons = [part for part in (detail, ADVICE.get(outcome, "")) if part]
    return f"{outcome} {key}: {'; '.join(reasons)}" if reasons else f"{outcome} {key}"


def cmd_write(client: Client, op: dict[str, Any], directory: Path) -> int:
    """Send one set, append or forget; one line per result, exit 1 when any was refused."""
    response = client.request("POST", "/ops", body={"ops": [op]})
    results = response.get("results")
    if not isinstance(results, list) or not results:
        raise MemoryAccessError("The platform sent no result for the change")
    results = [result for result in results if isinstance(result, dict)]
    for result in results:
        print(result_line(op["op"], result))
    # What the agent just wrote is in its context already; recall need not bring it back.
    written = [
        result["entry"]["id"]
        for result in results
        if result.get("outcome") == "applied"
        and isinstance(result.get("entry"), dict)
        and isinstance(result["entry"].get("id"), str)
    ]
    if written:
        with contextlib.suppress(OSError):
            append_injected(directory, written)
    return 0 if all(result.get("outcome") in DONE_OUTCOMES for result in results) else 1


def cmd_show(client: Client, layer: str | None) -> int:
    print(render_listing(client.request("GET"), layer))
    return 0


def cmd_search(client: Client, words: str) -> int:
    query = {"q": words[:RECALL_QUERY_CHARS], "limit": str(RECALL_RESULTS)}
    items = parse_recalled(client.request("GET", "/search", query=query))
    if not items:
        print(
            f'Nothing remembered matches "{words}". Search covers confirmed preferences, lessons '
            "and projects; `mem show` lists everything."
        )
    for item in items:
        print(f"- {item.key}: {item.content}")
    return 0


def build_op(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "forget":
        op: dict[str, Any] = {"op": "forget", "key": args.key}
        if args.reason:
            op["reason"] = args.reason
        return op
    # Only stripped: a multi-line dump is refused ("one line only"), never folded into one.
    op = {"op": args.command, "key": args.key, "content": " ".join(args.text).strip()}
    if args.said:
        op["said"] = True
    if args.command == "set":
        if args.inference:
            op["inference"] = True
        if args.ttl_days is not None:
            op["ttlDays"] = args.ttl_days
    return op


def layer_argument(value: str) -> str:
    layer = LAYER_NAMES.get(value.strip().lower())
    if layer is None:
        raise argparse.ArgumentTypeError(
            f"no layer {value!r}: use preference, lesson, project, recent or profile"
        )
    return layer


def ttl_days_argument(value: str) -> int:
    days = int(value) if value.isdigit() else 0
    if not 1 <= days <= TTL_DAYS_MAX:
        raise argparse.ArgumentTypeError(f"a whole number of days from 1 to {TTL_DAYS_MAX}")
    return days


def reason_argument(value: str) -> str:
    reason = one_line(value)
    if utf16_length(reason) > FORGET_REASON_MAX_CHARS:
        raise argparse.ArgumentTypeError(f"at most {FORGET_REASON_MAX_CHARS} characters")
    return reason


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mem",
        description=(__doc__ or "").split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")
    sub.add_parser("context", help="session start: print the user's memory block")
    sub.add_parser("recall", help="before each prompt: print what memory knows about it")
    show = sub.add_parser("show", help="everything remembered, or one layer")
    show.add_argument("layer", nargs="?", type=layer_argument)
    search = sub.add_parser("search", help="remembered entries about some words")
    search.add_argument("words", nargs="+")
    set_parser = sub.add_parser("set", help="remember a fact under a key")
    set_parser.add_argument("key")
    set_parser.add_argument("text", nargs="+")
    source = set_parser.add_mutually_exclusive_group()
    source.add_argument(
        "--said", action="store_true", help="the user said it themselves: it counts at once"
    )
    source.add_argument(
        "--inference",
        action="store_true",
        help="your own conclusion: pending until the user approves it",
    )
    set_parser.add_argument(
        "--ttl-days", type=ttl_days_argument, metavar="N", help="forget it after N days"
    )
    append = sub.add_parser("append", help="add what happened next to a key")
    append.add_argument("key")
    append.add_argument("text", nargs="+")
    append.add_argument("--said", action="store_true", help="the user said it themselves")
    forget = sub.add_parser("forget", help="stop remembering a key")
    forget.add_argument("key")
    forget.add_argument("--reason", type=reason_argument)
    return parser


def run(args: argparse.Namespace, environ: Mapping[str, str]) -> int:
    if args.command == "show":
        return cmd_show(Client.from_env(environ), args.layer)
    if args.command == "search":
        return cmd_search(Client.from_env(environ), one_line(" ".join(args.words)))
    op = build_op(args)
    problem = op_problem(op)
    if problem:
        print(f"invalid {op['key']}: {problem}; {ADVICE['invalid']}")
        return 1
    return cmd_write(Client.from_env(environ), op, memory_dir(environ))


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    command = arguments[0] if arguments else ""
    # The hooks take no arguments and skip parsing: nothing may make them fail a session.
    if command == "context":
        return cmd_context(os.environ)
    if command == "recall":
        return cmd_recall(os.environ, sys.stdin)
    args = build_parser().parse_args(arguments)
    try:
        return run(args, os.environ)
    except (MemoryAccessError, OSError, ValueError) as error:
        print(f"mem: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
