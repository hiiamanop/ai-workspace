from typing import Literal

from pydantic import BaseModel


class TaskIn(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0


class OrgIn(BaseModel):
    budget_remaining_usd: float = 1000.0
    region: str = "us"


class CandidateIn(BaseModel):
    id: str
    vendor: str
    kind: Literal["model", "tool"]
    cost_per_1k_tokens: float
    scores: dict[str, float]
    context_window_tokens: int | None = None


class DecideRequest(BaseModel):
    task: TaskIn
    org: OrgIn = OrgIn()
    decision_kind: Literal["model_selection", "tool_selection", "human_approval"]
    candidates: list[CandidateIn]
    policy_set: str = "default"


class RankingEntryOut(BaseModel):
    id: str
    score: float


class ExcludedOut(BaseModel):
    id: str
    reason: str


class DecideResponse(BaseModel):
    decision_id: str
    selected_candidate_id: str | None
    requires_human_approval: bool
    ranking: list[RankingEntryOut]
    excluded: list[ExcludedOut]
    technique_used: str
    policy_version: str


class ExperimentRunRequest(BaseModel):
    scenario_dataset_version: str = "v1"


class BaselineSummaryOut(BaseModel):
    run_id: str
    n_scenarios: int
    n_failed: int
    policy_violation_rate: float | None
    mean_cost_usd: float | None
    mean_quality: float | None
    mean_latency_ms: float | None


class ExperimentRunResponse(BaseModel):
    scenario_dataset_version: str
    summary: dict[str, BaselineSummaryOut]
