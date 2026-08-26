from unittest.mock import patch

from sqlmodel import select

from core.experiment.deepseek_client import CompletionResult
from core.experiment.harness import run_experiment, run_scenario_for_baseline, warmup_ollama_candidates
from core.experiment.judge import JudgeResult
from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun

AHP_WEIGHTS = {"cost": 0.25, "quality": 0.5, "latency": 0.15, "business_risk": 0.1}

SCENARIO = {
    "scenario_id": "s-001",
    "task": {"type": "summarization", "data_classification": "public"},
    "prompt": "Ringkas teks berikut.",
    "real_candidates": ["deepseek-v4-flash"],
    "synthetic_candidates": [
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}},
    ],
    "org": {"budget_remaining_usd": 1.0, "region": "us"},
    "policy_set": "default",
}

CANDIDATES_CONFIG = {
    "models_by_id": {
        "deepseek-v4-flash": {"id": "deepseek-v4-flash", "vendor": "deepseek", "business_risk": 0.25},
    }
}

PREFILLED_INFOS = [
    {"id": "deepseek-v4-flash", "vendor": "deepseek", "kind": "model", "cost_per_1k_tokens": 0.001,
     "scores": {"cost": 0.001, "quality": 0.8, "latency": 400.0, "business_risk": 0.25}, "status": "ok"},
    {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
     "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}, "status": "ok"},
]


def test_run_scenario_for_baseline_always_cheap_picks_local_llama():
    outcome = run_scenario_for_baseline("always_cheap", SCENARIO, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "local-llama"
    assert outcome["status"] == "ok"


def test_run_scenario_for_baseline_made_excludes_denied_candidate_for_confidential():
    # redacted: True — external_vendor.rego now denies deepseek too for
    # unredacted confidential/restricted data (the whole point of the
    # confidentiality pipeline); this test's actual concern is that
    # compliance.rego still excludes the untrusted unverified-oss vendor
    # even once the data is safe to send to deepseek.
    confidential_scenario = {
        **SCENARIO,
        "task": {"type": "summarization", "data_classification": "confidential", "redacted": True},
    }
    outcome = run_scenario_for_baseline("made", confidential_scenario, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "deepseek-v4-flash"
    assert outcome["policy_violation"] is False


def test_run_scenario_for_baseline_always_cheap_flagged_as_violation_for_confidential():
    confidential_scenario = {**SCENARIO, "task": {"type": "summarization", "data_classification": "confidential"}}
    outcome = run_scenario_for_baseline("always_cheap", confidential_scenario, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "local-llama"
    assert outcome["policy_violation"] is True


def test_run_experiment_persists_results_for_all_baselines(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = JudgeResult(score=0.8, raw_text="8")

        with get_session(engine) as session:
            run_ids = run_experiment(
                session, [SCENARIO], CANDIDATES_CONFIG, AHP_WEIGHTS, scenario_dataset_version="test-v1",
            )

    assert set(run_ids.keys()) == {"made", "ahp_saw", "always_strong", "always_cheap", "no_policy"}

    with get_session(engine) as session:
        runs = session.exec(select(ExperimentRun)).all()
        results = session.exec(select(ExperimentResult)).all()

    assert len(runs) == 5
    assert len(results) == 5
    assert all(r.scenario_id == "s-001" for r in results)


def test_run_scenario_for_baseline_marks_failed_when_a_real_candidate_failed():
    # Even though local-llama (synthetic) succeeded, a failed real candidate
    # must not let the scenario silently proceed using only synthetic data.
    infos_with_failed_real = [
        {"id": "deepseek-v4-flash", "status": "failed", "error": "boom"},
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}, "status": "ok"},
    ]

    outcome = run_scenario_for_baseline("always_cheap", SCENARIO, infos_with_failed_real, AHP_WEIGHTS)

    assert outcome["status"] == "failed"
    assert outcome["selected_candidate_id"] is None


def test_run_scenario_for_baseline_made_records_no_selection_when_all_candidates_denied():
    # confidential data_classification denies local-llama (unverified vendor)
    # and a very tight budget denies both real candidates on cost - MADE
    # abstains entirely. This must be distinguished from a normal "ok" pick.
    all_denied_scenario = {
        **SCENARIO,
        "task": {"type": "summarization", "data_classification": "confidential"},
        "org": {"budget_remaining_usd": 0.0005, "region": "us"},
    }

    outcome = run_scenario_for_baseline("made", all_denied_scenario, PREFILLED_INFOS, AHP_WEIGHTS)

    assert outcome["selected_candidate_id"] is None
    assert outcome["status"] == "no_selection"
    assert outcome["cost_usd"] == 0.0
    assert outcome["quality_score"] == 0.0
    assert outcome["latency_ms"] == 0.0


def test_run_experiment_marks_scenario_failed_when_real_candidate_fails(tmp_path):
    # End-to-end: a real DeepSeek candidate failure must be recorded as
    # status "failed" for every baseline, not silently scored using only
    # the always-succeeding synthetic local-llama candidate.
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete:
        mock_complete.side_effect = RuntimeError("upstream outage")

        with get_session(engine) as session:
            run_ids = run_experiment(
                session, [SCENARIO], CANDIDATES_CONFIG, AHP_WEIGHTS, scenario_dataset_version="test-v1",
            )

    with get_session(engine) as session:
        results = session.exec(select(ExperimentResult)).all()

    assert len(results) == 5
    assert all(r.status == "failed" for r in results)
    assert set(run_ids.keys()) == {"made", "ahp_saw", "always_strong", "always_cheap", "no_policy"}


def test_warmup_ollama_candidates_calls_ollama_for_each_ollama_provider_model():
    candidates_config = {
        "models_by_id": {
            "deepseek-v4-flash": {"id": "deepseek-v4-flash", "provider": "deepseek"},
            "gemma4-12b": {"id": "gemma4-12b", "provider": "ollama", "model_name": "gemma4:12b"},
        }
    }

    with patch("core.experiment.harness.ollama_complete") as mock_ollama, \
         patch("core.experiment.harness.complete") as mock_deepseek:
        mock_ollama.return_value = CompletionResult(text="ok", cost_usd=0.0, latency_ms=1000.0)

        warmup_ollama_candidates(candidates_config)

    assert mock_ollama.call_count == 1
    mock_ollama.assert_called_with("gemma4:12b", "warmup")
    assert mock_deepseek.call_count == 0


def test_warmup_ollama_candidates_does_not_raise_on_failure():
    candidates_config = {"models_by_id": {"gemma4-12b": {"id": "gemma4-12b", "provider": "ollama"}}}

    with patch("core.experiment.harness.ollama_complete") as mock_ollama:
        mock_ollama.side_effect = Exception("connection refused")

        warmup_ollama_candidates(candidates_config)  # must not raise


def test_run_experiment_calls_warmup_once_before_scenarios(tmp_path):
    engine = make_engine(tmp_path / "test.db")
    call_order = []

    def fake_warmup(candidates_config):
        call_order.append("warmup")

    def fake_complete(candidate_id, prompt):
        call_order.append("complete")
        return CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)

    def fake_judge(prompt, response_text):
        call_order.append("judge")
        return JudgeResult(score=0.8, raw_text="8")

    with patch("core.experiment.harness.warmup_ollama_candidates", side_effect=fake_warmup) as mock_warmup, \
         patch("core.experiment.harness.complete", side_effect=fake_complete), \
         patch("core.experiment.harness.judge_quality", side_effect=fake_judge):

        with get_session(engine) as session:
            run_experiment(session, [SCENARIO], CANDIDATES_CONFIG, AHP_WEIGHTS, scenario_dataset_version="test-v1")

    mock_warmup.assert_called_once_with(CANDIDATES_CONFIG)
    assert len(call_order) > 0, "No calls were recorded"
    assert call_order[0] == "warmup", f"First call should be warmup, but got {call_order[0]}"
    assert "complete" in call_order, "complete should have been called during scenario scoring"
    assert call_order.index("warmup") < call_order.index("complete"), \
        f"warmup must be called before complete, but order was: {call_order}"
