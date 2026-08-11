import httpx
import pytest

from core.experiment.ollama_client import OllamaError, complete


class _MockResponse:
    def __init__(self, status_code, json_body, text=""):
        self.status_code = status_code
        self._json_body = json_body
        self.text = text or str(json_body)

    def json(self):
        return self._json_body


def test_complete_returns_zero_cost_and_real_latency(monkeypatch):
    def fake_post(url, json, timeout):
        return _MockResponse(200, {
            "choices": [{"message": {"content": "hello world"}}],
            "usage": {"total_tokens": 227},
        })

    monkeypatch.setattr(httpx, "post", fake_post)

    result = complete("gemma4:12b", "say hi")

    assert result.text == "hello world"
    assert result.cost_usd == 0.0
    assert result.latency_ms >= 0


def test_complete_retries_then_raises_on_persistent_failure(monkeypatch):
    call_count = {"n": 0}

    def fake_post(url, json, timeout):
        call_count["n"] += 1
        return _MockResponse(500, {}, text="server error")

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr("core.experiment.ollama_client.time.sleep", lambda seconds: None)

    with pytest.raises(OllamaError, match="failed after 3 attempts"):
        complete("gemma4:12b", "say hi")

    assert call_count["n"] == 3


def test_complete_uses_default_base_url_when_env_not_set(monkeypatch):
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    captured_url = {}

    def fake_post(url, json, timeout):
        captured_url["url"] = url
        return _MockResponse(200, {
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"total_tokens": 5},
        })

    monkeypatch.setattr(httpx, "post", fake_post)

    complete("gemma4:12b", "hi")

    assert captured_url["url"] == "http://localhost:11434/v1/chat/completions"


def test_complete_respects_ollama_base_url_env_override(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://192.168.1.50:11434")
    captured_url = {}

    def fake_post(url, json, timeout):
        captured_url["url"] = url
        return _MockResponse(200, {
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"total_tokens": 5},
        })

    monkeypatch.setattr(httpx, "post", fake_post)

    complete("gemma4:12b", "hi")

    assert captured_url["url"] == "http://192.168.1.50:11434/v1/chat/completions"
