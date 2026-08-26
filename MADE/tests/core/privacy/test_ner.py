from core.privacy.detectors import detect_all


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
