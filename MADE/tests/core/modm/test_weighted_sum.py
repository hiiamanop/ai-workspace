# tests/core/modm/test_weighted_sum.py
from core.modm.models import Candidate, Objective
from core.modm.weighted_sum import weighted_sum


def test_prefers_cheaper_higher_quality_candidate():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0, "quality": 1.0}),
        Candidate(id="b", scores={"cost": 1.0, "quality": 0.0}),
    ]
    objectives = [
        Objective(name="cost", direction="minimize", weight=0.5),
        Objective(name="quality", direction="maximize", weight=0.5),
    ]

    ranking = weighted_sum(candidates, objectives)

    assert ranking.best.id == "a"
    assert ranking.entries[0].score == 1.0
    assert ranking.entries[1].score == 0.0


def test_empty_candidates_returns_empty_ranking():
    ranking = weighted_sum([], [Objective(name="cost", direction="minimize", weight=1.0)])
    assert ranking.entries == []
    assert ranking.best is None


def test_identical_scores_all_tie_at_full_score():
    candidates = [
        Candidate(id="a", scores={"cost": 5.0}),
        Candidate(id="b", scores={"cost": 5.0}),
    ]
    objectives = [Objective(name="cost", direction="minimize", weight=1.0)]

    ranking = weighted_sum(candidates, objectives)

    assert {e.score for e in ranking.entries} == {1.0}
