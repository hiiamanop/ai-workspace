from cryptography.fernet import Fernet
from sqlmodel import Session, select

from core.privacy import pseudonymizer
from core.privacy.detectors import Span
from storage.db import make_engine
from storage.models import RedactionLeak

_EMAIL_LEN = len("jane@example.com")


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


def test_secret_is_redacted_non_reversibly(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)

    redacted, count = pseudonymizer.redact("credential sk-abcdef0123456789abcdef here", "org1", session)

    assert count >= 1
    assert "[SECRET_REDACTED]" in redacted
    assert "sk-abcdef" not in redacted
    # No mapping row is stored, so restore() can only leave the marker as-is.
    assert pseudonymizer.restore(redacted, "org1", session) == redacted


def test_redact_records_a_leak_when_a_span_survives(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    session = _session(tmp_path)
    # First pass only "sees" the email — the phone is a detector gap.
    monkeypatch.setattr(
        pseudonymizer, "detect_all", lambda text: [Span(0, _EMAIL_LEN, "EMAIL", "jane@example.com")]
    )

    redacted, _ = pseudonymizer.redact("jane@example.com and call 0812-3456-7890", "org1", session)

    assert "0812-3456-7890" in redacted
    leaks = session.exec(select(RedactionLeak).where(RedactionLeak.org_id == "org1")).all()
    assert len(leaks) == 1
    assert "PHONE" in leaks[0].entity_types
    assert "0812" not in leaks[0].context_hash  # hash only, never the text


def test_redact_fail_closed_raises_on_leak(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    monkeypatch.setenv("MADE_REDACTION_LEAK_FAIL_CLOSED", "1")
    session = _session(tmp_path)
    monkeypatch.setattr(
        pseudonymizer, "detect_all", lambda text: [Span(0, _EMAIL_LEN, "EMAIL", "jane@example.com")]
    )

    try:
        pseudonymizer.redact("jane@example.com and 0812-3456-7890", "org1", session)
        assert False, "expected RedactionLeakError"
    except pseudonymizer.RedactionLeakError:
        pass


def test_restore_logs_a_mangled_placeholder(tmp_path, monkeypatch, capsys):
    _set_key(monkeypatch)
    session = _session(tmp_path)
    pseudonymizer.redact("contact jane@example.com", "org1", session)  # mints [EMAIL_1]

    out = pseudonymizer.restore("contact [Email 1] now", "org1", session)

    assert out == "contact [Email 1] now"  # not recovered without the flag
    assert "mangled placeholder" in capsys.readouterr().out


def test_restore_fuzzy_recovers_a_mangled_placeholder(tmp_path, monkeypatch):
    _set_key(monkeypatch)
    monkeypatch.setenv("MADE_RESTORE_FUZZY", "1")
    session = _session(tmp_path)
    pseudonymizer.redact("contact jane@example.com", "org1", session)

    out = pseudonymizer.restore("contact [Email 1] now", "org1", session)

    assert out == "contact jane@example.com now"


def test_redact_raises_when_encryption_key_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("MADE_MAPPING_ENCRYPTION_KEY", raising=False)
    pseudonymizer._get_fernet.cache_clear()
    session = _session(tmp_path)

    try:
        pseudonymizer.redact("jane@example.com", "org1", session)
        assert False, "expected MissingEncryptionKeyError"
    except pseudonymizer.MissingEncryptionKeyError:
        pass
