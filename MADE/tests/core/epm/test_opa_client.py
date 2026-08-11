import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from core.epm.opa_client import OpaEvaluationError, evaluate_hard_constraints

POLICIES_HARD_DIR = Path(__file__).resolve().parents[3] / "policies" / "hard"


def test_allows_compliant_candidate():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "public"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
            "org": {"budget_remaining_usd": 10.0, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["allow"] is True
    assert result["deny_reasons"] == []
    assert result["requires_human_approval"] is False


def test_denies_and_reports_reason_for_over_budget_candidate():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "public"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 5.0},
            "org": {"budget_remaining_usd": 0.1, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["allow"] is False
    assert any("cost:" in reason for reason in result["deny_reasons"])


def test_flags_human_approval_for_restricted_data():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "restricted"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
            "org": {"budget_remaining_usd": 10.0, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["requires_human_approval"] is True
    assert len(result["approval_reasons"]) > 0


def test_raises_on_nonexistent_policies_dir(tmp_path):
    with pytest.raises(OpaEvaluationError):
        evaluate_hard_constraints(
            {"task": {}, "candidate": {}, "org": {}},
            tmp_path / "does_not_exist",
        )


def test_raises_on_subprocess_timeout():
    """Test that subprocess.TimeoutExpired is caught and converted to OpaEvaluationError."""
    with patch("subprocess.run") as mock_run:
        mock_run.side_effect = subprocess.TimeoutExpired("opa", 5)

        with pytest.raises(OpaEvaluationError, match="opa eval failed to run"):
            evaluate_hard_constraints(
                {"task": {}, "candidate": {}, "org": {}},
                POLICIES_HARD_DIR,
            )


def test_raises_on_missing_allow_key():
    """Test that missing 'allow' key in OPA output raises OpaEvaluationError."""
    mock_response = {
        "result": [
            {
                "expressions": [
                    {
                        "value": {
                            # Missing "allow" key - this is the fail-open bug we're preventing
                            "deny": [],
                            "require_approval": [],
                        }
                    }
                ]
            }
        ]
    }

    with patch("subprocess.run") as mock_run:
        mock_process = type("MockProcess", (), {
            "returncode": 0,
            "stdout": json.dumps(mock_response),
            "stderr": "",
        })()
        mock_run.return_value = mock_process

        with pytest.raises(OpaEvaluationError, match="opa result missing 'allow' key"):
            evaluate_hard_constraints(
                {"task": {}, "candidate": {}, "org": {}},
                POLICIES_HARD_DIR,
            )
