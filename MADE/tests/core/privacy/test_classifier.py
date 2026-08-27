from sqlmodel import Session

from core.privacy import classifier
from storage.db import make_engine

_LONG_NEUTRAL = (
    "Please provide a thorough written analysis of the market dynamics "
    "described in the previous paragraphs, covering demand and supply."
)


def _session(tmp_path) -> Session:
    return Session(make_engine(tmp_path / "test.db"))


def test_secret_span_is_restricted(tmp_path):
    r = classifier.classify("my api key is sk-abcdef0123456789abcdef", "org1", _session(tmp_path))
    assert r.classification == "restricted"
    assert r.source == "heuristic"


def test_id_span_is_confidential(tmp_path):
    r = classifier.classify("NIK 3271010101990001", "org1", _session(tmp_path))
    assert r.classification == "confidential"


def test_confidential_lexicon_indonesian(tmp_path):
    r = classifier.classify("mohon jangan disebar, ini soal pesangon karyawan", "org1", _session(tmp_path))
    assert r.classification == "confidential"
    assert any(s.startswith("lexicon-confidential") for s in r.signals)


def test_public_lexicon(tmp_path):
    r = classifier.classify(
        "draft siaran pers untuk publikasi produk baru minggu depan", "org1", _session(tmp_path)
    )
    assert r.classification == "public"


def test_short_text_is_internal(tmp_path):
    r = classifier.classify("hi there team", "org1", _session(tmp_path))
    assert r.classification == "internal"
    assert "short-text" in r.signals


def test_inconclusive_falls_to_llm(tmp_path, monkeypatch):
    monkeypatch.setattr(classifier.llm_client, "classify", lambda t: "confidential")
    r = classifier.classify(_LONG_NEUTRAL, "org1", _session(tmp_path))
    assert r.classification == "confidential"
    assert r.source == "llm"


def test_llm_unavailable_defaults_internal(tmp_path, monkeypatch):
    monkeypatch.setattr(classifier.llm_client, "classify", lambda t: None)
    r = classifier.classify(_LONG_NEUTRAL, "org1", _session(tmp_path))
    assert r.classification == "internal"
    assert r.confidence == 0.4
    assert "llm-unavailable" in r.signals


def test_result_is_cached(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(classifier.llm_client, "classify", lambda t: calls.append(t) or "confidential")
    session = _session(tmp_path)

    first = classifier.classify(_LONG_NEUTRAL, "org1", session)
    second = classifier.classify(_LONG_NEUTRAL, "org1", session)

    assert first.source == "llm"
    assert second.source == "cache"
    assert second.classification == "confidential"
    assert len(calls) == 1
