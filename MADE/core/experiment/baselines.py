from core.modm.models import Candidate, Objective
from core.modm.weighted_sum import weighted_sum

_STANDARD_OBJECTIVES = [
    ("cost", "minimize"),
    ("quality", "maximize"),
    ("latency", "minimize"),
    ("business_risk", "minimize"),
]


def _objectives_with_weights(weights: dict[str, float]) -> list[Objective]:
    return [
        Objective(name=name, direction=direction, weight=weights[name])
        for name, direction in _STANDARD_OBJECTIVES
    ]


def select_ahp_saw(candidates: list[Candidate], weights: dict[str, float]) -> str | None:
    if not candidates:
        return None
    ranking = weighted_sum(candidates, _objectives_with_weights(weights))
    return ranking.best.id if ranking.best else None


def select_no_policy(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    equal_weights = {"cost": 0.25, "quality": 0.25, "latency": 0.25, "business_risk": 0.25}
    ranking = weighted_sum(candidates, _objectives_with_weights(equal_weights))
    return ranking.best.id if ranking.best else None


def select_always_strong(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    return max(candidates, key=lambda c: c.scores["quality"]).id


def select_always_cheap(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    return min(candidates, key=lambda c: c.scores["cost"]).id
