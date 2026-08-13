# tests/api/test_policies_deploy.py
from pathlib import Path

from fastapi.testclient import TestClient

VALID_REGO = """package made.hard

deny[reason] {
    input.candidate.cost_per_1k_tokens > 1.0
    reason := "candidate too expensive"
}
"""

INVALID_REGO = "package made.hard\ndefault allow = ("

# Mirrors MADE/policies/hard/base.rego, which OWNS `default allow` — compiled
# policies must only add deny[reason] rules, and deploy must reject a second
# default (it would break every /decide call; C1 review caught this).
BASE_REGO = """package made.hard

default allow := true

allow := false {
    count(deny) > 0
}
"""

CONFLICTING_REGO = """package made.hard

default allow := false
"""


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module

    main_module._engine = None
    policies_root = tmp_path / "policies"
    hard_dir = policies_root / "hard"
    hard_dir.mkdir(parents=True)
    (hard_dir / "base.rego").write_text(BASE_REGO)
    monkeypatch.setattr(main_module, "POLICIES_ROOT", policies_root)
    return TestClient(main_module.app), policies_root


def test_deploy_valid_rego_writes_file(tmp_path, monkeypatch):
    client, policies_root = _client(tmp_path, monkeypatch)
    response = client.post("/api/policies/deploy", json={"policy_id": "budget-001", "rego_content": VALID_REGO})
    assert response.status_code == 200
    assert response.json() == {"policy_id": "budget-001", "status": "deployed"}
    written = (policies_root / "hard" / "budget-001.rego").read_text()
    assert "package made.hard" in written


def test_deploy_invalid_policy_id_400(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/policies/deploy", json={"policy_id": "../evil", "rego_content": VALID_REGO}
    )
    assert response.status_code == 400


def test_deploy_policy_id_ending_test_rejected(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/policies/deploy", json={"policy_id": "budget_test", "rego_content": VALID_REGO}
    )
    assert response.status_code == 400


def test_deploy_invalid_rego_400_and_no_file_written(tmp_path, monkeypatch):
    client, policies_root = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/policies/deploy", json={"policy_id": "broken", "rego_content": INVALID_REGO}
    )
    assert response.status_code == 400
    assert "rego invalid" in response.json()["detail"]
    assert not (policies_root / "hard" / "broken.rego").exists()


def test_deploy_default_allow_conflicts_with_base_rego_400(tmp_path, monkeypatch):
    """A second `default allow` next to base.rego breaks every /decide call —
    the C1 review's blocking finding. Deploy must reject it up front."""
    client, policies_root = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/policies/deploy", json={"policy_id": "evil", "rego_content": CONFLICTING_REGO}
    )
    assert response.status_code == 400
    assert "rego invalid" in response.json()["detail"]
    assert "multiple default rules" in response.json()["detail"]
    assert not (policies_root / "hard" / "evil.rego").exists()


def test_deploy_deny_only_policy_ok_alongside_base_rego(tmp_path, monkeypatch):
    """The legitimate shape: deny-only policy, base.rego owns allow."""
    client, policies_root = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/policies/deploy", json={"policy_id": "budget-002", "rego_content": VALID_REGO}
    )
    assert response.status_code == 200
    assert (policies_root / "hard" / "budget-002.rego").exists()
