import json
import sys
from pathlib import Path

from sqlmodel import Session

from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.epm.opa_client import evaluate_hard_constraints
from core.experiment.baselines import (
    select_ahp_saw, select_always_cheap, select_always_strong, select_no_policy,
)
from core.experiment.deepseek_client import complete
from core.experiment.ollama_client import complete as ollama_complete
from core.experiment.judge import judge_quality
from core.experiment.score_cache import get_cached_score, put_score
from core.modm.models import Candidate
from storage.models import ExperimentResult, ExperimentRun

POLICIES_ROOT = Path(__file__).resolve().parent.parent.parent / "policies"


def load_scenarios(path: Path) -> list[dict]:
    scenarios = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                scenarios.append(json.loads(line))
    return scenarios


def build_candidate_infos(scenario: dict, session: Session, candidates_config: dict) -> list[dict]:
    infos: list[dict] = []

    for candidate_id in scenario["real_candidates"]:
        model_config = candidates_config["models_by_id"][candidate_id]
        cached = get_cached_score(session, scenario["scenario_id"], candidate_id)
        if cached is None:
            try:
                provider = model_config.get("provider", "deepseek")
                model_name = model_config.get("model_name", candidate_id)
                if provider == "deepseek":
                    completion = complete(model_name, scenario["prompt"])
                elif provider == "ollama":
                    completion = ollama_complete(model_name, scenario["prompt"])
                else:
                    raise ValueError(f"unknown provider {provider!r} for candidate {candidate_id!r}")
                judge_result = judge_quality(scenario["prompt"], completion.text)
            except Exception as exc:  # noqa: BLE001 - any failure here must not abort the run
                infos.append({"id": candidate_id, "status": "failed", "error": str(exc)})
                continue
            cached = put_score(
                session, scenario["scenario_id"], candidate_id,
                cost_usd=completion.cost_usd, quality=judge_result.score, latency_ms=completion.latency_ms,
                business_risk=model_config["business_risk"],
                raw_response=completion.text, judge_raw=judge_result.raw_text,
            )
        infos.append({
            "id": candidate_id,
            "vendor": model_config["vendor"],
            "kind": "model",
            "cost_per_1k_tokens": cached.cost_usd,
            "scores": {
                "cost": cached.cost_usd, "quality": cached.quality,
                "latency": cached.latency_ms, "business_risk": cached.business_risk,
            },
            "status": "ok",
        })

    for synth in scenario["synthetic_candidates"]:
        infos.append({
            "id": synth["id"],
            "vendor": synth["vendor"],
            "kind": synth["kind"],
            "cost_per_1k_tokens": synth["cost_per_1k_tokens"],
            "scores": dict(synth["scores"]),
            "status": "ok",
        })

    return infos


def is_policy_violation(scenario: dict, candidate_info: dict) -> bool:
    input_doc = {
        "task": scenario["task"],
        "candidate": {
            "kind": candidate_info["kind"],
            "id": candidate_info["id"],
            "vendor": candidate_info["vendor"],
            "cost_per_1k_tokens": candidate_info["cost_per_1k_tokens"],
        },
        "org": scenario["org"],
    }
    result = evaluate_hard_constraints(input_doc, POLICIES_ROOT / "hard")
    return not result["allow"]


BASELINES = ["made", "ahp_saw", "always_strong", "always_cheap", "no_policy"]


def _make_decision_candidates(infos: list[dict]) -> list[DecisionCandidate]:
    return [
        DecisionCandidate(
            id=i["id"], vendor=i["vendor"], kind=i["kind"],
            cost_per_1k_tokens=i["cost_per_1k_tokens"], scores=i["scores"],
        )
        for i in infos if i["status"] == "ok"
    ]


def _make_modm_candidates(infos: list[dict]) -> list[Candidate]:
    return [Candidate(id=i["id"], scores=i["scores"]) for i in infos if i["status"] == "ok"]


def run_scenario_for_baseline(
    baseline: str, scenario: dict, infos: list[dict], ahp_weights: dict[str, float],
) -> dict:
    ok_infos = [i for i in infos if i["status"] == "ok"]
    info_by_id = {i["id"]: i for i in ok_infos}

    real_candidate_ids = set(scenario["real_candidates"])
    any_real_candidate_failed = any(
        i["status"] == "failed" for i in infos if i["id"] in real_candidate_ids
    )

    if not ok_infos or any_real_candidate_failed:
        # A failed real candidate must not let the scenario silently proceed
        # (and get recorded as "ok") using only synthetic-candidate data.
        return {"selected_candidate_id": None, "policy_violation": False,
                "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"}

    if baseline == "made":
        task = Task(type=scenario["task"]["type"], data_classification=scenario["task"]["data_classification"])
        org = Org(budget_remaining_usd=scenario["org"]["budget_remaining_usd"], region=scenario["org"]["region"])
        result = decide(
            task=task, org=org, candidates=_make_decision_candidates(ok_infos), policies_dir=POLICIES_ROOT,
        )
        selected_id = result.selected_candidate_id
    else:
        modm_candidates = _make_modm_candidates(ok_infos)
        if baseline == "ahp_saw":
            selected_id = select_ahp_saw(modm_candidates, ahp_weights)
        elif baseline == "always_strong":
            selected_id = select_always_strong(modm_candidates)
        elif baseline == "always_cheap":
            selected_id = select_always_cheap(modm_candidates)
        elif baseline == "no_policy":
            selected_id = select_no_policy(modm_candidates)
        else:
            raise ValueError(f"unknown baseline {baseline!r}")

    if selected_id is None:
        # MADE (or another baseline) abstained: every candidate was denied
        # by policy. This is not a normal successful selection, and must not
        # be averaged into mean_quality/mean_cost_usd/mean_latency_ms alongside
        # real "ok" selections.
        return {"selected_candidate_id": None, "policy_violation": False,
                "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "no_selection"}

    selected_info = info_by_id[selected_id]
    violation = is_policy_violation(scenario, selected_info)

    return {
        "selected_candidate_id": selected_id,
        "policy_violation": violation,
        "cost_usd": selected_info["scores"]["cost"],
        "quality_score": selected_info["scores"]["quality"],
        "latency_ms": selected_info["scores"]["latency"],
        "status": "ok",
    }


def warmup_ollama_candidates(candidates_config: dict) -> None:
    for model_id, model_config in candidates_config["models_by_id"].items():
        if model_config.get("provider") == "ollama":
            try:
                ollama_complete(model_config.get("model_name", model_id), "warmup")
            except Exception as exc:  # noqa: BLE001 - warmup failure must not abort the run
                print(f"warning: warmup call to {model_id!r} failed: {exc}", file=sys.stderr)


def run_experiment(
    session: Session,
    scenarios: list[dict],
    candidates_config: dict,
    ahp_weights: dict[str, float],
    scenario_dataset_version: str,
) -> dict[str, str]:
    warmup_ollama_candidates(candidates_config)
    run_ids: dict[str, str] = {}
    for baseline in BASELINES:
        run = ExperimentRun(baseline=baseline, scenario_dataset_version=scenario_dataset_version)
        session.add(run)
        session.commit()
        session.refresh(run)
        run_ids[baseline] = run.id

    failed_outcome = {"selected_candidate_id": None, "policy_violation": False,
                       "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"}

    for scenario in scenarios:
        try:
            infos = build_candidate_infos(scenario, session, candidates_config)
            for baseline in BASELINES:
                outcome = run_scenario_for_baseline(baseline, scenario, infos, ahp_weights)
                session.add(ExperimentResult(
                    run_id=run_ids[baseline], scenario_id=scenario["scenario_id"], **outcome,
                ))
        except Exception as exc:  # noqa: BLE001 - one bad scenario must not abort the whole run
            print(
                f"warning: scenario {scenario.get('scenario_id')!r} failed unexpectedly, "
                f"marking as failed for all baselines: {exc}",
                file=sys.stderr,
            )
            for baseline in BASELINES:
                session.add(ExperimentResult(
                    run_id=run_ids[baseline], scenario_id=scenario["scenario_id"], **failed_outcome,
                ))
        session.commit()

    return run_ids
