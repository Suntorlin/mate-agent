"""The session's spending cap, checked in the sandbox before a product tool call (stdlib only).

The session's owner may cap what it spends, in US dollars (``GET /sessions/<id>/spend`` on the
control plane, sandbox token). The control plane stops a session that crosses the cap, but only
after the fact. This module is the check in front of each call the agent makes to the product's
MCP server (``mcp_proxy``): once the cap is used up, a call is refused before it reaches the
product. A spend report that cannot be read refuses nothing: the control plane's own stop still
holds.
"""

from __future__ import annotations

import math
import urllib.parse
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

SPEND_PATH = "/spend"
# The control plane reads the running turn's model spend from the gateway before it answers.
SPEND_TIMEOUT_SECONDS = 8.0
REFUSAL_CODE = "over_session_budget"


def budget_refusal(spend: Mapping[str, Any]) -> dict[str, Any] | None:
    """Why no further call may be made, as an MCP tool error; None to go ahead."""
    cap = _amount(spend.get("budgetUsd"))
    if spend.get("unlimited") is True or cap is None:
        return None
    used = _amount(spend.get("usedUsd"))
    if used is None or used < cap:
        return None
    return {
        "code": REFUSAL_CODE,
        "message": (
            f"Not submitted: this session has used ${used:.2f} of the ${cap:.2f} its owner "
            "allows it."
        ),
        "retryable": False,
        "next_action": (
            "Do not retry it, and do not make it another way (another tool, a script, the API). "
            "Tell the user, in their language, what you wanted to do and that the session is over "
            "the budget they set: they can raise it in the session's permissions."
        ),
    }


def refusal_result(refusal: Mapping[str, Any]) -> dict[str, Any]:
    """The refusal as an MCP ``tools/call`` result."""
    return {
        "content": [{"type": "text", "text": f"{refusal['message']} {refusal['next_action']}"}],
        "structuredContent": {"error": dict(refusal)},
        "isError": True,
    }


def spend_url(control_plane_url: str, session_id: str) -> str:
    base = control_plane_url.rstrip("/")
    return f"{base}/sessions/{urllib.parse.quote(session_id, safe='')}{SPEND_PATH}"


def _amount(value: Any) -> float | None:
    """``value`` when it is a finite number (a boolean is not one), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)
