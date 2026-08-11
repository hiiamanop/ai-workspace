import json
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.experiment.deepseek_client import CompletionResult
from core.experiment.judge import JudgeResult

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


def _client(tmp_path, monkeypatch, scenarios_dir: Path):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module
    main_module._engine = None
    monkeypatch.setattr(main_module, "SCENARIOS_DIR", scenarios_dir)
    return TestClient(main_module.app)


def test_post_experiment_run_returns_summary_for_all_baselines(tmp_path, monkeypatch):
    scenarios_dir = tmp_path / "scenarios"
    scenarios_dir.mkdir()
    (scenarios_dir / "test.jsonl").write_text(json.dumps(SCENARIO) + "\n")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge, \
         patch("core.experiment.harness.ollama_complete") as mock_ollama:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = JudgeResult(score=0.8, raw_text="8")
        mock_ollama.return_value = CompletionResult(text="ok", cost_usd=0.0, latency_ms=1000.0)

        client = _client(tmp_path, monkeypatch, scenarios_dir)
        response = client.post("/experiment/run", json={"scenario_dataset_version": "test"})

    assert response.status_code == 200
    body = response.json()
    assert set(body["summary"].keys()) == {"made", "ahp_saw", "always_strong", "always_cheap", "no_policy"}
    assert body["summary"]["made"]["n_scenarios"] == 1
