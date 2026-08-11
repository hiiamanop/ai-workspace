import os
import time

import httpx

from core.experiment.deepseek_client import CompletionResult


class OllamaError(RuntimeError):
    pass


_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 1.0


def _base_url() -> str:
    return os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")


def complete(model: str, prompt: str) -> CompletionResult:
    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        start = time.monotonic()
        try:
            response = httpx.post(
                f"{_base_url()}/v1/chat/completions",
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
                timeout=120,
            )
            latency_ms = (time.monotonic() - start) * 1000
            if response.status_code != 200:
                raise OllamaError(f"Ollama API returned {response.status_code}: {response.text}")
            body = response.json()
            text = body["choices"][0]["message"]["content"]
            return CompletionResult(text=text, cost_usd=0.0, latency_ms=latency_ms)
        except (httpx.TimeoutException, httpx.NetworkError, OllamaError) as exc:
            last_error = exc
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_RETRY_BACKOFF_SECONDS)

    raise OllamaError(f"Ollama API call failed after {_MAX_RETRIES} attempts: {last_error}") from last_error
