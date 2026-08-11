import csv

from experiments.analyze_results import load_results, summarize


def _write_csv(tmp_path, rows):
    path = tmp_path / "results.csv"
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "baseline", "run_id", "scenario_id", "selected_candidate_id",
            "policy_violation", "cost_usd", "quality_score", "latency_ms", "status",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def test_load_results_groups_by_baseline(tmp_path):
    path = _write_csv(tmp_path, [
        {"baseline": "made", "run_id": "r1", "scenario_id": "s-1", "selected_candidate_id": "a",
         "policy_violation": "False", "cost_usd": "0.001", "quality_score": "0.8",
         "latency_ms": "200", "status": "ok"},
        {"baseline": "always_cheap", "run_id": "r2", "scenario_id": "s-1", "selected_candidate_id": "b",
         "policy_violation": "True", "cost_usd": "0.0", "quality_score": "0.5",
         "latency_ms": "2000", "status": "ok"},
    ])

    by_baseline = load_results(path)

    assert set(by_baseline.keys()) == {"made", "always_cheap"}
    assert len(by_baseline["made"]) == 1


def test_summarize_computes_violation_rate_and_means():
    rows = [
        {"policy_violation": "True", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "100", "status": "ok"},
        {"policy_violation": "False", "cost_usd": "0.002", "quality_score": "0.9", "latency_ms": "300", "status": "ok"},
    ]

    summary = summarize(rows)

    assert summary["n"] == 2
    assert summary["policy_violation_rate"] == 0.5
    assert summary["mean_cost_usd"] == 0.001
    assert summary["mean_quality"] == 0.7


def test_summarize_excludes_failed_rows():
    rows = [
        {"policy_violation": "False", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"},
        {"policy_violation": "False", "cost_usd": "0", "quality_score": "0", "latency_ms": "0", "status": "failed"},
    ]

    summary = summarize(rows)

    assert summary["n"] == 1
    assert summary["n_failed"] == 1


def test_summarize_excludes_no_selection_rows_and_counts_separately():
    # A "no_selection" row (MADE abstained) must not be averaged into the
    # means, and must be counted separately from n_failed.
    rows = [
        {"policy_violation": "False", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"},
        {"policy_violation": "False", "cost_usd": "0", "quality_score": "0", "latency_ms": "0", "status": "no_selection"},
        {"policy_violation": "False", "cost_usd": "0", "quality_score": "0", "latency_ms": "0", "status": "failed"},
    ]

    summary = summarize(rows)

    assert summary["n"] == 1
    assert summary["n_failed"] == 1
    assert summary["n_no_selection"] == 1
    assert summary["mean_quality"] == 0.8
