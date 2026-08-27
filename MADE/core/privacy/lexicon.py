"""Loads core/privacy/lexicon.yaml and matches its phrases against text.

Whole-word / phrase, case-insensitive. Loaded once into a module global.
"""
import re
from pathlib import Path

import yaml

_LEXICON_PATH = Path(__file__).with_name("lexicon.yaml")
_compiled: dict[str, list[tuple[str, re.Pattern]]] | None = None


def _load() -> dict[str, list[tuple[str, re.Pattern]]]:
    global _compiled
    if _compiled is None:
        raw = yaml.safe_load(_LEXICON_PATH.read_text())
        _compiled = {}
        for classification, langs in (raw or {}).items():
            phrases: list[tuple[str, re.Pattern]] = []
            for lang_phrases in langs.values():
                for phrase in lang_phrases:
                    # \b around the whole phrase; internal spaces stay literal.
                    phrases.append((phrase, re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE)))
            _compiled[classification] = phrases
    return _compiled


def matches(text: str, classification: str) -> list[str]:
    """Phrases from `classification`'s list that appear in `text`."""
    return [phrase for phrase, pat in _load().get(classification, []) if pat.search(text)]
