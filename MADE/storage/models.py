import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel, UniqueConstraint


class DecisionRecord(SQLModel, table=True):
    __tablename__ = "decisions"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    decision_kind: str
    request_json: str
    response_json: str
    policy_version: str


class AuditRecord(SQLModel, table=True):
    """Safe, queryable audit record; never stores prompts or credentials."""
    __tablename__ = "audit_events"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    correlation_id: str = Field(index=True)
    event_type: str = Field(index=True)
    actor_id: str = Field(index=True)
    organization_id: str = Field(index=True)
    decision_id: str | None = Field(default=None, index=True)
    policy_version: str | None = None
    decision_kind: str | None = None
    connector_id: str | None = None
    capability: str | None = None
    latency_ms: float | None = None
    outcome: str
    metadata_json: str = "{}"


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


class EntityMapping(SQLModel, table=True):
    __tablename__ = "entity_mappings"
    __table_args__ = (UniqueConstraint("org_id", "original_value_hash", name="uq_entity_mapping_org_hash"),)

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    org_id: str = Field(index=True)
    entity_type: str
    placeholder: str
    original_value_hash: str
    original_value_encrypted: str
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
