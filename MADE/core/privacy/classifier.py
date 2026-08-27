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
from core.privacy.detectors import detect_all
from storage.models import ClassificationCache

_ID_SPAN_TYPES = {"CARD_NUMBER", "ID_NUMBER", "NPWP", "KK"}
_CONTACT_SPAN_TYPES = {"EMAIL", "PHONE", "ID_PLATE"}
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
    """Returns a result, or None when inconclusive (caller asks the LLM)."""
    spans = detect_all(text)
    types = [s.entity_type for s in spans]

    if "SECRET" in types:
        return ClassifyResult("restricted", 0.95, "heuristic", ["secret-span"])

    id_hits = sorted({t for t in types if t in _ID_SPAN_TYPES})
    if id_hits:
        return ClassifyResult("confidential", 0.9, "heuristic", [f"id-span:{','.join(id_hits)}"])

    persons = {s.value.lower() for s in spans if s.entity_type == "PERSON"}
    orgs = [s for s in spans if s.entity_type == "ORG"]
    if len(persons) >= 2 and orgs:
        return ClassifyResult("confidential", 0.7, "heuristic", ["ner:person+org"])

    conf_hits = lexicon.matches(text, "confidential")
    if conf_hits:
        return ClassifyResult("confidential", 0.75, "heuristic", [f"lexicon-confidential:{conf_hits[0]}"])

    pub_hits = lexicon.matches(text, "public")
    if pub_hits:
        return ClassifyResult("public", 0.7, "heuristic", [f"lexicon-public:{pub_hits[0]}"])

    if any(t in _CONTACT_SPAN_TYPES for t in types):
        return ClassifyResult("internal", 0.6, "heuristic", ["contact-span"])

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
