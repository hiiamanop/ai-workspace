import math

from core.modm.models import Candidate, Objective, Ranking, RankingEntry


def topsis(candidates: list[Candidate], objectives: list[Objective]) -> Ranking:
    if not candidates:
        return Ranking(entries=[])

    norms = {}
    for obj in objectives:
        denom = math.sqrt(sum(c.scores[obj.name] ** 2 for c in candidates))
        norms[obj.name] = denom if denom > 0 else 1.0

    weighted = {
        c.id: {
            obj.name: (c.scores[obj.name] / norms[obj.name]) * obj.weight
            for obj in objectives
        }
        for c in candidates
    }

    ideal_best: dict[str, float] = {}
    ideal_worst: dict[str, float] = {}
    for obj in objectives:
        values = [weighted[c.id][obj.name] for c in candidates]
        if obj.direction == "maximize":
            ideal_best[obj.name] = max(values)
            ideal_worst[obj.name] = min(values)
        else:
            ideal_best[obj.name] = min(values)
            ideal_worst[obj.name] = max(values)

    entries = []
    for candidate in candidates:
        dist_best = math.sqrt(sum(
            (weighted[candidate.id][obj.name] - ideal_best[obj.name]) ** 2 for obj in objectives
        ))
        dist_worst = math.sqrt(sum(
            (weighted[candidate.id][obj.name] - ideal_worst[obj.name]) ** 2 for obj in objectives
        ))
        denom = dist_best + dist_worst
        closeness = dist_worst / denom if denom > 0 else 0.0
        entries.append(RankingEntry(id=candidate.id, score=closeness))

    entries.sort(key=lambda e: e.score, reverse=True)
    return Ranking(entries=entries)
