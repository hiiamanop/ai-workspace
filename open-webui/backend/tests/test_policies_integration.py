"""Integration tests: full create → compile → deploy → rollback flows (C1).

Like the unit tests, but through the whole router flow against the real
SQLite DB, with only the outbound Node/MADE calls mocked.
"""

import threading
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from open_webui.routers import policies as policies_router
from open_webui.utils.auth import get_current_user

POLICY = {
    "id": "budget-policy-001",
    "name": "Budget Limit Policy",
    "markdown_content": "Enforce cost limit of $0.10 per request.",
}
REGO_V1 = "package made.hard\ndefault allow = true\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.1 }\n"
REGO_V2 = "package made.hard\ndefault allow = true\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.01 }\n"
REGO_V3 = "package made.hard\ndefault allow = true\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.005 }\n"

COMPILE_OK = {"rego": None, "warnings": []}  # rego filled per test
DEPLOY_OK = {"policy_id": "budget-policy-001", "status": "deployed"}
MADE_REJECT = {"detail": "rego invalid: line 5"}


class FakeResponse:
    def __init__(self, status_code, json_data=None):
        self.status_code = status_code
        self._json = json_data

    def json(self):
        return self._json


class FakeAsyncClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, **kwargs):
        self.calls.append((url, json))
        return self.responses.pop(0)


def make_client():
    app = FastAPI()
    app.include_router(policies_router.router, prefix="/api/v1/policies")
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="admin-1", role="admin")
    return TestClient(app)


def patch_httpx(responses):
    return patch.object(policies_router.httpx, "AsyncClient", lambda **kw: FakeAsyncClient(responses))


def test_create_compile_deploy_flow():
    client = make_client()

    created = client.post("/api/v1/policies", json=POLICY)
    assert created.status_code == 201

    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        compiled = client.post("/api/v1/policies/budget-policy-001/compile")
    assert compiled.status_code == 200
    assert compiled.json()["compiled_rego"] == REGO_V1

    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        deployed = client.post("/api/v1/policies/budget-policy-001/deploy")
    assert deployed.status_code == 200
    assert deployed.json()["status"] == "active"

    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "active"
    assert stored["active_rego"] == REGO_V1
    assert stored["deployed_at"] is not None

    listed = client.get("/api/v1/policies", params={"status": "active"}).json()
    assert listed["total"] == 1
    assert listed["policies"][0]["id"] == "budget-policy-001"


def test_deploy_fail_rollback_recovery():
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)

    # v1 deploys cleanly
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        assert client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 200

    # Roll the active policy back to draft so it can be edited
    assert client.post("/api/v1/policies/budget-policy-001/rollback").status_code == 200

    # v2 fails at MADE → rollback to v1
    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V2})]):
        client.post("/api/v1/policies/budget-policy-001/compile")

    fake = FakeAsyncClient([FakeResponse(400, MADE_REJECT), FakeResponse(200, DEPLOY_OK)])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        failed = client.post("/api/v1/policies/budget-policy-001/deploy")
    assert failed.status_code == 400
    body = failed.json()
    assert body["rolled_back"] is True
    assert body["status"] == "draft"

    # rollback re-deployed v1 to MADE
    rollback_calls = [j for _, j in fake.calls if j["rego_content"] == REGO_V1]
    assert len(rollback_calls) == 1

    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] == REGO_V1  # still the last good version
    assert stored["last_error"]

    # fix the policy, redeploy v3 → active
    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "even tighter"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V3})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        redeployed = client.post("/api/v1/policies/budget-policy-001/deploy")
    assert redeployed.status_code == 200
    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "active"
    assert stored["active_rego"] == REGO_V3
    assert stored["last_error"] is None


def test_concurrent_deploys_exactly_one_wins():
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")

    results = {}

    def deploy_in_thread():
        c = make_client()
        resp = c.post("/api/v1/policies/budget-policy-001/deploy")
        results[resp.status_code] = results.get(resp.status_code, 0) + 1

    # Reserve is a conditional UPDATE — the DB serializes the two writers,
    # so exactly one deploy passes it; the other gets 400 without touching MADE.
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        threads = [threading.Thread(target=deploy_in_thread) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    assert results == {200: 1, 400: 1}

    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "active"
    assert stored["active_rego"] == REGO_V1
    # exactly one version row: version creation follows the winner's MADE call
    assert client.get("/api/v1/policies/budget-policy-001/versions").json()["total"] == 1


def test_full_lifecycle_audit_trail():
    """C3-A: create → update → compile → deploy all leave audit entries."""
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)
    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "revised"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        client.post("/api/v1/policies/budget-policy-001/deploy")

    entries = client.get("/api/v1/policies/budget-policy-001/audit").json()["entries"]
    assert [e["action"] for e in entries] == ["deploy", "compile", "update", "create"]  # newest first

    deploy_entry = next(e for e in entries if e["action"] == "deploy")
    assert deploy_entry["made_response"]["outcome"] == "ok"
    compile_entry = next(e for e in entries if e["action"] == "compile")
    assert compile_entry["compile_success"] is True
    update_entry = next(e for e in entries if e["action"] == "update")
    assert update_entry["before"]["markdown_content"] == POLICY["markdown_content"]
    assert "revised" in update_entry["after"]["markdown_content"]
    assert all(e["user_id"] == "admin-1" for e in entries)


def test_versions_only_on_success():
    """C3-B: a deploy MADE rejects must not create a version row."""
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        assert client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 200
    assert client.post("/api/v1/policies/budget-policy-001/rollback").status_code == 200

    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V2})]):
        client.post("/api/v1/policies/budget-policy-001/compile")

    fake = FakeAsyncClient([FakeResponse(400, MADE_REJECT), FakeResponse(200, DEPLOY_OK)])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        assert client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 400

    body = client.get("/api/v1/policies/budget-policy-001/versions").json()
    assert body["total"] == 1  # v2 rejected → still only v1
    assert body["versions"][0]["version_number"] == 1
    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["current_version_id"] == body["versions"][0]["id"]


def test_deploy_deploy_rollback_workflow():
    """C3-C: deploy v1 → deploy v2 → rollback restores v1; no version row on rollback."""
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        assert client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 200

    # take offline for editing (first-version rollback: no previous_rego)
    assert client.post("/api/v1/policies/budget-policy-001/rollback").status_code == 200
    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V2})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        assert client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 200

    body = client.get("/api/v1/policies/budget-policy-001/versions").json()
    assert [v["version_number"] for v in body["versions"]] == [2, 1]

    fake = FakeAsyncClient([FakeResponse(200, DEPLOY_OK)])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        resp = client.post("/api/v1/policies/budget-policy-001/rollback")
    assert resp.status_code == 200
    assert resp.json()["status"] == "draft"
    # rollback re-deployed v1 to MADE
    assert [j for _, j in fake.calls if j["rego_content"] == REGO_V1]

    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] == REGO_V1
    assert stored["previous_rego"] is None

    # rollback is not a deployment: still 2 versions
    assert client.get("/api/v1/policies/budget-policy-001/versions").json()["total"] == 2

    # audit trail counts: 2 deploys, 2 rollbacks, 2 compiles, 1 create
    entries = client.get("/api/v1/policies/budget-policy-001/audit").json()["entries"]
    actions = [e["action"] for e in entries]
    assert actions.count("deploy") == 2
    assert actions.count("rollback") == 2
    assert actions.count("compile") == 2
    assert actions.count("create") == 1


def test_deploy_made_503_unreachable_no_rollback():
    """C3-D FR-D1: MADE 503 response → our 502, no rollback attempted, policy untouched."""
    client = make_client()
    client.post("/api/v1/policies", json=POLICY)
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V1})]):
        client.post("/api/v1/policies/budget-policy-001/compile")
    with patch_httpx([FakeResponse(200, DEPLOY_OK)]):
        client.post("/api/v1/policies/budget-policy-001/deploy")
    # draft again, ready for a second deploy (its backup step re-sets
    # previous_rego from the still-live active_rego)
    assert client.post("/api/v1/policies/budget-policy-001/rollback").status_code == 200
    client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    with patch_httpx([FakeResponse(200, {**COMPILE_OK, "rego": REGO_V2})]):
        client.post("/api/v1/policies/budget-policy-001/compile")

    fake = FakeAsyncClient([FakeResponse(503, {"detail": "service unavailable"})])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        response = client.post("/api/v1/policies/budget-policy-001/deploy")

    assert response.status_code == 502

    stored = client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"  # no rollback, no status flip
    assert stored["active_rego"] == REGO_V1  # unchanged
    assert "unreachable" in stored["last_error"].lower()
    assert len(fake.calls) == 1  # exactly one MADE attempt, no rollback call

    # and no version row was created for the failed deploy
    assert client.get("/api/v1/policies/budget-policy-001/versions").json()["total"] == 1
