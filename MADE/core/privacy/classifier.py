"""Automatic data-classification: decide public / internal / confidential /
restricted for a piece of text.

Cache -> heuristic -> cheap-LLM tie-break (only when the heuristic is
inconclusive). The heuristic resolves the common cases for free and
deterministically; the LLM is asked only about longer text with no signal
either way, where it might still be sensitive prose with no detectable PII.
"""
import hashlib
from dataclasses import dataclass, field

from sqlmodel import Session, select

from core.privacy import lexicon, llm_client
from core.privacy.detectors import detect
from storage.models import ClassificationCache

_ID_SPAN_TYPES = {"CARD_NUMBER", "ID_NUMBER", "NPWP", "KK"}
_SHORT_TEXT_CHARS = 40


@dataclass
class ClassifyResult:
    classification: str
    confidence: float
    source: str  # "cache" | "heuristic" | "llm"
    signals: list[str] = field(default_factory=list)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _heuristic(text: str) -> ClassifyResult | None:
    """Deterministic safety floor — the cases that MUST be caught instantly
    and can't wait on (or trust) an LLM. Everything else returns None and the
    caller asks the LLM.

    Regex `detect()` only (not `detect_all()`): the NER models are too noisy
    on casual text to drive a decision ("MADE", "ayam goreng" both tag
    PERSON) — deliberately NOT restoring the old PERSON+ORG count check.
    NER still runs during actual redaction.

    Lexicon and short-text checks below ARE restored (removed in a26a50d):
    without them, nearly every plain message with no SECRET/ID span fell
    through to the LLM tie-break, whose prompt says "when unsure, pick the
    more sensitive one" — that bias plus losing this safety floor is what
    made harmless short prompts get flagged confidential.
    """
    types = {s.entity_type for s in detect(text)}

    if "SECRET" in types:
        return ClassifyResult("restricted", 0.95, "heuristic", ["secret-span"])

    id_hits = sorted(types & _ID_SPAN_TYPES)
    if id_hits:
        return ClassifyResult("confidential", 0.9, "heuristic", [f"id-span:{','.join(id_hits)}"])

    conf_hits = lexicon.matches(text, "confidential")
    if conf_hits:
        return ClassifyResult("confidential", 0.75, "heuristic", [f"lexicon-confidential:{conf_hits[0]}"])

    pub_hits = lexicon.matches(text, "public")
    if pub_hits:
        return ClassifyResult("public", 0.7, "heuristic", [f"lexicon-public:{pub_hits[0]}"])

    if len(text.strip()) < _SHORT_TEXT_CHARS:
        return ClassifyResult("internal", 0.6, "heuristic", ["short-text"])

    return None


def classify(text: str, org_id: str, session: Session) -> ClassifyResult:
    text_hash = _hash(text)
    cached = session.exec(
        select(ClassificationCache).where(
            ClassificationCache.org_id == org_id,
            ClassificationCache.text_hash == text_hash,
        )
    ).first()
    if cached:
        return ClassifyResult(cached.classification, cached.confidence, "cache", ["cache"])

    result = _heuristic(text)
    if result is None:
        llm_label = llm_client.classify(text)
        if llm_label:
            result = ClassifyResult(llm_label, 0.7, "llm", ["llm"])
        else:
            result = ClassifyResult("internal", 0.4, "llm", ["llm-unavailable"])

    session.add(
        ClassificationCache(
            org_id=org_id,
            text_hash=text_hash,
            classification=result.classification,
            confidence=result.confidence,
            source=result.source,
        )
    )
    session.commit()
    return result
