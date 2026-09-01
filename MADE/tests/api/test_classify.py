from unittest.mock import patch

from fastapi.testclient import TestClient


def _client():
    import api.main as main_module
    return TestClient(main_module.app)


def test_classify_endpoint_returns_complexity_label_and_score():
    client = _client()

    with patch("api.main.complexity.classify", return_value=("high", "COMPLEX", 0.93)):
        response = client.post("/classify", json={"text": "prove P != NP"})

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "complexity": "high",
        "label": "COMPLEX",
        "score": 0.93,
        "intent": "general_question",
        "needs_tools": False,
        "tools": [],
        "confidence": 0.93,
    }
