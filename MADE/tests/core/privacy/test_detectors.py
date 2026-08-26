from core.privacy.detectors import detect


def test_detects_email():
    spans = detect("contact me at jane.doe@example.com please")
    assert [(s.entity_type, s.value) for s in spans] == [("EMAIL", "jane.doe@example.com")]


def test_detects_valid_card_number_and_rejects_invalid_luhn():
    valid = detect("card: 4111111111111111")
    assert [(s.entity_type, s.value) for s in valid] == [("CARD_NUMBER", "4111111111111111")]

    invalid = detect("card: 4111111111111112")
    assert not any(s.entity_type == "CARD_NUMBER" for s in invalid)


def test_detects_16_digit_id_number():
    spans = detect("NIK saya 3271010101990001 terima kasih")
    assert [(s.entity_type, s.value) for s in spans] == [("ID_NUMBER", "3271010101990001")]


def test_detects_phone_number():
    spans = detect("call me at 0812-3456-7890 tomorrow")
    assert [(s.entity_type, s.value) for s in spans] == [("PHONE", "0812-3456-7890")]


def test_detects_multiple_non_overlapping_entities_in_order():
    text = "Email jane@example.com or NIK 3271010101990001"
    spans = detect(text)
    assert [(s.entity_type, s.value) for s in spans] == [
        ("EMAIL", "jane@example.com"),
        ("ID_NUMBER", "3271010101990001"),
    ]


def test_id_number_does_not_also_get_flagged_as_phone():
    spans = detect("3271010101990001")
    assert len(spans) == 1
    assert spans[0].entity_type == "ID_NUMBER"


def test_no_false_positives_on_plain_text():
    spans = detect("just a normal sentence with no sensitive data at all")
    assert spans == []
