from cryptography.fernet import Fernet
from sqlmodel import Session

from core.privacy import pseudonymizer
from storage.db import make_engine


def _session(tmp_path) -> Session:
    engine = make_engine(tmp_path / "test.db")
    return Session(engine)


def _set_key(monkeypatch):
    monkeypatch.setenv("MADE_MAPPING_ENCRYPTION_KEY", Fernet.generate_key().decode())
    pseudonymizer._get_fernet.cache_clear()


def test_redact_replaces_entities_with_placeholders(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    redacted, count = pseudonymizer.redact("email me at jane@example.com", "org1", session)

    assert count == 1
    assert redacted == "email me at [EMAIL_1]"


def test_redact_then_restore_round_trips_exactly(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    original = "My name is John Smith, email john@example.com, NIK 3271010101990001"
    redacted, count = pseudonymizer.redact(original, "org1", session)
    restored = pseudonymizer.restore(redacted, "org1", session)

    assert count == 3
    assert restored == original


def test_same_value_redacted_twice_reuses_the_same_placeholder(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    first, _ = pseudonymizer.redact("contact jane@example.com", "org1", session)
    second, _ = pseudonymizer.redact("reach out to jane@example.com again", "org1", session)

    assert "[EMAIL_1]" in first
    assert "[EMAIL_1]" in second


def test_different_orgs_get_independent_placeholder_counters(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    redacted_a, _ = pseudonymizer.redact("jane@example.com", "org-a", session)
    redacted_b, _ = pseudonymizer.redact("jane@example.com", "org-b", session)

    assert redacted_a == "[EMAIL_1]"
    assert redacted_b == "[EMAIL_1]"  # same placeholder number, independent org scope


def test_unknown_placeholder_in_restore_is_left_unchanged(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    restored = pseudonymizer.restore("hello [EMAIL_99]", "org1", session)

    assert restored == "hello [EMAIL_99]"


def test_redact_raises_when_encryption_key_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("MADE_MAPPING_ENCRYPTION_KEY", raising=False)
    pseudonymizer._get_fernet.cache_clear()
    session = _session(tmp_path)

    try:
        pseudonymizer.redact("jane@example.com", "org1", session)
        assert False, "expected MissingEncryptionKeyError"
    except pseudonymizer.MissingEncryptionKeyError:
        pass
