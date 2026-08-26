"""Regex detectors for structured PII.

Each detector returns non-overlapping (start, end, entity_type, value)
spans. Patterns are checked in priority order (most specific first) and a
later pattern's matches are dropped wherever they overlap an
already-claimed span — a 16-digit NIK-shaped run inside a longer digit
sequence shouldn't also get flagged as a phone number, for example.
"""
import re
from dataclasses import dataclass

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")

# 13-19 digits, optionally grouped by spaces or dashes in runs of 3-4 —
# covers common card formats without committing to one grouping scheme.
CARD_NUMBER_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

# Indonesian NIK: exactly 16 consecutive digits, no separators.
ID_NUMBER_RE = re.compile(r"(?<!\d)\d{16}(?!\d)")

# Phone: optional +country code, then 7-13 digits with optional
# spaces/dashes/parens as separators.
PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}[ -]?\d{0,4}(?!\w)")


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    entity_type: str
    value: str


def _digit_count(text: str) -> int:
    return sum(c.isdigit() for c in text)


def _luhn_valid(digits: str) -> bool:
    total = 0
    reverse_digits = digits[::-1]
    for i, ch in enumerate(reverse_digits):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _find_non_overlapping(pattern: re.Pattern, text: str, claimed: list[tuple[int, int]]) -> list[re.Match]:
    matches = []
    for m in pattern.finditer(text):
        if any(m.start() < end and start < m.end() for start, end in claimed):
            continue
        matches.append(m)
    return matches


def detect(text: str) -> list[Span]:
    spans: list[Span] = []
    claimed: list[tuple[int, int]] = []

    for m in EMAIL_RE.finditer(text):
        spans.append(Span(m.start(), m.end(), "EMAIL", m.group()))
        claimed.append((m.start(), m.end()))

    for m in _find_non_overlapping(CARD_NUMBER_RE, text, claimed):
        digits = "".join(c for c in m.group() if c.isdigit())
        if len(digits) < 13 or not _luhn_valid(digits):
            continue
        spans.append(Span(m.start(), m.end(), "CARD_NUMBER", m.group()))
        claimed.append((m.start(), m.end()))

    for m in _find_non_overlapping(ID_NUMBER_RE, text, claimed):
        spans.append(Span(m.start(), m.end(), "ID_NUMBER", m.group()))
        claimed.append((m.start(), m.end()))

    for m in _find_non_overlapping(PHONE_RE, text, claimed):
        if _digit_count(m.group()) < 7:
            continue
        spans.append(Span(m.start(), m.end(), "PHONE", m.group()))
        claimed.append((m.start(), m.end()))

    spans.sort(key=lambda s: s.start)
    return spans


_NER_LABELS = {"PERSON", "ORG", "GPE"}
_nlp = None


def _get_nlp():
    global _nlp
    if _nlp is None:
        import spacy

        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def warm_up_ner() -> None:
    """Load the spaCy model now instead of on the first request."""
    _get_nlp()


def detect_all(text: str) -> list[Span]:
    """Regex spans plus spaCy NER (PERSON/ORG/GPE) — regex wins on overlap."""
    spans = detect(text)
    claimed = [(s.start, s.end) for s in spans]

    doc = _get_nlp()(text)
    for ent in doc.ents:
        if ent.label_ not in _NER_LABELS:
            continue
        if any(ent.start_char < end and start < ent.end_char for start, end in claimed):
            continue
        spans.append(Span(ent.start_char, ent.end_char, ent.label_, ent.text))
        claimed.append((ent.start_char, ent.end_char))

    spans.sort(key=lambda s: s.start)
    return spans
