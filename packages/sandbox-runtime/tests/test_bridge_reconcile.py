"""
Bridge tests for the ``reconcile_prompt`` command.

After every ``ready`` the control plane asks about its processing message. A
bridge process that never received the message (it restarted after the
dispatch) fails it; one that received it leaves it to its own settlement.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import LOST_PROMPT_ERROR, AgentBridge
from sandbox_runtime.harness import HarnessId


@pytest.fixture
def bridge() -> AgentBridge:
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        harness_id=HarnessId.OPENCODE,
    )
    b._send_event = AsyncMock(return_value=True)  # type: ignore[method-assign]
    b.activity.start_prompt = MagicMock()  # type: ignore[method-assign]
    return b


@pytest.mark.asyncio
async def test_a_message_this_process_never_received_is_failed(bridge: AgentBridge) -> None:
    await bridge._handle_command({"type": "reconcile_prompt", "messageId": "msg-1"})

    bridge._send_event.assert_awaited_once_with(  # type: ignore[attr-defined]
        {
            "type": "execution_complete",
            "messageId": "msg-1",
            "success": False,
            "error": LOST_PROMPT_ERROR,
        }
    )


@pytest.mark.asyncio
async def test_a_message_this_process_received_is_left_alone(bridge: AgentBridge) -> None:
    await bridge._handle_command({"type": "prompt", "messageId": "msg-1", "content": "hi"})
    bridge.activity.start_prompt.assert_called_once()  # type: ignore[attr-defined]

    await bridge._handle_command({"type": "reconcile_prompt", "messageId": "msg-1"})

    bridge._send_event.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_a_reconcile_without_a_message_id_is_ignored(bridge: AgentBridge) -> None:
    await bridge._handle_command({"type": "reconcile_prompt"})
    await bridge._handle_command({"type": "reconcile_prompt", "messageId": ""})

    bridge._send_event.assert_not_awaited()  # type: ignore[attr-defined]
