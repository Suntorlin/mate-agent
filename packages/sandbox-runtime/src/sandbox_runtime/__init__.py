"""Provider-agnostic sandbox runtime for Open-Inspect.

This package contains the code that runs inside sandboxes regardless of provider
(Modal, E2B, Daytona, Vercel). It includes:
- Bridge: WebSocket/SSE communication with the control plane
- Entrypoint: Supervisor process managing sandbox lifecycle
- Auth: GitHub App and internal HMAC authentication
- Harness: the Claude agent (claude-agent-sdk) and its in-process tools, or OpenCode
- Plugins: OpenCode plugins (ChatGPT and SuperGrok auth, inspect)
- Tools: OpenCode custom tools (child sessions, Slack)
"""

from .types import (
    GitUser,
    McpServerConfig,
    SandboxStatus,
    SessionConfig,
)

__all__ = [
    "GitUser",
    "McpServerConfig",
    "SandboxStatus",
    "SessionConfig",
]
