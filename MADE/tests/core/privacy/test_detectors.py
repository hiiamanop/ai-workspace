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


# --- Indonesian structured PII (Phase B1) ---


def test_detects_npwp_dotted_form():
    spans = detect("NPWP perusahaan 09.254.294.3-407.000 sudah terdaftar")
    assert [(s.entity_type, s.value) for s in spans] == [("NPWP", "09.254.294.3-407.000")]


def test_detects_bare_npwp_only_with_keyword():
    with_kw = detect("npwp 092542943407000 ya")
    assert [(s.entity_type, s.value) for s in with_kw] == [("NPWP", "092542943407000")]

    # Same digits, no npwp keyword -> not labelled NPWP (16-digit run still
    # gets caught as ID_NUMBER; a 15-digit run is left alone).
    without_kw = detect("invoice ref 1234567890123456 attached")
    assert not any(s.entity_type == "NPWP" for s in without_kw)


def test_kk_vs_nik_disambiguation():
    kk = detect("Kartu Keluarga 3271012345678901 milik keluarga")
    assert [(s.entity_type, s.value) for s in kk] == [("KK", "3271012345678901")]

    nik = detect("3271012345678901")
    assert [(s.entity_type, s.value) for s in nik] == [("ID_NUMBER", "3271012345678901")]


def test_detects_vehicle_plate_with_known_region_code():
    spans = detect("mobil dinas B 1234 XYZ diparkir")
    assert [(s.entity_type, s.value) for s in spans] == [("ID_PLATE", "B 1234 XYZ")]


def test_detects_vehicle_plate_via_keyword_for_unknown_prefix():
    spans = detect("nomor plat QQ 99 ZZ tercatat")
    assert [(s.entity_type, s.value) for s in spans] == [("ID_PLATE", "QQ 99 ZZ")]


def test_plate_shape_in_plain_text_is_not_flagged():
    spans = detect("ambil OK 12 AB lalu pergi")
    assert not any(s.entity_type == "ID_PLATE" for s in spans)


def test_detects_indonesian_mobile_formats():
    plus62 = detect("hubungi +62 812 3456 7890 segera")
    assert any(s.entity_type == "PHONE" for s in plus62)

    bare08 = detect("wa saya di 081234567890 saja")
    assert any(s.entity_type == "PHONE" for s in bare08)
