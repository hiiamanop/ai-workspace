from core.experiment.baselines import (
    select_ahp_saw, select_always_cheap, select_always_strong, select_no_policy,
)
from core.modm.models import Candidate

CANDIDATES = [
    Candidate(id="cheap", scores={"cost": 0.001, "quality": 0.5, "latency": 1.0, "business_risk": 0.3}),
    Candidate(id="strong", scores={"cost": 0.02, "quality": 0.95, "latency": 1.5, "business_risk": 0.1}),
]


def test_select_always_strong_picks_highest_quality():
    assert select_always_strong(CANDIDATES) == "strong"


def test_select_always_cheap_picks_lowest_cost():
    assert select_always_cheap(CANDIDATES) == "cheap"


def test_select_ahp_saw_uses_given_weights():
    weights = {"cost": 0.1, "quality": 0.7, "latency": 0.1, "business_risk": 0.1}
    assert select_ahp_saw(CANDIDATES, weights) == "strong"


def test_select_no_policy_uses_equal_weights():
    result = select_no_policy(CANDIDATES)
    assert result in {"cheap", "strong"}


def test_empty_candidates_returns_none_for_all_strategies():
    assert select_always_strong([]) is None
    assert select_always_cheap([]) is None
    assert select_ahp_saw([], {"cost": 1.0, "quality": 0.0, "latency": 0.0, "business_risk": 0.0}) is None
    assert select_no_policy([]) is None
