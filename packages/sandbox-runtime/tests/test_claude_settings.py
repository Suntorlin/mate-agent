import json
import os
import subprocess
from unittest.mock import MagicMock

from sandbox_runtime.claude_settings import (
    LANGUAGE_PROMPT_COMMAND,
    LANGUAGE_TOOL_COMMAND,
    LIBRARY_SYNC_COMMAND,
    MEMORY_CONTEXT_COMMAND,
    MEMORY_RECALL_COMMAND,
    session_user_settings,
    write_session_user_settings,
)
from sandbox_runtime.claude_stager import ClaudeHarnessHandoff
from sandbox_runtime.harness import (
    BridgeIdentity,
    HarnessId,
    PromptLimits,
    build_agent_harness,
)
from sandbox_runtime.mcp_proxy import APP_MCP_SERVER_ID, McpProxy

CONNECTED_ENV = {"CONTROL_PLANE_URL": "https://cp.example", "SANDBOX_AUTH_TOKEN": "sandbox-token"}


def hook_commands(settings, event):
    return [
        (group["hooks"][0]["command"], group["hooks"][0]["timeout"])
        for group in settings["hooks"][event]
    ]


def test_settings_load_memory_and_the_library_and_disable_auto_memory():
    settings = session_user_settings(CONNECTED_ENV)
    assert settings["autoMemoryEnabled"] is False
    assert set(settings["hooks"]) == {"SessionStart", "UserPromptSubmit", "PostToolUse"}
    assert hook_commands(settings, "SessionStart") == [
        (MEMORY_CONTEXT_COMMAND, 15),
        (LIBRARY_SYNC_COMMAND, 300),
    ]
    assert MEMORY_CONTEXT_COMMAND == "mem context"
    assert MEMORY_RECALL_COMMAND == "mem recall"
    assert LIBRARY_SYNC_COMMAND == "library sync"


def test_without_a_control_plane_only_the_language_hooks_run():
    settings = session_user_settings({})
    assert "autoMemoryEnabled" not in settings
    assert set(settings["hooks"]) == {"UserPromptSubmit", "PostToolUse"}
    assert hook_commands(settings, "UserPromptSubmit") == [(LANGUAGE_PROMPT_COMMAND, 5)]


def test_write_merges_with_existing_settings(tmp_path):
    (tmp_path / "settings.json").write_text(
        json.dumps({"theme": "dark", "hooks": {"PreToolUse": [{"hooks": []}]}})
    )
    write_session_user_settings(tmp_path, CONNECTED_ENV, MagicMock())
    written = json.loads((tmp_path / "settings.json").read_text())
    assert written["theme"] == "dark"
    assert set(written["hooks"]) == {
        "PreToolUse",
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
    }
    assert written["autoMemoryEnabled"] is False


def test_language_rule_is_restated_beside_each_user_message():
    settings = session_user_settings(CONNECTED_ENV)
    commands = hook_commands(settings, "UserPromptSubmit")
    assert commands == [(MEMORY_RECALL_COMMAND, 5), (LANGUAGE_PROMPT_COMMAND, 5)]
    assert LANGUAGE_PROMPT_COMMAND == "language-hook prompt"


def test_language_reminder_follows_every_tool_result(tmp_path):
    settings = session_user_settings(CONNECTED_ENV)
    (group,) = settings["hooks"]["PostToolUse"]
    assert group["matcher"] == "*"
    assert hook_commands(settings, "PostToolUse") == [(LANGUAGE_TOOL_COMMAND, 5)]
    run = lambda: subprocess.run(  # noqa: E731
        LANGUAGE_TOOL_COMMAND,
        shell=True,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "CLAUDE_CONFIG_DIR": str(tmp_path)},
    )
    # Before the first message there is nothing to say, and the hook still succeeds.
    assert run().stdout == ""
    reminder = '{"hookSpecificOutput": {"hookEventName": "PostToolUse"}}\n'
    (tmp_path / "language-reminder.json").write_text(reminder)
    assert run().stdout == reminder


APP_SERVER = {
    "id": APP_MCP_SERVER_ID,
    "name": "app",
    "type": "remote",
    "url": "https://app.example/mcp",
    "headers": {"Authorization": "Bearer app-token"},
}


def _claude_harness(tmp_path, monkeypatch, session_config):
    workdir = tmp_path / "workspace"
    workdir.mkdir(exist_ok=True)
    handoff = ClaudeHarnessHandoff(
        workdir=workdir, config_dir=tmp_path / "claude", has_repository=False
    )
    monkeypatch.setattr(ClaudeHarnessHandoff, "read", classmethod(lambda cls: handoff))
    monkeypatch.setenv("SESSION_CONFIG", json.dumps(session_config))
    return build_agent_harness(
        HarnessId.CLAUDE,
        identity=BridgeIdentity(
            sandbox_id="sb",
            session_id="sess",
            control_plane_url="https://cp.example",
            auth_token="sandbox-token",
            repo_manifest_path=tmp_path / "manifest.json",
        ),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=PromptLimits(
            inactivity_timeout_seconds=1.0,
            prompt_max_duration_seconds=1.0,
            prompt_cleanup_timeout_seconds=1.0,
        ),
        opencode_port=0,
    )


def test_every_session_can_ask_its_user(tmp_path, monkeypatch):
    harness = _claude_harness(tmp_path, monkeypatch, {})
    assert harness.config.tools is not None
    assert harness.config.system_prompt_append is None


def test_the_app_server_is_reached_through_the_token_renewing_proxy(tmp_path, monkeypatch):
    harness = _claude_harness(tmp_path, monkeypatch, {"mcp_servers": [APP_SERVER]})
    assert isinstance(harness._mcp_proxies["app"], McpProxy)
    # The configured entry stays the fallback when the proxy cannot start.
    assert harness.config.mcp_servers == (APP_SERVER,)


def test_a_product_named_server_is_proxied_under_its_own_name(tmp_path, monkeypatch):
    acme = {**APP_SERVER, "name": "acme"}
    harness = _claude_harness(tmp_path, monkeypatch, {"mcp_servers": [acme]})
    assert isinstance(harness._mcp_proxies["acme"], McpProxy)


def test_a_session_without_an_app_server_has_no_proxy(tmp_path, monkeypatch):
    harness = _claude_harness(tmp_path, monkeypatch, {"mcp_servers": []})
    assert harness._mcp_proxies == {}
