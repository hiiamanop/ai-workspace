# tests/core/modm/test_topsis.py
from core.modm.models import Candidate, Objective
from core.modm.topsis import topsis


def test_prefers_cheaper_higher_quality_candidate():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0, "quality": 1.0}),
        Candidate(id="b", scores={"cost": 1.0, "quality": 0.0}),
    ]
    objectives = [
        Objective(name="cost", direction="minimize", weight=0.5),
        Objective(name="quality", direction="maximize", weight=0.5),
    ]

    ranking = topsis(candidates, objectives)

    assert ranking.best.id == "a"
    assert ranking.entries[0].score > ranking.entries[1].score


def test_empty_candidates_returns_empty_ranking():
    ranking = topsis([], [Objective(name="cost", direction="minimize", weight=1.0)])
    assert ranking.entries == []
    assert ranking.best is None


def test_all_zero_scores_does_not_raise_division_error():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0}),
        Candidate(id="b", scores={"cost": 0.0}),
    ]
    objectives = [Objective(name="cost", direction="minimize", weight=1.0)]

    ranking = topsis(candidates, objectives)

    assert len(ranking.entries) == 2
