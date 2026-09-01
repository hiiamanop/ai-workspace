from typing import Literal

from pydantic import BaseModel


class TaskIn(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
    complexity: Literal["low", "medium", "high"] = "medium"
    # Set by a caller that ran the text through POST /privacy/redact first.
    # compliance.rego's external-vendor deny rule is the actual gate — this
    # flag is how a caller satisfies it, not a courtesy field it could skip.
    redacted: bool = False
    intent: str = "general_question"
    needs_tools: bool = False
    requested_tools: list[str] = []
    operation: Literal["read", "draft", "create", "update", "delete", "publish", "send", "deploy"] = "read"
    approval_granted: bool = False
    run_id: str | None = None
    max_steps: int = 20


class OrgIn(BaseModel):
    budget_remaining_usd: float = 1000.0
    region: str = "us"
    organization_id: str = "default"
    actor_id: str = "anonymous"


class CandidateIn(BaseModel):
    id: str
    vendor: str
    kind: Literal["model", "tool"]
    cost_per_1k_tokens: float
    scores: dict[str, float]
    context_window_tokens: int | None = None
    upstream_group: str | None = None
    capabilities: dict[str, bool] | None = None
    fallback: bool | None = None
    verified: bool | None = None
    operation: Literal["read", "draft", "create", "update", "delete", "publish", "send", "deploy"] | None = None
    connector_id: str | None = None


class DecideRequest(BaseModel):
    task: TaskIn
    org: OrgIn = OrgIn()
    decision_kind: Literal["model_selection", "tool_selection", "human_approval"]
    candidates: list[CandidateIn]
    policy_set: str = "default"
    correlation_id: str | None = None


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
    correlation_id: str | None = None


class ClassifyRequest(BaseModel):
    text: str


class ClassifyResponse(BaseModel):
    complexity: Literal["low", "medium", "high"]
    label: str
    score: float
    intent: str = "general_question"
    needs_tools: bool = False
    tools: list[str] = []
    confidence: float = 0.0


class RedactRequest(BaseModel):
    org_id: str
    text: str


class RedactResponse(BaseModel):
    redacted_text: str
    redaction_count: int


class RestoreRequest(BaseModel):
    org_id: str
    text: str


class RestoreResponse(BaseModel):
    restored_text: str


class PolicyDeployRequest(BaseModel):
    policy_id: str
    rego_content: str


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
