from experiments.statistical_tests import compare_baseline, paired_values


def test_paired_values_matches_by_scenario_id():
    by_baseline = {
        "made": [
            {"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.9", "latency_ms": "200", "status": "ok"},
            {"scenario_id": "s-2", "cost_usd": "0.002", "quality_score": "0.8", "latency_ms": "300", "status": "ok"},
        ],
        "always_cheap": [
            {"scenario_id": "s-1", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "2000", "status": "ok"},
            {"scenario_id": "s-2", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "2000", "status": "ok"},
        ],
    }

    made_values, other_values = paired_values(by_baseline, "always_cheap", "quality_score")

    assert made_values == [0.9, 0.8]
    assert other_values == [0.5, 0.5]


def test_compare_baseline_returns_p_value_for_each_metric():
    by_baseline = {
        "made": [
            {"scenario_id": f"s-{i}", "cost_usd": "0.001", "quality_score": str(0.9 - i * 0.01),
             "latency_ms": "200", "status": "ok"}
            for i in range(10)
        ],
        "always_cheap": [
            {"scenario_id": f"s-{i}", "cost_usd": "0.0", "quality_score": str(0.5 + i * 0.01),
             "latency_ms": "2000", "status": "ok"}
            for i in range(10)
        ],
    }

    comparison = compare_baseline(by_baseline, "always_cheap")

    assert comparison["baseline"] == "always_cheap"
    assert comparison["quality_score"]["n"] == 10
    assert comparison["quality_score"]["p_value"] is not None


def test_compare_baseline_handles_identical_values_without_crashing():
    by_baseline = {
        "made": [{"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"}],
        "always_cheap": [{"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"}],
    }

    comparison = compare_baseline(by_baseline, "always_cheap")

    assert comparison["quality_score"]["p_value"] is None
