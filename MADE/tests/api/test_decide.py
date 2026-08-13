# tests/api/test_decide.py
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.epm.opa_client import OpaEvaluationError


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module
    main_module._engine = None
    return TestClient(main_module.app)


def test_decide_selects_a_candidate(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "summarization", "data_classification": "public"},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "gpt-4o", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.02,
                "scores": {"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            },
            {
                "id": "gpt-3.5", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.005,
                "scores": {"cost": 0.005, "quality": 0.6, "latency": 0.8, "business_risk": 0.2},
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] in {"gpt-4o", "gpt-3.5"}
    assert body["technique_used"] == "topsis"
    assert body["excluded"] == []


def test_decide_reports_exclusions_and_still_returns_200(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "summarization", "data_classification": "confidential"},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
                "scores": {"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4},
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] is None
    assert len(body["excluded"]) == 1


def test_decide_rejects_invalid_data_classification(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "summarization", "data_classification": "Confidential"},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "gpt-4o", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.02,
                "scores": {"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            },
        ],
    })

    assert response.status_code == 422


def test_decide_returns_503_when_policy_engine_unavailable(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    with patch("api.main.decide", side_effect=OpaEvaluationError("opa binary not found")):
        response = client.post("/decide", json={
            "task": {"type": "summarization", "data_classification": "public"},
            "decision_kind": "model_selection",
            "candidates": [
                {
                    "id": "gpt-4o", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.02,
                    "scores": {"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
                },
            ],
        })

    assert response.status_code == 503
    assert "policy engine unavailable" in response.json()["detail"]


def test_decide_excludes_candidate_with_insufficient_context_window(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 9000},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "gemma4:12b", "vendor": "ollama-local", "kind": "model", "cost_per_1k_tokens": 0.0,
                "scores": {"cost": 0.0, "quality": 0.75, "latency": 9000, "business_risk": 0.1},
                "context_window_tokens": 4096,
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] is None
    assert len(body["excluded"]) == 1
    assert "context:" in body["excluded"][0]["reason"]


def test_decide_accepts_complexity_field(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    response = client.post("/decide", json={
        "task": {
            "type": "chat",
            "data_classification": "internal",
            "estimated_context_tokens": 100,
            "complexity": "high",
        },
        "decision_kind": "model_selection",
        "candidates": [
            {"id": "a", "vendor": "v", "kind": "model", "cost_per_1k_tokens": 0.001, "scores": {"cost": 1.0, "quality": 0.5, "latency": 0.9, "business_risk": 0.9}},
        ],
    })
    assert response.status_code == 200
