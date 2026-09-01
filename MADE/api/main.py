import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from sqlmodel import select

from api.schemas import (
    BaselineSummaryOut,
    ClassifyRequest,
    ClassifyResponse,
    DecideRequest,
    DecideResponse,
    ExcludedOut,
    ExperimentRunRequest,
    ExperimentRunResponse,
    PolicyDeployRequest,
    RankingEntryOut,
    RedactRequest,
    RedactResponse,
    RestoreRequest,
    RestoreResponse,
)
import core.complexity as complexity
from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.epm.loader import load_epm_manifest
from core.epm.opa_client import OpaEvaluationError
from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary
from core.privacy import pseudonymizer
from core.privacy.detectors import warm_up_ner
from storage.db import get_session, make_engine
from storage.models import AuditRecord, DecisionRecord

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


@app.on_event("startup")
def warm_up_complexity_classifier() -> None:
    complexity.warm_up()


@app.on_event("startup")
def warm_up_ner_model() -> None:
    warm_up_ner()


@app.post("/classify", response_model=ClassifyResponse)
def post_classify(request: ClassifyRequest) -> ClassifyResponse:
    result = complexity.classify_task(request.text)
    return ClassifyResponse(**result)


@app.get("/candidates")
def get_candidates() -> dict:
    """Return the reviewed model registry consumed by the Open WebUI Auto pipe."""
    config = load_candidates_config(CONFIG_DIR / "candidates.yaml")
    return {"models": list(config["raw"].get("models", []))}


@app.post("/privacy/redact", response_model=RedactResponse)
def post_privacy_redact(request: RedactRequest) -> RedactResponse:
    with get_session(get_engine()) as session:
        redacted_text, redaction_count = pseudonymizer.redact(request.text, request.org_id, session)
    return RedactResponse(redacted_text=redacted_text, redaction_count=redaction_count)


@app.post("/privacy/restore", response_model=RestoreResponse)
def post_privacy_restore(request: RestoreRequest) -> RestoreResponse:
    with get_session(get_engine()) as session:
        restored_text = pseudonymizer.restore(request.text, request.org_id, session)
    return RestoreResponse(restored_text=restored_text)


@app.post("/decide", response_model=DecideResponse)
def post_decide(request: DecideRequest) -> DecideResponse:
    started = time.perf_counter()
    correlation_id = request.correlation_id or str(uuid.uuid4())
    task = Task(
        type=request.task.type,
        data_classification=request.task.data_classification,
        estimated_context_tokens=request.task.estimated_context_tokens,
        complexity=request.task.complexity,
        redacted=request.task.redacted,
        intent=request.task.intent,
        needs_tools=request.task.needs_tools,
        requested_tools=request.task.requested_tools,
        operation=request.task.operation,
        approval_granted=request.task.approval_granted,
        run_id=request.task.run_id,
        max_steps=request.task.max_steps,
    )
    org = Org(
        budget_remaining_usd=request.org.budget_remaining_usd,
        region=request.org.region,
        organization_id=request.org.organization_id,
        actor_id=request.org.actor_id,
    )
    candidates = [
        DecisionCandidate(
            id=c.id, vendor=c.vendor, kind=c.kind,
            cost_per_1k_tokens=c.cost_per_1k_tokens, scores=c.scores,
            context_window_tokens=c.context_window_tokens,
            capabilities=c.capabilities,
            operation=c.operation,
            connector_id=c.connector_id,
        )
        for c in request.candidates
    ]

    try:
        result = decide(task=task, org=org, candidates=candidates, policies_dir=POLICIES_ROOT)
    except OpaEvaluationError as exc:
        # Fail closed: an unavailable policy engine must never authorize work.
        with get_session(get_engine()) as session:
            session.add(AuditRecord(
                correlation_id=correlation_id, event_type="policy_decision",
                actor_id=request.org.actor_id, organization_id=request.org.organization_id,
                decision_kind=request.decision_kind, latency_ms=(time.perf_counter() - started) * 1000,
                outcome="policy_unavailable", metadata_json=json.dumps({"policy_set": request.policy_set}),
            ))
            session.commit()
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
        correlation_id=correlation_id,
    )

    with get_session(get_engine()) as session:
        session.add(DecisionRecord(
            id=decision_id,
            decision_kind=request.decision_kind,
            request_json=request.model_dump_json(),
            response_json=response.model_dump_json(),
            policy_version=policy_version,
        ))
        session.add(AuditRecord(
            correlation_id=correlation_id, event_type="policy_decision",
            actor_id=request.org.actor_id, organization_id=request.org.organization_id,
            decision_id=decision_id, policy_version=policy_version,
            decision_kind=request.decision_kind,
            latency_ms=(time.perf_counter() - started) * 1000,
            outcome=("approved" if response.selected_candidate_id else "denied"),
            metadata_json=json.dumps({
                "selected_candidate_id": response.selected_candidate_id,
                "requires_human_approval": response.requires_human_approval,
                "excluded_count": len(response.excluded),
                "policy_set": request.policy_set,
            }),
        ))
        session.commit()

    return response


@app.get("/audit/events")
def get_audit_events(
    actor_id: str | None = None,
    organization_id: str | None = None,
    correlation_id: str | None = None,
    limit: int = 100,
) -> dict:
    """Return safe audit metadata; access control belongs at the API gateway."""
    limit = max(1, min(limit, 500))
    with get_session(get_engine()) as session:
        query = select(AuditRecord)
        if actor_id:
            query = query.where(AuditRecord.actor_id == actor_id)
        if organization_id:
            query = query.where(AuditRecord.organization_id == organization_id)
        if correlation_id:
            query = query.where(AuditRecord.correlation_id == correlation_id)
        query = query.order_by(AuditRecord.created_at.desc()).limit(limit)
        events = session.exec(query).all()
    return {"events": [
        {**event.model_dump(exclude={"metadata_json"}), "metadata": json.loads(event.metadata_json)}
        for event in events
    ]}


# Policy ids become .rego filenames under policies/hard/: keep them
# URL-safe and traversal-proof; *_test ids would be misread as test files.
POLICY_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")


@app.post("/api/policies/deploy")
def deploy_policy(request: PolicyDeployRequest) -> dict:
    """Validate a Rego policy against OPA and atomically install it.

    The new file is picked up by the next /decide call (policies are read
    from disk per evaluation), so a deployed policy is live immediately.
    """
    if not POLICY_ID_RE.match(request.policy_id) or request.policy_id.endswith("_test"):
        raise HTTPException(status_code=400, detail=f"invalid policy_id '{request.policy_id}'")

    # Validate with OPA before touching the policies directory. The new file
    # must be checked together with the EXISTING policy set — an isolated
    # check can't see cross-file conflicts (e.g. a second `default allow`
    # next to base.rego breaks every /decide call; the C1 review caught this).
    hard_dir = POLICIES_ROOT / "hard"
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, f"{request.policy_id}.rego").write_text(request.rego_content)
        if hard_dir.exists():
            for existing in hard_dir.glob("*.rego"):
                if existing.name != f"{request.policy_id}.rego":
                    shutil.copy2(existing, Path(tmp, existing.name))
        try:
            proc = subprocess.run(
                ["opa", "check", "--format", "json", tmp],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=503, detail=f"policy engine unavailable: {exc}") from exc

        if proc.returncode != 0:
            try:
                errors = json.loads(proc.stdout).get("errors", [])
                msg = "; ".join(
                    f"{e.get('file')}:{e.get('location', {}).get('row')}: {e.get('message')}" for e in errors
                )
            except Exception:
                msg = proc.stderr.strip() or proc.stdout.strip()
            raise HTTPException(status_code=400, detail=f"rego invalid: {msg}")

    hard_dir.mkdir(parents=True, exist_ok=True)
    target = hard_dir / f"{request.policy_id}.rego"
    tmp_target = target.with_suffix(".rego.tmp")
    tmp_target.write_text(request.rego_content)
    os.replace(tmp_target, target)

    return {"policy_id": request.policy_id, "status": "deployed"}


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
