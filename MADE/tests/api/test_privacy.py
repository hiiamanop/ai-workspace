from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from core.privacy import pseudonymizer


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("MADE_MAPPING_ENCRYPTION_KEY", Fernet.generate_key().decode())
    pseudonymizer._get_fernet.cache_clear()
    import api.main as main_module
    main_module._engine = None
    return TestClient(main_module.app)


def test_redact_endpoint_replaces_entities_with_placeholders(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/privacy/redact", json={"org_id": "org1", "text": "email jane@example.com"})

    assert response.status_code == 200
    body = response.json()
    assert body == {"redacted_text": "email [EMAIL_1]", "redaction_count": 1}


def test_redact_then_restore_round_trips_via_the_api(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    redact_res = client.post(
        "/privacy/redact", json={"org_id": "org1", "text": "contact jane@example.com please"}
    )
    redacted_text = redact_res.json()["redacted_text"]

    restore_res = client.post("/privacy/restore", json={"org_id": "org1", "text": redacted_text})

    assert restore_res.status_code == 200
    assert restore_res.json() == {"restored_text": "contact jane@example.com please"}


def test_restore_endpoint_leaves_unknown_placeholder_unchanged(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/privacy/restore", json={"org_id": "org1", "text": "hi [EMAIL_1]"})

    assert response.status_code == 200
    assert response.json() == {"restored_text": "hi [EMAIL_1]"}
