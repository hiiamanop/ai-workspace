import httpx
import pytest

from core.experiment.deepseek_client import DeepSeekError, complete


class _MockResponse:
    def __init__(self, status_code, json_body, text=""):
        self.status_code = status_code
        self._json_body = json_body
        self.text = text or str(json_body)

    def json(self):
        return self._json_body


def test_complete_returns_cost_and_latency_on_success(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_post(url, headers, json, timeout):
        return _MockResponse(200, {
            "choices": [{"message": {"content": "hello world"}}],
            "usage": {"total_tokens": 1000},
        })

    monkeypatch.setattr(httpx, "post", fake_post)

    result = complete("deepseek-v4-flash", "say hi")

    assert result.text == "hello world"
    assert result.cost_usd == pytest.approx(0.001)
    assert result.latency_ms >= 0


def test_complete_raises_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    with pytest.raises(DeepSeekError, match="DEEPSEEK_API_KEY"):
        complete("deepseek-v4-flash", "say hi")


def test_complete_retries_then_raises_on_persistent_failure(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    call_count = {"n": 0}

    def fake_post(url, headers, json, timeout):
        call_count["n"] += 1
        return _MockResponse(500, {}, text="server error")

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr("core.experiment.deepseek_client.time.sleep", lambda seconds: None)

    with pytest.raises(DeepSeekError, match="failed after 3 attempts"):
        complete("deepseek-v4-flash", "say hi")

    assert call_count["n"] == 3


def test_complete_raises_for_unknown_model_pricing(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    with pytest.raises(DeepSeekError, match="unknown pricing"):
        complete("gpt-4o", "say hi")
