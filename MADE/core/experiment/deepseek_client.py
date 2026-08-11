import os
import time
from dataclasses import dataclass

import httpx


class DeepSeekError(RuntimeError):
    pass


@dataclass
class CompletionResult:
    text: str
    cost_usd: float
    latency_ms: float


_PRICING_USD_PER_1K_TOKENS = {
    "deepseek-v4-flash": 0.001,
    "deepseek-v4-pro": 0.01,
}

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 1.0


def _base_url() -> str:
    return os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")


def _api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise DeepSeekError("DEEPSEEK_API_KEY not set")
    return key


def complete(model: str, prompt: str) -> CompletionResult:
    if model not in _PRICING_USD_PER_1K_TOKENS:
        raise DeepSeekError(f"unknown pricing for model {model!r}")
    api_key = _api_key()

    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        start = time.monotonic()
        try:
            response = httpx.post(
                f"{_base_url()}/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
                timeout=60,
            )
            latency_ms = (time.monotonic() - start) * 1000
            if response.status_code != 200:
                raise DeepSeekError(f"DeepSeek API returned {response.status_code}: {response.text}")
            body = response.json()
            text = body["choices"][0]["message"]["content"]
            total_tokens = body["usage"]["total_tokens"]
            cost_usd = (total_tokens / 1000) * _PRICING_USD_PER_1K_TOKENS[model]
            return CompletionResult(text=text, cost_usd=cost_usd, latency_ms=latency_ms)
        except (httpx.TimeoutException, httpx.NetworkError, DeepSeekError) as exc:
            last_error = exc
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_RETRY_BACKOFF_SECONDS)

    raise DeepSeekError(f"DeepSeek API call failed after {_MAX_RETRIES} attempts: {last_error}") from last_error
