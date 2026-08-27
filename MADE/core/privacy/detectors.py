"""Regex detectors for structured PII.

Each detector returns non-overlapping (start, end, entity_type, value)
spans. Patterns are checked in priority order (most specific first) and a
later pattern's matches are dropped wherever they overlap an
already-claimed span — a 16-digit NIK-shaped run inside a longer digit
sequence shouldn't also get flagged as a phone number, for example.
"""
import os
import re
from dataclasses import dataclass

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")

# Credentials / secrets (Phase A). Matched before everything else and,
# unlike other entities, redacted to a non-reversible marker by the
# pseudonymizer — a leaked key is never stored, even encrypted.
SECRET_RES = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"\b(?:sk|pk|rk|api|key|tok|token|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b", re.IGNORECASE),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[ _]?key|access[ _]?token)\s*[:=]\s*\S+"),
]

# 13-19 digits, optionally grouped by spaces or dashes in runs of 3-4 —
# covers common card formats without committing to one grouping scheme.
CARD_NUMBER_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

# Indonesian NIK: exactly 16 consecutive digits, no separators.
ID_NUMBER_RE = re.compile(r"(?<!\d)\d{16}(?!\d)")

# Phone: optional +country code, then 7-13 digits with optional
# spaces/dashes/parens as separators.
PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}[ -]?\d{0,4}(?!\w)")

# --- Indonesian-specific structured PII (Phase B1) ---

# NPWP (tax ID), canonical dotted form: 01.234.567.8-901.234
NPWP_DOTTED_RE = re.compile(r"\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}")
# NPWP written as a bare 15-16 digit run — only claimed when an "npwp"
# keyword sits nearby, since the shape collides with NIK / card numbers.
NPWP_BARE_RE = re.compile(r"(?<!\d)\d{15,16}(?!\d)")
# Kartu Keluarga: 16 digits, identical shape to NIK — a "kartu keluarga" /
# "no kk" keyword nearby is the only thing that tells them apart. Without
# one, the run falls through to ID_NUMBER (still redacted, just labelled NIK).
KK_RE = re.compile(r"(?<!\d)\d{16}(?!\d)")
# Indonesian vehicle plate: 1-2 letter region code, 1-4 digits, 1-3 letters.
ID_PLATE_RE = re.compile(r"\b([A-Z]{1,2})[ ]?(\d{1,4})[ ]?([A-Z]{1,3})\b")

_NPWP_KEYWORDS = ("npwp",)
_KK_KEYWORDS = ("kartu keluarga", "kartu kel", "no kk", "no. kk", "nomor kk", "no.kk")
_PLATE_KEYWORDS = ("plat", "pelat", "nopol", "no pol", "kendaraan")
# Active Indonesian vehicle-registration region codes — a bare plate-shaped
# run is only claimed when its prefix is one of these (or a plate keyword is
# nearby), so ordinary "AB 12 CD"-style text isn't swept up.
_ID_PLATE_PREFIXES = frozenset({
    "A", "AA", "AB", "AD", "AE", "AG", "B", "BA", "BB", "BD", "BE", "BG",
    "BH", "BK", "BL", "BM", "BN", "BP", "D", "DA", "DB", "DC", "DD", "DE",
    "DG", "DH", "DK", "DL", "DM", "DN", "DP", "DR", "DS", "DT", "DW", "E",
    "EA", "EB", "ED", "F", "G", "H", "K", "KB", "KH", "KT", "KU", "L", "M",
    "N", "P", "PA", "PB", "R", "S", "T", "W", "Z",
})


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    entity_type: str
    value: str


def _digit_count(text: str) -> int:
    return sum(c.isdigit() for c in text)


def _keyword_precedes(text: str, start: int, keywords: tuple[str, ...], window: int = 24) -> bool:
    """True if one of `keywords` appears in the `window` chars immediately
    before `start`. Left-only on purpose: Indonesian PII is written
    "LABEL value", so a keyword *after* the number is usually the label of
    the *next* field ("NIK 327... NPWP 09...") and must not claim this one.
    """
    left = text[max(0, start - window) : start].lower()
    return any(k in left for k in keywords)


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

    def _claim(m: re.Match, entity_type: str) -> None:
        spans.append(Span(m.start(), m.end(), entity_type, m.group()))
        claimed.append((m.start(), m.end()))

    for pattern in SECRET_RES:
        for m in _find_non_overlapping(pattern, text, claimed):
            _claim(m, "SECRET")

    for m in _find_non_overlapping(EMAIL_RE, text, claimed):
        _claim(m, "EMAIL")

    # NPWP dotted form is unambiguous — claim it before the digit patterns.
    for m in _find_non_overlapping(NPWP_DOTTED_RE, text, claimed):
        _claim(m, "NPWP")

    for m in _find_non_overlapping(CARD_NUMBER_RE, text, claimed):
        digits = "".join(c for c in m.group() if c.isdigit())
        if len(digits) < 13 or not _luhn_valid(digits):
            continue
        _claim(m, "CARD_NUMBER")

    # KK and bare NPWP share the 16-digit shape with NIK — a nearby keyword is
    # the only discriminator. Checked before ID_NUMBER so a keyworded run is
    # labelled specifically; an un-keyworded run falls through to ID_NUMBER.
    for m in _find_non_overlapping(KK_RE, text, claimed):
        if _keyword_precedes(text, m.start(), _KK_KEYWORDS):
            _claim(m, "KK")

    for m in _find_non_overlapping(NPWP_BARE_RE, text, claimed):
        if _keyword_precedes(text, m.start(), _NPWP_KEYWORDS):
            _claim(m, "NPWP")

    for m in _find_non_overlapping(ID_NUMBER_RE, text, claimed):
        _claim(m, "ID_NUMBER")

    for m in _find_non_overlapping(ID_PLATE_RE, text, claimed):
        if m.group(1).upper() in _ID_PLATE_PREFIXES or _keyword_precedes(
            text, m.start(), _PLATE_KEYWORDS
        ):
            _claim(m, "ID_PLATE")

    for m in _find_non_overlapping(PHONE_RE, text, claimed):
        if _digit_count(m.group()) < 7:
            continue
        _claim(m, "PHONE")

    spans.sort(key=lambda s: s.start)
    return spans


_NER_LABELS = {"PERSON", "ORG", "GPE"}
_nlp = None

# Indonesian NER (Phase B2) — a transformers token-classification model,
# lazy-loaded, fail-soft: if it can't be loaded (offline, bad id) redaction
# still runs with regex + the English spaCy pass. Override the checkpoint
# with MADE_ID_NER_MODEL.
_ID_NER_MODEL = os.environ.get("MADE_ID_NER_MODEL", "cahya/bert-base-indonesian-NER")
# cahya/bert-base-indonesian-NER emits PER / ORG / GPE / NOR (nationalities,
# incl. government bodies) among others; NOR -> ORG catches ministries etc.
_ID_NER_LABEL_MAP = {
    "PER": "PERSON", "PERSON": "PERSON",
    "ORG": "ORG", "NOR": "ORG",
    "LOC": "GPE", "GPE": "GPE",
}
_id_nlp = None
_id_nlp_unavailable = False


def _get_nlp():
    global _nlp
    if _nlp is None:
        import spacy

        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def _get_id_nlp():
    global _id_nlp, _id_nlp_unavailable
    if _id_nlp is None and not _id_nlp_unavailable:
        try:
            from transformers import pipeline

            _id_nlp = pipeline(
                "token-classification", model=_ID_NER_MODEL, aggregation_strategy="simple"
            )
        except Exception as err:  # noqa: BLE001 - any load failure degrades, never crashes
            print(
                f"privacy detectors: Indonesian NER model '{_ID_NER_MODEL}' unavailable "
                f"({err}); using regex + English NER only"
            )
            _id_nlp_unavailable = True
    return _id_nlp


def warm_up_ner() -> None:
    """Load the NER models now instead of on the first request."""
    _get_nlp()
    _get_id_nlp()


def _add_ner_spans(text, entities, label_of, span_of, claimed, spans):
    for ent in entities:
        label = label_of(ent)
        if label not in _NER_LABELS:
            continue
        start, end = span_of(ent)
        if start >= end or start < 0 or end > len(text):
            continue
        # Drop spans that start or end mid-word — subword tokenizers
        # occasionally hand back an offset inside a token for out-of-vocab
        # words ("credential" -> "tial"), which would redact a word fragment.
        if (start > 0 and text[start - 1].isalnum()) or (end < len(text) and text[end].isalnum()):
            continue
        if any(start < e and s < end for s, e in claimed):
            continue
        spans.append(Span(start, end, label, text[start:end]))
        claimed.append((start, end))


def detect_all(text: str) -> list[Span]:
    """Regex spans, then Indonesian NER, then English spaCy NER
    (PERSON/ORG/GPE). Earlier passes win on overlap: regex > ID-NER > EN-NER.
    """
    spans = detect(text)
    claimed = [(s.start, s.end) for s in spans]

    id_nlp = _get_id_nlp()
    if id_nlp is not None:
        _add_ner_spans(
            text,
            id_nlp(text),
            lambda ent: _ID_NER_LABEL_MAP.get(ent.get("entity_group", "")),
            lambda ent: (ent["start"], ent["end"]),
            claimed,
            spans,
        )

    _add_ner_spans(
        text,
        _get_nlp()(text).ents,
        lambda ent: ent.label_,
        lambda ent: (ent.start_char, ent.end_char),
        claimed,
        spans,
    )

    spans.sort(key=lambda s: s.start)
    return spans
