from pydantic import BaseModel


class Objective(BaseModel):
    name: str
    direction: str  # "minimize" | "maximize"
    weight: float


class Candidate(BaseModel):
    id: str
    scores: dict[str, float]  # objective name -> raw score


class RankingEntry(BaseModel):
    id: str
    score: float


class Ranking(BaseModel):
    entries: list[RankingEntry]  # sorted descending by score

    @property
    def best(self) -> RankingEntry | None:
        return self.entries[0] if self.entries else None
