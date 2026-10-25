"""Claude Code user settings the runtime writes for a session: the hooks it runs.

At session start ``mem context`` injects what the platform remembers about the user and
``library sync`` indexes their file library; before each message ``mem recall`` adds what memory
knows about it and ``language-hook prompt`` restates the language rule in the user's language,
and after each tool call a shorter reminder in that language follows the result. Claude's own
auto memory is switched off so there is one memory.

Memory and the library live in the control plane, so their hooks are written only when the
sandbox can reach it (``CONTROL_PLANE_URL`` and ``SANDBOX_AUTH_TOKEN``).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

# Prints the user's memory block at session start, which becomes context for the session.
# It gives up on the control plane well inside this (memory.CONTEXT_BUDGET_SECONDS).
MEMORY_CONTEXT_COMMAND = "mem context"
MEMORY_CONTEXT_TIMEOUT_SECONDS = 15
# Adds remembered entries a message is about to that message (memory.RECALL_BUDGET_SECONDS).
MEMORY_RECALL_COMMAND = "mem recall"
MEMORY_RECALL_TIMEOUT_SECONDS = 5
# Printed next to each user message by ``language-hook prompt`` (language.py), which names the
# user's language and saves a shorter reminder in that language for the PostToolUse hook to print
# after every tool call. Deep in a turn, right after English thinking, skill text or tool output,
# the agent otherwise drifts into English for the progress lines it writes.
LANGUAGE_PROMPT_COMMAND = "language-hook prompt"
LANGUAGE_PROMPT_TIMEOUT_SECONDS = 5
LANGUAGE_TOOL_COMMAND = (
    'cat "${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/language-reminder.json" '
    "2>/dev/null || true"
)
LANGUAGE_TOOL_TIMEOUT_SECONDS = 5
# Indexes the user's file library at session start; what it prints (where the library is and
# how to use it) becomes context for the session.
LIBRARY_SYNC_COMMAND = "library sync"
LIBRARY_SYNC_TIMEOUT_SECONDS = 300
SETTINGS_FILE_NAME = "settings.json"


def _command_hook(command: str, timeout_seconds: int) -> dict[str, Any]:
    return {"hooks": [{"type": "command", "command": command, "timeout": timeout_seconds}]}


def has_control_plane(environ: Mapping[str, str]) -> bool:
    """Whether the sandbox can call the control plane's session routes."""
    return bool(environ.get("CONTROL_PLANE_URL") and environ.get("SANDBOX_AUTH_TOKEN"))


def session_user_settings(environ: Mapping[str, str]) -> dict[str, Any]:
    """The Claude Code user settings for this session's hooks."""
    language_prompt = _command_hook(LANGUAGE_PROMPT_COMMAND, LANGUAGE_PROMPT_TIMEOUT_SECONDS)
    language_tool = {
        "matcher": "*",
        **_command_hook(LANGUAGE_TOOL_COMMAND, LANGUAGE_TOOL_TIMEOUT_SECONDS),
    }
    if not has_control_plane(environ):
        return {"hooks": {"UserPromptSubmit": [language_prompt], "PostToolUse": [language_tool]}}
    return {
        "autoMemoryEnabled": False,
        "hooks": {
            "SessionStart": [
                _command_hook(MEMORY_CONTEXT_COMMAND, MEMORY_CONTEXT_TIMEOUT_SECONDS),
                _command_hook(LIBRARY_SYNC_COMMAND, LIBRARY_SYNC_TIMEOUT_SECONDS),
            ],
            "UserPromptSubmit": [
                _command_hook(MEMORY_RECALL_COMMAND, MEMORY_RECALL_TIMEOUT_SECONDS),
                language_prompt,
            ],
            "PostToolUse": [language_tool],
        },
    }


def write_session_user_settings(config_dir: Path, environ: Mapping[str, str], log: Any) -> None:
    """Merge the session's settings into ``<config_dir>/settings.json``."""
    settings = session_user_settings(environ)
    path = config_dir / SETTINGS_FILE_NAME
    existing: dict[str, Any] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text())
            existing = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError) as error:
            log.warn("claude.settings_unreadable", path=str(path), exc=error)
    hooks = {**(existing.get("hooks") or {}), **settings["hooks"]}
    merged = {**existing, **settings, "hooks": hooks}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(merged, indent=2))
    log.info("claude.settings_written", path=str(path))
