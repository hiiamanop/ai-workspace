from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from core.epm.loader import load_epm_manifest
from core.epm.opa_client import evaluate_hard_constraints
from core.modm.models import Candidate
from core.modm.topsis import topsis
from core.modm.weighted_sum import weighted_sum


class Task(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]


class Org(BaseModel):
    budget_remaining_usd: float
    region: str


class DecisionCandidate(BaseModel):
    id: str
    vendor: str
    kind: Literal["model", "tool"]  # "model" | "tool"
    cost_per_1k_tokens: float
    scores: dict[str, float]


class ExcludedCandidate(BaseModel):
    id: str
    reason: str


class DecisionResult(BaseModel):
    selected_candidate_id: str | None
    requires_human_approval: bool
    ranking: list[dict]
    excluded: list[ExcludedCandidate]
    technique_used: str


_TECHNIQUES = {"weighted_sum": weighted_sum, "topsis": topsis}


def decide(
    task: Task,
    org: Org,
    candidates: list[DecisionCandidate],
    policies_dir: Path,
) -> DecisionResult:
    manifest_name = "epm-critical.yaml" if task.data_classification in ("confidential", "restricted") else "epm.yaml"
    manifest = load_epm_manifest(policies_dir / manifest_name)
    hard_dir = policies_dir / "hard"

    passing: list[DecisionCandidate] = []
    excluded: list[ExcludedCandidate] = []
    requires_human_approval = False

    for candidate in candidates:
        input_doc = {
            "task": task.model_dump(),
            "candidate": {
                "kind": candidate.kind,
                "id": candidate.id,
                "vendor": candidate.vendor,
                "cost_per_1k_tokens": candidate.cost_per_1k_tokens,
            },
            "org": org.model_dump(),
        }
        result = evaluate_hard_constraints(input_doc, hard_dir)

        if result["requires_human_approval"]:
            requires_human_approval = True

        if result["allow"]:
            passing.append(candidate)
        else:
            excluded.append(ExcludedCandidate(
                id=candidate.id,
                reason="; ".join(result["deny_reasons"]) or "denied by policy",
            ))

    if not passing:
        return DecisionResult(
            selected_candidate_id=None,
            requires_human_approval=requires_human_approval,
            ranking=[],
            excluded=excluded,
            technique_used=manifest.technique,
        )

    modm_candidates = [Candidate(id=c.id, scores=c.scores) for c in passing]
    ranking = _TECHNIQUES[manifest.technique](modm_candidates, manifest.objectives)

    return DecisionResult(
        selected_candidate_id=ranking.best.id if ranking.best else None,
        requires_human_approval=requires_human_approval,
        ranking=[{"id": e.id, "score": e.score} for e in ranking.entries],
        excluded=excluded,
        technique_used=manifest.technique,
    )
