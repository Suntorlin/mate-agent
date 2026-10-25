"""A model call the LLM gateway refused because a limit is spent, read from its words.

The gateway refuses a call when the user's own budget for the period, the
service-wide budget, or the account itself is stopped. A harness hands the
bridge nothing of that refusal but the error's text (Claude Code says
``API Error: Request rejected (429) · <the gateway's message>``), so the
gateway ends its message with a tag, ``[llm_budget=<user|global|blocked>]``
with an optional `` resets_at=<ISO 8601>`` (packages/gateway/src/budget.ts,
``refusalTag``). This module turns that tag into the machine-readable fields
the turn's ``error`` and ``execution_complete`` events carry, so the web can
say which limit ran out and when it resets instead of "busy, try again".
"""

from __future__ import annotations

import re

_TAG = re.compile(
    r"\[llm_budget=(?P<kind>user|global|blocked)(?: resets_at=(?P<resets_at>[0-9TZ:.+\-]+))?\]"
)

# The `errorCode` values a refused turn's events carry.
ERROR_CODES = {
    "user": "model_budget_user",
    "global": "model_budget_global",
    "blocked": "model_access_blocked",
}


def refusal_fields(text: object) -> dict[str, str]:
    """``errorCode`` (and ``resetsAt`` when known) for a gateway refusal, else ``{}``."""
    if not isinstance(text, str):
        return {}
    match = _TAG.search(text)
    if match is None:
        return {}
    fields = {"errorCode": ERROR_CODES[match["kind"]]}
    if match["resets_at"]:
        fields["resetsAt"] = match["resets_at"]
    return fields
