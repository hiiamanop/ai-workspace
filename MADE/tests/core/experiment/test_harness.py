import json
from unittest.mock import patch

from core.experiment.deepseek_client import CompletionResult, DeepSeekError
from core.experiment.harness import build_candidate_infos, is_policy_violation, load_scenarios
from core.experiment.judge import JudgeResult
from core.experiment.ollama_client import OllamaError
from storage.db import get_session, make_engine

SCENARIO = {
    "scenario_id": "s-001",
    "task": {"type": "summarization", "data_classification": "public"},
    "prompt": "Ringkas teks berikut.",
    "real_candidates": ["deepseek-v4-flash"],
    "synthetic_candidates": [
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4}},
    ],
    "org": {"budget_remaining_usd": 1.0, "region": "us"},
    "policy_set": "default",
}

CANDIDATES_CONFIG = {
    "models_by_id": {
        "deepseek-v4-flash": {"id": "deepseek-v4-flash", "vendor": "deepseek", "business_risk": 0.25},
    }
}


def test_build_candidate_infos_calls_api_on_cache_miss(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan singkat", cost_usd=0.001, latency_ms=500.0)
        mock_judge.return_value = JudgeResult(score=0.8, raw_text="8")

        with get_session(engine) as session:
            infos = build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    assert mock_complete.call_count == 1
    real_info = next(i for i in infos if i["id"] == "deepseek-v4-flash")
    assert real_info["status"] == "ok"
    assert real_info["scores"]["quality"] == 0.8
    synth_info = next(i for i in infos if i["id"] == "local-llama")
    assert synth_info["scores"]["business_risk"] == 0.4


def test_build_candidate_infos_uses_cache_on_second_call(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = JudgeResult(score=0.7, raw_text="7")

        with get_session(engine) as session:
            build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

        with get_session(engine) as session:
            build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    assert mock_complete.call_count == 1


def test_build_candidate_infos_marks_failed_on_persistent_api_error(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete:
        mock_complete.side_effect = DeepSeekError("persistent failure")

        with get_session(engine) as session:
            infos = build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    real_info = next(i for i in infos if i["id"] == "deepseek-v4-flash")
    assert real_info["status"] == "failed"


def test_build_candidate_infos_marks_failed_on_non_deepseek_exception(tmp_path):
    # A malformed API response (missing "usage"/"content" keys), a JSON decode
    # error, or an httpx exception subclass not wrapped by DeepSeekError must
    # not propagate and abort the whole scenario/run - it should be recorded
    # as a failed candidate just like a DeepSeekError.
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete:
        mock_complete.side_effect = KeyError("usage")

        with get_session(engine) as session:
            infos = build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    real_info = next(i for i in infos if i["id"] == "deepseek-v4-flash")
    assert real_info["status"] == "failed"


def test_is_policy_violation_true_for_denied_candidate():
    denied_info = {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0}
    confidential_scenario = {**SCENARIO, "task": {"type": "summarization", "data_classification": "confidential"}}

    assert is_policy_violation(confidential_scenario, denied_info) is True


def test_is_policy_violation_false_for_compliant_candidate():
    allowed_info = {"id": "deepseek-v4-flash", "vendor": "deepseek", "kind": "model", "cost_per_1k_tokens": 0.001}

    assert is_policy_violation(SCENARIO, allowed_info) is False


def test_load_scenarios_parses_jsonl(tmp_path):
    scenarios_path = tmp_path / "v1.jsonl"
    scenarios_path.write_text(json.dumps(SCENARIO) + "\n")

    scenarios = load_scenarios(scenarios_path)

    assert len(scenarios) == 1
    assert scenarios[0]["scenario_id"] == "s-001"


def test_build_candidate_infos_dispatches_to_ollama_for_ollama_provider(tmp_path):
    engine = make_engine(tmp_path / "test.db")
    ollama_scenario = {
        "scenario_id": "s-100",
        "task": {"type": "summarization", "data_classification": "public"},
        "prompt": "Ringkas teks berikut.",
        "real_candidates": ["gemma4-12b"],
        "synthetic_candidates": [],
        "org": {"budget_remaining_usd": 1.0, "region": "us"},
        "policy_set": "default",
    }
    ollama_candidates_config = {
        "models_by_id": {
            "gemma4-12b": {
                "id": "gemma4-12b", "vendor": "ollama-local", "provider": "ollama",
                "business_risk": 0.1, "model_name": "gemma4:12b",
            },
        }
    }

    with patch("core.experiment.harness.ollama_complete") as mock_ollama, \
         patch("core.experiment.harness.complete") as mock_deepseek, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_ollama.return_value = CompletionResult(text="ringkasan lokal", cost_usd=0.0, latency_ms=2000.0)
        mock_judge.return_value = JudgeResult(score=0.75, raw_text="7.5")

        with get_session(engine) as session:
            infos = build_candidate_infos(ollama_scenario, session, ollama_candidates_config)

    assert mock_ollama.call_count == 1
    assert mock_deepseek.call_count == 0
    # The API must receive the model_name ("gemma4:12b"), not the internal
    # candidate id ("gemma4-12b") - Ollama's model tag uses a colon.
    assert mock_ollama.call_args[0][0] == "gemma4:12b"
    info = next(i for i in infos if i["id"] == "gemma4-12b")
    assert info["status"] == "ok"
    assert info["scores"]["cost"] == 0.0
    assert info["scores"]["quality"] == 0.75


def test_build_candidate_infos_uses_candidate_id_when_model_name_absent(tmp_path):
    # Backward compatibility: candidates without an explicit "model_name"
    # (e.g. existing DeepSeek entries) must still send candidate_id as the
    # literal model string to the provider API.
    engine = make_engine(tmp_path / "test.db")
    ollama_scenario = {
        "scenario_id": "s-102",
        "task": {"type": "summarization", "data_classification": "public"},
        "prompt": "Ringkas teks berikut.",
        "real_candidates": ["gemma4-12b"],
        "synthetic_candidates": [],
        "org": {"budget_remaining_usd": 1.0, "region": "us"},
        "policy_set": "default",
    }
    ollama_candidates_config = {
        "models_by_id": {
            "gemma4-12b": {"id": "gemma4-12b", "vendor": "ollama-local", "provider": "ollama", "business_risk": 0.1},
        }
    }

    with patch("core.experiment.harness.ollama_complete") as mock_ollama, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_ollama.return_value = CompletionResult(text="ringkasan lokal", cost_usd=0.0, latency_ms=2000.0)
        mock_judge.return_value = JudgeResult(score=0.75, raw_text="7.5")

        with get_session(engine) as session:
            infos = build_candidate_infos(ollama_scenario, session, ollama_candidates_config)

    assert mock_ollama.call_args[0][0] == "gemma4-12b"
    info = next(i for i in infos if i["id"] == "gemma4-12b")
    assert info["status"] == "ok"


def test_build_candidate_infos_dispatches_to_deepseek_when_provider_missing(tmp_path):
    # Backward compatibility: a candidate config entry without an explicit
    # "provider" key must still work, defaulting to the deepseek path.
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.ollama_complete") as mock_ollama, \
         patch("core.experiment.harness.complete") as mock_deepseek, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_deepseek.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = JudgeResult(score=0.8, raw_text="8")

        with get_session(engine) as session:
            build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    assert mock_deepseek.call_count == 1
    assert mock_ollama.call_count == 0


def test_build_candidate_infos_marks_failed_on_ollama_error(tmp_path):
    engine = make_engine(tmp_path / "test.db")
    ollama_scenario = {
        "scenario_id": "s-101",
        "task": {"type": "summarization", "data_classification": "public"},
        "prompt": "Ringkas teks berikut.",
        "real_candidates": ["gemma4-12b"],
        "synthetic_candidates": [],
        "org": {"budget_remaining_usd": 1.0, "region": "us"},
        "policy_set": "default",
    }
    ollama_candidates_config = {
        "models_by_id": {
            "gemma4-12b": {"id": "gemma4-12b", "vendor": "ollama-local", "provider": "ollama", "business_risk": 0.1},
        }
    }

    with patch("core.experiment.harness.ollama_complete") as mock_ollama:
        mock_ollama.side_effect = OllamaError("connection refused")

        with get_session(engine) as session:
            infos = build_candidate_infos(ollama_scenario, session, ollama_candidates_config)

    info = next(i for i in infos if i["id"] == "gemma4-12b")
    assert info["status"] == "failed"
