from core.modm.models import Candidate, Objective, Ranking, RankingEntry


def weighted_sum(candidates: list[Candidate], objectives: list[Objective]) -> Ranking:
    if not candidates:
        return Ranking(entries=[])

    mins = {obj.name: min(c.scores[obj.name] for c in candidates) for obj in objectives}
    maxs = {obj.name: max(c.scores[obj.name] for c in candidates) for obj in objectives}

    entries = []
    for candidate in candidates:
        total = 0.0
        for obj in objectives:
            lo, hi = mins[obj.name], maxs[obj.name]
            raw = candidate.scores[obj.name]
            if hi == lo:
                normalized = 1.0
            elif obj.direction == "maximize":
                normalized = (raw - lo) / (hi - lo)
            else:
                normalized = (hi - raw) / (hi - lo)
            total += normalized * obj.weight
        entries.append(RankingEntry(id=candidate.id, score=total))

    entries.sort(key=lambda e: e.score, reverse=True)
    return Ranking(entries=entries)
