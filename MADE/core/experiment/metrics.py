import csv
from pathlib import Path

from sqlmodel import Session, select

from storage.models import ExperimentResult


def compute_baseline_summary(session: Session, run_id: str) -> dict:
    results = session.exec(
        select(ExperimentResult).where(ExperimentResult.run_id == run_id)
    ).all()
    ok_results = [r for r in results if r.status == "ok"]
    n_failed = sum(1 for r in results if r.status == "failed")
    n_no_selection = sum(1 for r in results if r.status == "no_selection")

    if not ok_results:
        return {
            "run_id": run_id, "n_scenarios": 0, "n_failed": n_failed, "n_no_selection": n_no_selection,
            "policy_violation_rate": None, "mean_cost_usd": None,
            "mean_quality": None, "mean_latency_ms": None,
        }

    n = len(ok_results)
    violations = sum(1 for r in ok_results if r.policy_violation)

    return {
        "run_id": run_id,
        "n_scenarios": n,
        "n_failed": n_failed,
        "n_no_selection": n_no_selection,
        "policy_violation_rate": violations / n,
        "mean_cost_usd": sum(r.cost_usd for r in ok_results) / n,
        "mean_quality": sum(r.quality_score for r in ok_results) / n,
        "mean_latency_ms": sum(r.latency_ms for r in ok_results) / n,
    }


def export_results_csv(session: Session, run_ids: dict[str, str], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "baseline", "run_id", "scenario_id", "selected_candidate_id",
            "policy_violation", "cost_usd", "quality_score", "latency_ms", "status",
        ])
        for baseline, run_id in run_ids.items():
            results = session.exec(
                select(ExperimentResult).where(ExperimentResult.run_id == run_id)
            ).all()
            for r in results:
                writer.writerow([
                    baseline, run_id, r.scenario_id, r.selected_candidate_id,
                    r.policy_violation, r.cost_usd, r.quality_score, r.latency_ms, r.status,
                ])
