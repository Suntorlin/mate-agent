"""A gateway budget refusal travels as a code on the turn's error and end."""

from unittest.mock import AsyncMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import HarnessId
from sandbox_runtime.model_refusal import refusal_fields
from tests.conftest import ScriptedHarness

# What Claude Code reports for the gateway's refusal of a creator over their own budget.
USER_REFUSAL = (
    "API Error: Request rejected (429) · You've used this month's AI budget ($20.13 of $20.00). "
    "It resets on November 1, 2026 (UTC). "
    "[llm_budget=user resets_at=2026-11-01T00:00:00.000Z]"
)


class TestRefusalFields:
    def test_reads_the_creators_own_budget_and_its_reset(self):
        assert refusal_fields(USER_REFUSAL) == {
            "errorCode": "model_budget_user",
            "resetsAt": "2026-11-01T00:00:00.000Z",
        }

    def test_reads_the_service_wide_limit_with_or_without_a_reset(self):
        assert refusal_fields("API Error: 429 paused [llm_budget=global]") == {
            "errorCode": "model_budget_global"
        }
        assert refusal_fields("[llm_budget=global resets_at=2026-11-01T00:00:00.000Z]") == {
            "errorCode": "model_budget_global",
            "resetsAt": "2026-11-01T00:00:00.000Z",
        }

    def test_reads_a_paused_account(self):
        assert refusal_fields(
            "Failed to authenticate. API Error: 403 AI usage is paused for this account. "
            "Please contact support. [llm_budget=blocked]"
        ) == {"errorCode": "model_access_blocked"}

    @pytest.mark.parametrize(
        "text",
        [
            "API Error: Request rejected (429) · rate limit",
            "API Error: 529 overloaded",
            "API Error: 502 Bad Gateway",
            "[llm_budget=someone resets_at=x]",
            "",
            None,
            42,
        ],
    )
    def test_says_nothing_about_a_busy_or_unknown_failure(self, text):
        assert refusal_fields(text) == {}


@pytest.fixture
def bridge() -> AgentBridge:
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        harness_id=HarnessId.OPENCODE,
    )
    b.harness.session_id = "oc-session-123"
    b._configure_git_identity = AsyncMock()
    b._send_event = AsyncMock()
    return b


def _prompt() -> dict:
    return {
        "messageId": "msg-1",
        "content": "make a video",
        "model": "claude-opus-5-5",
        "author": {"userId": "user-1", "gitIdentity": {"mode": "agent-only"}},
    }


@pytest.mark.asyncio
async def test_a_refused_turn_carries_the_code_on_its_error_and_its_end(bridge: AgentBridge):
    async def stream(*_args, **_kwargs):
        yield {"type": "error", "messageId": "msg-1", "error": USER_REFUSAL}

    bridge.boot_attach.harness = ScriptedHarness(stream)

    completion = await bridge._handle_prompt(_prompt())

    assert completion["success"] is False
    assert completion["error"] == USER_REFUSAL
    assert completion["errorCode"] == "model_budget_user"
    assert completion["resetsAt"] == "2026-11-01T00:00:00.000Z"
    sent = [call.args[0] for call in bridge._send_event.await_args_list]
    error = next(event for event in sent if event["type"] == "error")
    assert error["errorCode"] == "model_budget_user"
    assert error["resetsAt"] == "2026-11-01T00:00:00.000Z"


@pytest.mark.asyncio
async def test_a_busy_model_service_carries_no_code(bridge: AgentBridge):
    async def stream(*_args, **_kwargs):
        yield {
            "type": "error",
            "messageId": "msg-1",
            "error": "API Error: Request rejected (429) · rate limit",
        }

    bridge.boot_attach.harness = ScriptedHarness(stream)

    completion = await bridge._handle_prompt(_prompt())

    assert completion["success"] is False
    assert "errorCode" not in completion
    assert "resetsAt" not in completion
    sent = [call.args[0] for call in bridge._send_event.await_args_list]
    assert all("errorCode" not in event for event in sent)
