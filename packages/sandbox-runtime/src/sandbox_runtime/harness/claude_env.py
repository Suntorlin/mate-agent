"""Clean-credential launch for the Claude Agent SDK child.

The SDK merges ``os.environ`` under ``ClaudeAgentOptions.env`` when it spawns
the ``claude`` binary, and the bridge inherits the supervisor's full
environment, including the platform-delivered ``ANTHROPIC_API_KEY``. So the
harness never hands the SDK the real binary. It hands it a generated wrapper
that re-executes the binary with the sandbox environment minus the Anthropic
credentials that do not belong to the active auth mode, for every invocation
including the SDK's version probe.

Everything else passes through, exactly as it does for OpenCode: the sandbox
token, ``SESSION_CONFIG`` and user secrets are what ``oi-git-sign``,
``oi-git-credentials``, ``upload-media`` and the agent's own commands need.
The wrapper carries variable *names* only. Credential values travel through
``ClaudeAgentOptions.env`` in process memory and are never written to disk.
"""

from __future__ import annotations

import json
import math
import os
import stat
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping

# Credential variables per auth mode. Exactly one mode is ever active: the
# child sees either the key family or the OAuth token, never both, so the
# family of the *other* mode is what the wrapper strips.
API_KEY_CREDENTIAL_VARS: Final[tuple[str, ...]] = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
)
OAUTH_CREDENTIAL_VARS: Final[tuple[str, ...]] = ("CLAUDE_CODE_OAUTH_TOKEN",)

OAUTH_TOKEN_ENV_VAR: Final = "CLAUDE_CODE_OAUTH_TOKEN"
API_KEY_ENV_VAR: Final = "ANTHROPIC_API_KEY"
OAUTH_MANAGED_ENV_VAR: Final = "ANTHROPIC_OAUTH_MANAGED"
CONFIG_DIR_ENV_VAR: Final = "CLAUDE_CONFIG_DIR"

WRAPPER_NAME: Final = "claude-clean-env"

_POLICY: Final = {
    "attribution": {"commit": "", "pr": "", "sessionUrl": False},
    "feedbackDrafts": "off",
    "feedbackSurveyRate": 0,
}
CLAUDE_POLICY_SETTINGS: Final = json.dumps(_POLICY, separators=(",", ":"))

# A gateway token lasts two hours (GATEWAY_TOKEN_TTL_SECONDS), far less than a session, so in
# a session behind the LLM gateway (GATEWAY_URL) Claude Code asks this command for the token (``apiKeyHelper``) instead of reading it once from its
# environment: at start, every KEY_HELPER_TTL_MS, and again when the gateway answers 401.
GATEWAY_URL_ENV_VAR: Final = "GATEWAY_URL"
GATEWAY_TOKEN_ENV_VAR: Final = "GATEWAY_TOKEN"
GATEWAY_KEY_HELPER: Final = Path(__file__).resolve().parents[1] / "bin" / "gateway-key"
KEY_HELPER_TTL_MS: Final = 30 * 60 * 1000

# Claude Code cuts an MCP server's instructions and each tool description at 2,048 characters,
# silently, unless this raises the cap (2.1.280 and later). A product gives the agent its
# persona as its MCP server's instructions, and a real one runs longer than that.
MCP_DESCRIPTION_MAX_CHARS: Final = 16_384


def gateway_key_helper(environ: Mapping[str, str]) -> str | None:
    """The ``apiKeyHelper`` command when the session uses the LLM gateway (``GATEWAY_URL``).

    A user's own API key (a value other than the gateway token) is left as it is, and so is a
    sandbox that cannot reach the control plane to renew the token.
    """
    token = environ.get(GATEWAY_TOKEN_ENV_VAR)
    if not environ.get(GATEWAY_URL_ENV_VAR) or not token or environ.get(API_KEY_ENV_VAR) != token:
        return None
    if not environ.get("CONTROL_PLANE_URL") or not environ.get("SANDBOX_AUTH_TOKEN"):
        return None
    return str(GATEWAY_KEY_HELPER)


def claude_policy_settings(key_helper: str | None = None) -> str:
    """``ClaudeAgentOptions.settings``: the policy, and the key helper when there is one."""
    if key_helper is None:
        return CLAUDE_POLICY_SETTINGS
    return json.dumps({**_POLICY, "apiKeyHelper": key_helper}, separators=(",", ":"))


# How long the child may run one Bash call, and therefore how long the SDK
# stream may legitimately say nothing: it carries no message between a tool
# call and its result, and no keepalive. Both variables reach the child
# untouched (the wrapper strips credentials only), so the bridge resolves the
# ceiling from the same environment the child reads rather than keeping a
# second copy of the number that can disagree with it.
BASH_MAX_TIMEOUT_ENV_VAR: Final = "BASH_MAX_TIMEOUT_MS"
BASH_DEFAULT_TIMEOUT_ENV_VAR: Final = "BASH_DEFAULT_TIMEOUT_MS"
# The runtime's own defaults, given to the child when the environment sets neither (a user
# secret of the same name still wins): creative work runs renders and installs longer than the
# CLI's built-ins allow.
RUNTIME_BASH_DEFAULT_TIMEOUT_MS: Final = 10 * 60 * 1000
RUNTIME_BASH_MAX_TIMEOUT_MS: Final = 60 * 60 * 1000
# The CLI's built-ins, which apply to a value it cannot read.
CLI_BASH_MAX_TIMEOUT_SECONDS: Final = 600.0
CLI_BASH_DEFAULT_TIMEOUT_SECONDS: Final = 120.0
# Slack over the ceiling, for delivering a large tool result and re-entering
# the model once the tool returns.
STREAM_SILENCE_MARGIN_SECONDS: Final = 300.0


def bash_timeout_defaults(environ: Mapping[str, str] = os.environ) -> dict[str, str]:
    """The runtime's Bash timeouts for each variable the environment does not set."""
    defaults = {
        BASH_DEFAULT_TIMEOUT_ENV_VAR: str(RUNTIME_BASH_DEFAULT_TIMEOUT_MS),
        BASH_MAX_TIMEOUT_ENV_VAR: str(RUNTIME_BASH_MAX_TIMEOUT_MS),
    }
    return {name: value for name, value in defaults.items() if not environ.get(name)}


def bash_timeout_ceiling_seconds(environ: Mapping[str, str] = os.environ) -> float:
    """The longest single Bash call the child will allow, by the CLI's own rule.

    The CLI takes the larger of its max and default timeouts, each overridable
    from the environment (the runtime's defaults fill an unset one); a value
    that does not parse, or is not positive, is ignored in favour of the built-in.
    """
    environ = {**environ, **bash_timeout_defaults(environ)}
    return max(
        _milliseconds_as_seconds(environ.get(BASH_MAX_TIMEOUT_ENV_VAR))
        or CLI_BASH_MAX_TIMEOUT_SECONDS,
        _milliseconds_as_seconds(environ.get(BASH_DEFAULT_TIMEOUT_ENV_VAR))
        or CLI_BASH_DEFAULT_TIMEOUT_SECONDS,
    )


def stream_silence_budget_seconds(environ: Mapping[str, str] = os.environ) -> float:
    """How long the SDK stream may say nothing before the turn counts as stuck.

    Every other Claude tool stays well inside the Bash ceiling: MCP calls
    carry their own wall-clock limit, and a sub-agent's own tool calls keep
    arriving on this stream while it works.
    """
    return bash_timeout_ceiling_seconds(environ) + STREAM_SILENCE_MARGIN_SECONDS


def _milliseconds_as_seconds(raw: str | None) -> float | None:
    """An environment duration in milliseconds, or ``None`` when unusable."""
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return value / 1000.0


class ClaudeAuthMode(StrEnum):
    API_KEY = "api_key"
    OAUTH_TOKEN = "oauth_token"


@dataclass(frozen=True)
class ClaudeCredential:
    """The one credential the child receives, held in memory only."""

    mode: ClaudeAuthMode
    # Variables to pass through ``ClaudeAgentOptions.env``; never logged.
    env: Mapping[str, str]

    @classmethod
    def api_key(cls, environ: Mapping[str, str]) -> ClaudeCredential | None:
        """Adopt the bridge's Anthropic key family (a user-configured gateway keeps working)."""
        if not environ.get(API_KEY_ENV_VAR):
            return None
        return cls(
            ClaudeAuthMode.API_KEY,
            {name: environ[name] for name in API_KEY_CREDENTIAL_VARS if environ.get(name)},
        )

    @classmethod
    def oauth_token(cls, token: str) -> ClaudeCredential:
        return cls(ClaudeAuthMode.OAUTH_TOKEN, {OAUTH_TOKEN_ENV_VAR: token})


def denylist_for(mode: ClaudeAuthMode) -> tuple[str, ...]:
    """The credential family the child must never see in ``mode``."""
    return OAUTH_CREDENTIAL_VARS if mode is ClaudeAuthMode.API_KEY else API_KEY_CREDENTIAL_VARS


def clean_child_env(
    parent: Mapping[str, str], mode: ClaudeAuthMode, extra: Mapping[str, str]
) -> dict[str, str]:
    """What the child ends up with: parent+extra minus the other mode's credentials.

    This is the reference the sentinel test compares the wrapper's real
    output against.
    """
    merged = {**parent, **extra}
    stripped = set(denylist_for(mode))
    return {name: value for name, value in merged.items() if name not in stripped}


def bundled_claude_binary() -> Path:
    """The ``claude`` binary the pinned SDK wheel ships (``claude_agent_sdk/_bundled``)."""
    import claude_agent_sdk

    package_dir = Path(claude_agent_sdk.__file__).parent
    binary = package_dir / "_bundled" / "claude"
    if not binary.is_file():
        raise FileNotFoundError(f"The Claude Agent SDK wheel has no bundled binary at {binary}")
    return binary


def write_clean_env_wrapper(
    directory: Path,
    *,
    mode: ClaudeAuthMode,
    binary: Path,
    python_executable: str | None = None,
) -> Path:
    """Generate the wrapper set as ``ClaudeAgentOptions.cli_path``.

    A Python script rather than a shell one so the denylist is applied
    exactly (no word splitting, no accidental empty exports). It re-executes
    ``binary`` with its own environment, which is the SDK's merged
    ``os.environ`` + ``options.env``, minus the other mode's credentials.
    """
    python = python_executable or sys.executable
    names = denylist_for(mode)
    script = "\n".join(
        [
            f"#!{python}",
            '"""Generated by the Open Inspect Claude harness. Do not edit."""',
            "import os",
            "import sys",
            "",
            f"BINARY = {str(binary)!r}",
            f"DENYLIST = frozenset({names!r})",
            "",
            "env = {name: value for name, value in os.environ.items() if name not in DENYLIST}",
            "os.execve(BINARY, [BINARY, *sys.argv[1:]], env)",
            "",
        ]
    )
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = directory / WRAPPER_NAME
    wrapper.write_text(script)
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def harness_env(
    config_dir: Path,
    credential: ClaudeCredential,
    key_helper: str | None = None,
    environ: Mapping[str, str] = os.environ,
) -> dict[str, str]:
    """``ClaudeAgentOptions.env``: config dir, policy, and the one credential.

    With a key helper the API key is blanked: Claude Code sends an API key from its environment
    in ``x-api-key`` ahead of the helper's, and the gateway reads that header first, so the
    token taken at start would outlive its two hours.
    """
    helper_env = (
        {API_KEY_ENV_VAR: "", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": str(KEY_HELPER_TTL_MS)}
        if key_helper
        else {}
    )
    return {
        CONFIG_DIR_ENV_VAR: str(config_dir),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        # A background sub-agent returns a result before its work is done and
        # delivers the findings on a later injected turn. Foreground sub-agents
        # launched in one message still run concurrently, as OpenCode's task
        # tool does.
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
        # Claude Code's auto memory has the agent keep notes in local MEMORY.md files, which never
        # reach the user's memory in the engine; with it off, `mem` is the only memory it is told of.
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH": str(MCP_DESCRIPTION_MAX_CHARS),
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_TELEMETRY": "1",
        # Anthropic telemetry and opt-in customer OpenTelemetry are separate.
        "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
        "OTEL_TRACES_EXPORTER": "none",
        **bash_timeout_defaults(environ),
        **credential.env,
        **helper_env,
    }


def resolve_api_key_credential(environ: Mapping[str, str] = os.environ) -> ClaudeCredential | None:
    return ClaudeCredential.api_key(environ)
