from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module
    main_module._engine = None
    return TestClient(main_module.app)


def test_get_default_policy_set(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.get("/policies/default")

    assert response.status_code == 200
    body = response.json()
    assert body["technique"] == "topsis"
    assert {"cost", "quality", "latency", "business_risk"} == {o["name"] for o in body["objectives"]}
    assert "compliance.rego" in body["hard_constraint_files"]
    assert all(not f.endswith("_test.rego") for f in body["hard_constraint_files"])


def test_get_unknown_policy_set_returns_404(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.get("/policies/nonexistent")

    assert response.status_code == 404
