import csv

from core.experiment.metrics import compute_baseline_summary, export_results_csv
from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun


def _seed_run(session, baseline, results):
    run = ExperimentRun(baseline=baseline, scenario_dataset_version="test-v1")
    session.add(run)
    session.commit()
    session.refresh(run)
    for r in results:
        session.add(ExperimentResult(run_id=run.id, **r))
    session.commit()
    return run.id


def test_compute_baseline_summary_calculates_violation_rate_and_means(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "always_cheap", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": True,
             "cost_usd": 0.0, "quality_score": 0.5, "latency_ms": 100.0, "status": "ok"},
            {"scenario_id": "s-2", "selected_candidate_id": "b", "policy_violation": False,
             "cost_usd": 0.002, "quality_score": 0.9, "latency_ms": 300.0, "status": "ok"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 2
    assert summary["policy_violation_rate"] == 0.5
    assert summary["mean_cost_usd"] == 0.001
    assert summary["mean_quality"] == 0.7


def test_compute_baseline_summary_excludes_failed_scenarios(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": False,
             "cost_usd": 0.001, "quality_score": 0.8, "latency_ms": 200.0, "status": "ok"},
            {"scenario_id": "s-2", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 1
    assert summary["n_failed"] == 1


def test_compute_baseline_summary_returns_none_means_when_all_failed(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 0
    assert summary["policy_violation_rate"] is None


def test_compute_baseline_summary_excludes_no_selection_and_counts_separately(tmp_path):
    # A "no_selection" row (MADE abstained - every candidate denied) must
    # not be averaged into mean_quality/mean_cost_usd/mean_latency_ms
    # alongside real "ok" selections, and must be counted separately from
    # n_failed.
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": False,
             "cost_usd": 0.001, "quality_score": 0.8, "latency_ms": 200.0, "status": "ok"},
            {"scenario_id": "s-2", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "no_selection"},
            {"scenario_id": "s-3", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 1
    assert summary["n_failed"] == 1
    assert summary["n_no_selection"] == 1
    assert summary["mean_quality"] == 0.8
    assert summary["mean_cost_usd"] == 0.001
    assert summary["mean_latency_ms"] == 200.0


def test_export_results_csv_writes_all_baselines(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": False,
             "cost_usd": 0.001, "quality_score": 0.8, "latency_ms": 200.0, "status": "ok"},
        ])

    output_path = tmp_path / "results.csv"
    with get_session(engine) as session:
        export_results_csv(session, {"made": run_id}, output_path)

    with output_path.open() as f:
        rows = list(csv.DictReader(f))

    assert len(rows) == 1
    assert rows[0]["baseline"] == "made"
    assert rows[0]["scenario_id"] == "s-1"
