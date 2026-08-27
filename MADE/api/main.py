import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response

from api.schemas import (
    BaselineSummaryOut,
    ClassifyRequest,
    ClassifyResponse,
    DecideRequest,
    DecideResponse,
    ExcludedOut,
    EntityMappingOut,
    EntityMappingUpdate,
    ExperimentRunRequest,
    ExperimentRunResponse,
    PolicyDeployRequest,
    PrivacyClassifyRequest,
    PrivacyClassifyResponse,
    RankingEntryOut,
    RedactionLeakOut,
    RedactRequest,
    RedactResponse,
    RestoreRequest,
    RestoreResponse,
)
import core.complexity as complexity
from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.privacy import classifier
from core.epm.loader import load_epm_manifest
from core.epm.opa_client import OpaEvaluationError
from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary
from core.privacy import pseudonymizer
from core.privacy.detectors import warm_up_ner
from sqlmodel import select

from storage.db import get_session, make_engine
from storage.models import DecisionRecord, RedactionLeak

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
    complexity_level, label, score = complexity.classify(request.text)
    return ClassifyResponse(complexity=complexity_level, label=label, score=score)


@app.post("/privacy/classify", response_model=PrivacyClassifyResponse)
def post_privacy_classify(request: PrivacyClassifyRequest) -> PrivacyClassifyResponse:
    with get_session(get_engine()) as session:
        result = classifier.classify(request.text, request.org_id, session)
    return PrivacyClassifyResponse(
        classification=result.classification,
        confidence=result.confidence,
        source=result.source,
        signals=result.signals,
    )


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


@app.get("/privacy/mappings", response_model=list[EntityMappingOut])
def get_privacy_mappings(org_id: str, limit: int = 100, offset: int = 0) -> list[EntityMappingOut]:
    with get_session(get_engine()) as session:
        pairs = pseudonymizer.list_mappings(session, org_id, limit=limit, offset=offset)
        return [
            EntityMappingOut(
                id=row.id,
                entity_type=row.entity_type,
                placeholder=row.placeholder,
                original_value=original,
                created_at=row.created_at.isoformat(),
            )
            for row, original in pairs
        ]


@app.patch("/privacy/mappings/{mapping_id}", response_model=EntityMappingOut)
def patch_privacy_mapping(mapping_id: str, org_id: str, body: EntityMappingUpdate) -> EntityMappingOut:
    with get_session(get_engine()) as session:
        try:
            updated = pseudonymizer.update_mapping(
                session,
                org_id,
                mapping_id,
                original_value=body.original_value,
                placeholder=body.placeholder,
            )
        except pseudonymizer.MappingConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="mapping not found")
        row, value = updated
        return EntityMappingOut(
            id=row.id,
            entity_type=row.entity_type,
            placeholder=row.placeholder,
            original_value=value,
            created_at=row.created_at.isoformat(),
        )


@app.delete("/privacy/mappings/{mapping_id}", status_code=204)
def delete_privacy_mapping(mapping_id: str, org_id: str) -> Response:
    with get_session(get_engine()) as session:
        if not pseudonymizer.delete_mapping(session, org_id, mapping_id):
            raise HTTPException(status_code=404, detail="mapping not found")
    return Response(status_code=204)


@app.get("/privacy/leaks", response_model=list[RedactionLeakOut])
def get_privacy_leaks(org_id: str, limit: int = 100, offset: int = 0) -> list[RedactionLeakOut]:
    with get_session(get_engine()) as session:
        rows = session.exec(
            select(RedactionLeak)
            .where(RedactionLeak.org_id == org_id)
            .order_by(RedactionLeak.created_at.desc())
            .limit(min(limit, 500))
            .offset(offset)
        ).all()
    return [
        RedactionLeakOut(
            id=r.id,
            entity_types=r.entity_types.split(",") if r.entity_types else [],
            span_count=r.span_count,
            context_hash=r.context_hash,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]


@app.post("/decide", response_model=DecideResponse)
def post_decide(request: DecideRequest) -> DecideResponse:
    task = Task(
        type=request.task.type,
        data_classification=request.task.data_classification,
        estimated_context_tokens=request.task.estimated_context_tokens,
        complexity=request.task.complexity,
        redacted=request.task.redacted,
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
