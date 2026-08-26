"""Prompt complexity classification, backed by a small local HF model.

Replaces asking an LLM "how complex is this prompt?" (a full extra chat
completion per turn) with a purpose-built classifier
(BCN001/llm-complexity-router, deberta-v3-small, ~100M params) that runs
locally on CPU in ~30-60ms once loaded. Verified this correctly separates
prompt *length* from task *difficulty* — a long-but-easy prompt still comes
back SIMPLE, a short-but-hard one still comes back COMPLEX — which a
length-only heuristic cannot do.
"""
from typing import Literal

MODEL_ID = "BCN001/llm-complexity-router"

_pipeline = None


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        from transformers import pipeline

        _pipeline = pipeline("text-classification", model=MODEL_ID)
    return _pipeline


def warm_up() -> None:
    """Load the model now instead of on the first request."""
    _get_pipeline()


def classify(text: str) -> tuple[Literal["low", "high"], str, float]:
    result = _get_pipeline()(text)[0]
    label = result["label"]
    score = float(result["score"])
    complexity: Literal["low", "high"] = "high" if label == "COMPLEX" else "low"
    return complexity, label, score
