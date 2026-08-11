import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


class DecisionRecord(SQLModel, table=True):
    __tablename__ = "decisions"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    decision_kind: str
    request_json: str
    response_json: str
    policy_version: str


class ScoreCacheRecord(SQLModel, table=True):
    __tablename__ = "score_cache"

    scenario_id: str = Field(primary_key=True)
    candidate_id: str = Field(primary_key=True)
    cost_usd: float
    quality: float
    latency_ms: float
    business_risk: float
    raw_response: str
    judge_raw: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ExperimentRun(SQLModel, table=True):
    __tablename__ = "experiment_runs"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    baseline: str
    scenario_dataset_version: str


class ExperimentResult(SQLModel, table=True):
    __tablename__ = "experiment_results"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    run_id: str = Field(foreign_key="experiment_runs.id")
    scenario_id: str
    selected_candidate_id: str | None = None
    policy_violation: bool
    cost_usd: float
    quality_score: float
    latency_ms: float
    status: str
