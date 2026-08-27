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


def test_classify_endpoint_flags_secret_as_restricted(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/privacy/classify", json={"org_id": "org1", "text": "token: sk-abcdef0123456789abcdef"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["classification"] == "restricted"
    assert body["source"] == "heuristic"


def test_classify_endpoint_internal_for_plain_text(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/privacy/classify", json={"org_id": "org1", "text": "hello world"})

    assert response.status_code == 200
    assert response.json()["classification"] == "internal"


def test_leaks_endpoint_lists_recorded_leaks(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("MADE_MAPPING_ENCRYPTION_KEY", Fernet.generate_key().decode())
    pseudonymizer._get_fernet.cache_clear()
    import api.main as main_module
    from core.privacy.detectors import Span
    main_module._engine = None
    monkeypatch.setattr(
        pseudonymizer, "detect_all", lambda text: [Span(0, 16, "EMAIL", "jane@example.com")]
    )
    from fastapi.testclient import TestClient
    client = TestClient(main_module.app)

    client.post("/privacy/redact", json={"org_id": "leak-org", "text": "jane@example.com and 0812-3456-7890"})
    res = client.get("/privacy/leaks", params={"org_id": "leak-org"})

    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert "PHONE" in body[0]["entity_types"]
    assert client.get("/privacy/leaks", params={"org_id": "other-org"}).json() == []


def test_mappings_crud_roundtrip(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post("/privacy/redact", json={"org_id": "m-org", "text": "email jane@example.com"})

    listed = client.get("/privacy/mappings", params={"org_id": "m-org"}).json()
    assert len(listed) == 1
    row = listed[0]
    assert row["placeholder"] == "[EMAIL_1]"
    assert row["original_value"] == "jane@example.com"

    patched = client.patch(
        f"/privacy/mappings/{row['id']}",
        params={"org_id": "m-org"},
        json={"original_value": "jane.doe@example.com"},
    )
    assert patched.status_code == 200
    assert patched.json()["original_value"] == "jane.doe@example.com"
    # restore now yields the corrected value
    restored = client.post("/privacy/restore", json={"org_id": "m-org", "text": "hi [EMAIL_1]"}).json()
    assert restored["restored_text"] == "hi jane.doe@example.com"

    assert client.delete(f"/privacy/mappings/{row['id']}", params={"org_id": "m-org"}).status_code == 204
    assert client.get("/privacy/mappings", params={"org_id": "m-org"}).json() == []


def test_mappings_patch_rejects_bad_placeholder_and_conflicts(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post("/privacy/redact", json={"org_id": "m2", "text": "a@x.com and b@x.com"})
    rows = client.get("/privacy/mappings", params={"org_id": "m2"}).json()
    first, second = rows[1]["id"], rows[0]["id"]  # newest-first order

    bad = client.patch(f"/privacy/mappings/{first}", params={"org_id": "m2"}, json={"placeholder": "nope"})
    assert bad.status_code == 400

    clash = client.patch(
        f"/privacy/mappings/{first}", params={"org_id": "m2"}, json={"placeholder": rows[0]["placeholder"]}
    )
    assert clash.status_code == 409

    assert client.patch("/privacy/mappings/ghost", params={"org_id": "m2"}, json={}).status_code == 404
    assert client.delete("/privacy/mappings/ghost", params={"org_id": "m2"}).status_code == 404


def test_mappings_are_org_scoped(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post("/privacy/redact", json={"org_id": "org-a", "text": "email jane@example.com"})
    assert client.get("/privacy/mappings", params={"org_id": "org-b"}).json() == []


def test_restore_endpoint_leaves_unknown_placeholder_unchanged(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/privacy/restore", json={"org_id": "org1", "text": "hi [EMAIL_1]"})

    assert response.status_code == 200
    assert response.json() == {"restored_text": "hi [EMAIL_1]"}
