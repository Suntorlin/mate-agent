"""The spending-cap check in front of a product tool call."""

from __future__ import annotations

from sandbox_runtime.budget import REFUSAL_CODE, budget_refusal, refusal_result, spend_url

# What GET /sessions/<id>/spend answers for a capped session.
CAPPED = {
    "permissionMode": "auto_within_budget",
    "unlimited": False,
    "budgetUsd": 2.0,
    "usedUsd": 1.5,
    "remainingUsd": 0.5,
}


def test_a_session_inside_its_cap_goes_ahead() -> None:
    assert budget_refusal(CAPPED) is None
    assert budget_refusal({**CAPPED, "unlimited": True, "budgetUsd": None}) is None


def test_a_spend_report_that_cannot_be_read_refuses_nothing() -> None:
    assert budget_refusal({"unlimited": False}) is None
    assert budget_refusal({"unlimited": False, "budgetUsd": 2}) is None
    assert budget_refusal({"budgetUsd": "2", "usedUsd": 3}) is None
    assert budget_refusal({"budgetUsd": True, "usedUsd": 3}) is None
    assert budget_refusal({"budgetUsd": 2, "usedUsd": float("nan")}) is None


def test_a_used_up_cap_refuses_the_call() -> None:
    refusal = budget_refusal({**CAPPED, "usedUsd": 2.0})

    assert refusal is not None
    assert refusal["code"] == REFUSAL_CODE
    assert refusal["retryable"] is False
    assert "$2.00 of the $2.00" in refusal["message"]
    result = refusal_result(refusal)
    assert result["isError"] is True
    assert result["structuredContent"]["error"]["code"] == REFUSAL_CODE


def test_the_spend_url_names_the_session() -> None:
    assert (
        spend_url("https://cp.example/", "sess 1") == "https://cp.example/sessions/sess%201/spend"
    )
