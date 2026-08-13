from pathlib import Path

import pytest
from pydantic import ValidationError

from core.decision.engine import DecisionCandidate, Org, Task, decide

POLICIES_DIR = Path(__file__).resolve().parents[3] / "policies"


def test_selects_best_candidate_among_compliant_options():
    result = decide(
        task=Task(type="summarization", data_classification="internal"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="gpt-4o", vendor="openai", kind="model", cost_per_1k_tokens=0.02,
                scores={"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            ),
            DecisionCandidate(
                id="gpt-3.5", vendor="openai", kind="model", cost_per_1k_tokens=0.005,
                scores={"cost": 0.005, "quality": 0.6, "latency": 0.8, "business_risk": 0.2},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id in {"gpt-4o", "gpt-3.5"}
    assert len(result.ranking) == 2
    assert result.excluded == []
    assert result.technique_used == "topsis"


def test_excludes_candidate_denied_by_hard_constraint():
    result = decide(
        task=Task(type="summarization", data_classification="confidential"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="local-llama", vendor="unverified-oss", kind="model", cost_per_1k_tokens=0.0,
                scores={"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id is None
    assert result.ranking == []
    assert len(result.excluded) == 1
    assert result.excluded[0].id == "local-llama"
    assert "compliance:" in result.excluded[0].reason


def test_flags_human_approval_without_blocking_selection():
    result = decide(
        task=Task(type="contract_review", data_classification="internal"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="gpt-4o", vendor="openai", kind="model", cost_per_1k_tokens=0.02,
                scores={"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.requires_human_approval is True
    assert result.selected_candidate_id == "gpt-4o"


def test_task_rejects_invalid_data_classification():
    with pytest.raises(ValidationError):
        Task(type="x", data_classification="Confidential")


def test_critical_task_prefers_quality_over_cost():
    candidates = [
        DecisionCandidate(
            id="cheap-low-quality", vendor="internal", kind="model", cost_per_1k_tokens=0.0,
            scores={"cost": 0.0, "quality": 0.5, "latency": 0.5, "business_risk": 0.1},
        ),
        DecisionCandidate(
            id="pricey-high-quality", vendor="internal", kind="model", cost_per_1k_tokens=0.05,
            scores={"cost": 0.05, "quality": 0.99, "latency": 0.5, "business_risk": 0.1},
        ),
    ]

    standard = decide(
        task=Task(type="summarization", data_classification="internal"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=candidates,
        policies_dir=POLICIES_DIR,
    )
    critical = decide(
        task=Task(type="summarization", data_classification="restricted"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=candidates,
        policies_dir=POLICIES_DIR,
    )

    assert standard.selected_candidate_id == "cheap-low-quality"
    assert critical.selected_candidate_id == "pricey-high-quality"


def test_high_complexity_prefers_quality_over_cost():
    candidates = [
        DecisionCandidate(id="cheap", vendor="v", kind="model", cost_per_1k_tokens=0.001, scores={"cost": 0.1, "quality": 0.3, "latency": 0.1, "business_risk": 0.1}),
        DecisionCandidate(id="premium", vendor="v", kind="model", cost_per_1k_tokens=0.02, scores={"cost": 0.9, "quality": 0.95, "latency": 0.9, "business_risk": 0.9}),
    ]
    org = Org(budget_remaining_usd=1000.0, region="us")

    low_result = decide(
        task=Task(type="chat", data_classification="internal", complexity="low"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )
    high_result = decide(
        task=Task(type="chat", data_classification="internal", complexity="high"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )

    assert low_result.selected_candidate_id == "cheap"
    assert high_result.selected_candidate_id == "premium"


def test_confidential_classification_still_wins_over_low_complexity():
    """data_classification's epm-critical.yaml selection takes priority over complexity — confirms the plan's documented precedence (classification dominates, complexity only matters when classification doesn't already force epm-critical.yaml)."""
    candidates = [
        DecisionCandidate(id="cheap", vendor="v", kind="model", cost_per_1k_tokens=0.001, scores={"cost": 0.1, "quality": 0.3, "latency": 0.1, "business_risk": 0.1}),
        DecisionCandidate(id="premium", vendor="v", kind="model", cost_per_1k_tokens=0.02, scores={"cost": 0.9, "quality": 0.95, "latency": 0.9, "business_risk": 0.9}),
    ]
    org = Org(budget_remaining_usd=1000.0, region="us")

    result = decide(
        task=Task(type="chat", data_classification="confidential", complexity="low"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id == "premium"
    assert result.technique_used == "topsis"
