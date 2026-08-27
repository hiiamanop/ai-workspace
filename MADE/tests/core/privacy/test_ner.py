import core.privacy.detectors as detectors
from core.privacy.detectors import detect_all


def _mock_id_ner(monkeypatch, entities):
    monkeypatch.setattr(detectors, "_id_nlp", lambda text: entities)
    monkeypatch.setattr(detectors, "_id_nlp_unavailable", False)


def test_detect_all_finds_person_and_org_via_ner():
    spans = detect_all("My name is John Smith and I work at Google.")
    kinds = [(s.entity_type, s.value) for s in spans]
    assert ("PERSON", "John Smith") in kinds
    assert ("ORG", "Google") in kinds


def test_detect_all_still_finds_regex_entities_alongside_ner():
    spans = detect_all("John Smith's email is john@example.com")
    kinds = {(s.entity_type, s.value) for s in spans}
    assert ("EMAIL", "john@example.com") in kinds
    assert any(t == "PERSON" and v.startswith("John Smith") for t, v in kinds)


def test_detect_all_regex_wins_on_overlap_with_ner():
    # A 16-digit NIK inside a sentence should stay ID_NUMBER even if NER
    # tries to tag overlapping tokens as something else.
    spans = detect_all("My ID is 3271010101990001 for verification")
    id_spans = [s for s in spans if s.value == "3271010101990001"]
    assert len(id_spans) == 1
    assert id_spans[0].entity_type == "ID_NUMBER"


def test_detect_all_merges_indonesian_ner(monkeypatch):
    text = "Budi Santoso bekerja di PT Telkom di Bandung"
    _mock_id_ner(monkeypatch, [
        {"entity_group": "PER", "start": 0, "end": 12},
        {"entity_group": "ORG", "start": 24, "end": 33},
        {"entity_group": "LOC", "start": 37, "end": 44},
    ])

    spans = {(s.entity_type, s.value) for s in detect_all(text)}

    assert ("PERSON", "Budi Santoso") in spans
    assert ("ORG", "PT Telkom") in spans
    assert ("GPE", "Bandung") in spans


def test_regex_beats_indonesian_ner_on_overlap(monkeypatch):
    text = "NIK 3271010101990001 milik Budi"
    _mock_id_ner(monkeypatch, [{"entity_group": "PER", "start": 4, "end": 20}])

    at_four = [s for s in detect_all(text) if s.start == 4]

    assert at_four and at_four[0].entity_type == "ID_NUMBER"


def test_indonesian_ner_unavailable_is_silent(monkeypatch):
    monkeypatch.setattr(detectors, "_id_nlp", None)
    monkeypatch.setattr(detectors, "_id_nlp_unavailable", True)

    # regex + English NER still work
    spans = {s.entity_type for s in detect_all("email budi@contoh.co.id")}
    assert "EMAIL" in spans
