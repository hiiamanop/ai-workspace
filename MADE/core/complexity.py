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


def classify_task(text: str) -> dict:
    """Return routing metadata without another LLM completion.

    Complexity comes from the local classifier; intent and tool hints use a
    small, deterministic vocabulary so the policy engine remains the final
    authority.  This is intentionally conservative: uncertain prompts do not
    receive a web tool recommendation.
    """
    complexity, label, score = classify(text)
    normalized = text.casefold()
    current_markers = ("terbaru", "hari ini", "today", "latest", "news", "berita", "harga", "price")
    product_markers = ("produk", "product", "beli", "buy", "toko", "store", "marketplace", "link", "harga")
    knowledge_markers = ("dokumen", "document", "file", "knowledge base", "pdf")
    if any(marker in normalized for marker in product_markers):
        intent = "product_research"
    elif any(marker in normalized for marker in current_markers):
        intent = "news_or_current_information"
    elif any(marker in normalized for marker in knowledge_markers):
        intent = "document_or_knowledge_search"
    else:
        intent = "general_question"

    needs_tools = intent != "general_question"
    tools = ["web_search"] if intent in ("product_research", "news_or_current_information") else []
    if intent == "product_research" and any(marker in normalized for marker in ("exact", "spesifikasi", "specification", "verifikasi", "verify")):
        tools.append("scrape")
    if intent == "document_or_knowledge_search":
        tools.append("knowledge_search")
    return {
        "intent": intent,
        "complexity": complexity,
        "needs_tools": needs_tools,
        "tools": tools,
        "confidence": score,
        "label": label,
        "score": score,
    }
