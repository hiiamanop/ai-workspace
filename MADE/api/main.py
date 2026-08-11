import os
import subprocess
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException

from api.schemas import (
    BaselineSummaryOut,
    DecideRequest,
    DecideResponse,
    ExcludedOut,
    ExperimentRunRequest,
    ExperimentRunResponse,
    RankingEntryOut,
)
from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.epm.loader import load_epm_manifest
from core.epm.opa_client import OpaEvaluationError
from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary
from storage.db import get_session, make_engine
from storage.models import DecisionRecord

POLICIES_ROOT = Path(__file__).resolve().parent.parent / "policies"
CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
EXPERIMENTS_DIR = Path(__file__).resolve().parent.parent / "experiments"
SCENARIOS_DIR = EXPERIMENTS_DIR / "scenarios"

app = FastAPI(title="MADE")

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        db_path = Path(os.environ.get("MADE_DB_PATH", str(Path(__file__).resolve().parent.parent / "made.db")))
        _engine = make_engine(db_path)
    return _engine


def _policy_version(policies_dir: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=policies_dir, capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            return f"epm.yaml@{result.stdout.strip()}"
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return "epm.yaml@unversioned"


@app.on_event("startup")
def validate_policies_on_startup() -> None:
    load_epm_manifest(POLICIES_ROOT / "epm.yaml")


@app.post("/decide", response_model=DecideResponse)
def post_decide(request: DecideRequest) -> DecideResponse:
    task = Task(
        type=request.task.type,
        data_classification=request.task.data_classification,
        estimated_context_tokens=request.task.estimated_context_tokens,
    )
    org = Org(budget_remaining_usd=request.org.budget_remaining_usd, region=request.org.region)
    candidates = [
        DecisionCandidate(
            id=c.id, vendor=c.vendor, kind=c.kind,
            cost_per_1k_tokens=c.cost_per_1k_tokens, scores=c.scores,
            context_window_tokens=c.context_window_tokens,
        )
        for c in request.candidates
    ]

    try:
        result = decide(task=task, org=org, candidates=candidates, policies_dir=POLICIES_ROOT)
    except OpaEvaluationError as exc:
        raise HTTPException(status_code=503, detail=f"policy engine unavailable: {exc}") from exc

    decision_id = str(uuid.uuid4())
    policy_version = _policy_version(POLICIES_ROOT)

    response = DecideResponse(
        decision_id=decision_id,
        selected_candidate_id=result.selected_candidate_id,
        requires_human_approval=result.requires_human_approval,
        ranking=[RankingEntryOut(**r) for r in result.ranking],
        excluded=[ExcludedOut(id=e.id, reason=e.reason) for e in result.excluded],
        technique_used=result.technique_used,
        policy_version=policy_version,
    )

    with get_session(get_engine()) as session:
        session.add(DecisionRecord(
            id=decision_id,
            decision_kind=request.decision_kind,
            request_json=request.model_dump_json(),
            response_json=response.model_dump_json(),
            policy_version=policy_version,
        ))
        session.commit()

    return response


@app.get("/policies/{policy_set}")
def get_policy(policy_set: str) -> dict:
    if policy_set != "default":
        raise HTTPException(status_code=404, detail=f"unknown policy_set '{policy_set}'")

    manifest = load_epm_manifest(POLICIES_ROOT / "epm.yaml")
    hard_files = sorted(
        p.name for p in (POLICIES_ROOT / "hard").glob("*.rego")
        if not p.name.endswith("_test.rego")
    )

    return {
        "policy_set": policy_set,
        "objectives": [o.model_dump() for o in manifest.objectives],
        "technique": manifest.technique,
        "hard_constraint_files": hard_files,
        "policy_version": _policy_version(POLICIES_ROOT),
    }


@app.post("/experiment/run", response_model=ExperimentRunResponse)
def post_experiment_run(request: ExperimentRunRequest) -> ExperimentRunResponse:
    scenarios_path = SCENARIOS_DIR / f"{request.scenario_dataset_version}.jsonl"
    scenarios = load_scenarios(scenarios_path)
    candidates_config = load_candidates_config(CONFIG_DIR / "candidates.yaml")
    ahp_weights = load_ahp_weights(EXPERIMENTS_DIR / "ahp_weights.yaml")

    with get_session(get_engine()) as session:
        run_ids = run_experiment(
            session, scenarios, candidates_config, ahp_weights, request.scenario_dataset_version,
        )
        summary = {
            baseline: BaselineSummaryOut(**compute_baseline_summary(session, run_id))
            for baseline, run_id in run_ids.items()
        }

    return ExperimentRunResponse(scenario_dataset_version=request.scenario_dataset_version, summary=summary)
