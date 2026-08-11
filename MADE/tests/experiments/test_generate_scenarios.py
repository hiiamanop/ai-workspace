from experiments.generate_scenarios import generate_scenarios


def test_generates_requested_count_with_valid_schema():
    scenarios = generate_scenarios(count=120, seed=42)

    assert len(scenarios) == 120
    ids = [s["scenario_id"] for s in scenarios]
    assert len(ids) == len(set(ids))

    for s in scenarios:
        assert s["task"]["type"] and s["task"]["data_classification"]
        assert isinstance(s["prompt"], str) and len(s["prompt"]) > 0
        assert s["real_candidates"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
        assert len(s["synthetic_candidates"]) == 1
        synth = s["synthetic_candidates"][0]
        assert set(synth["scores"].keys()) == {"cost", "quality", "latency", "business_risk"}
        assert "budget_remaining_usd" in s["org"] and "region" in s["org"]
        assert s["policy_set"] == "default"


def test_deterministic_with_same_seed():
    first = generate_scenarios(count=50, seed=7)
    second = generate_scenarios(count=50, seed=7)
    assert first == second


def test_different_seed_produces_different_order():
    first = generate_scenarios(count=50, seed=1)
    second = generate_scenarios(count=50, seed=2)
    assert [s["scenario_id"] for s in first] != [] and first != second


def test_generate_scenarios_accepts_custom_real_candidates():
    scenarios = generate_scenarios(count=10, seed=1, real_candidates=["deepseek-v4-flash", "deepseek-v4-pro", "gemma4-12b"])

    assert len(scenarios) == 10
    for s in scenarios:
        assert s["real_candidates"] == ["deepseek-v4-flash", "deepseek-v4-pro", "gemma4-12b"]


def test_generate_scenarios_default_real_candidates_unchanged():
    scenarios = generate_scenarios(count=10, seed=1)

    for s in scenarios:
        assert s["real_candidates"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
