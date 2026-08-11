"""Session-wide test safety guards.

Defense-in-depth: point OLLAMA_BASE_URL at an unroutable address for the
entire test session, so that any test which forgets to mock
``core.experiment.harness.ollama_complete`` fails fast with a connection
error instead of silently succeeding by hitting a real local Ollama server
that happens to be running on the test machine. pytest must never call the
real Ollama (or DeepSeek) server.
"""
import pytest


@pytest.fixture(scope="session", autouse=True)
def _block_real_ollama_calls():
    import os

    previous = os.environ.get("OLLAMA_BASE_URL")
    # 127.0.0.1:1 is a reserved/unlisted port, so connections fail fast
    # (connection refused) rather than hanging on a routing timeout.
    os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("OLLAMA_BASE_URL", None)
        else:
            os.environ["OLLAMA_BASE_URL"] = previous
