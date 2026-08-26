"""Unit tests for the policies router (C1).

Runs the real policies router on a minimal FastAPI app with:
- get_current_user overridden with a fake admin / non-admin user
- real get_async_session against a tmp SQLite file (see conftest.py)
- httpx.AsyncClient patched to a fake for compile/deploy outbound calls
"""

from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from open_webui.routers import policies as policies_router
from open_webui.utils.auth import get_current_user

POLICY = {
    "id": "budget-policy-001",
    "name": "Budget Limit Policy",
    "markdown_content": "Enforce cost limit of $0.10 per request.",
}
VALID_REGO = "package made.hard\ndefault allow = true\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.1 }\n"


class FakeResponse:
    def __init__(self, status_code, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        return self._json


class FakeAsyncClient:
    """httpx.AsyncClient stand-in; each post() pops the next queued response."""

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


def make_client(user_role="admin"):
    app = FastAPI()
    app.include_router(policies_router.router, prefix="/api/v1/policies")
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="admin-1", role=user_role)
    return TestClient(app)


@pytest.fixture
def admin_client():
    return make_client("admin")


@pytest.fixture
def non_admin_client():
    return make_client("user")


@pytest.fixture
def patch_httpx(monkeypatch):
    """Patch the router module's httpx.AsyncClient with a queued-response fake."""

    def _patch(responses):
        monkeypatch.setattr(policies_router.httpx, "AsyncClient", lambda **kw: FakeAsyncClient(responses))

    return _patch


def patch_httpx_with(client_cls):
    """Same, with a caller-supplied client class (for failure simulation)."""

    def _decorator(responses):
        return patch.object(policies_router.httpx, "AsyncClient", lambda **kw: client_cls(responses))

    return _decorator


############################
# Access control
############################


def test_non_admin_gets_403_on_all_endpoints(non_admin_client):
    for method, path in [
        ("post", ""),
        ("get", ""),
        ("get", "/budget-policy-001"),
        ("put", "/budget-policy-001"),
        ("delete", "/budget-policy-001"),
        ("post", "/budget-policy-001/compile"),
        ("post", "/budget-policy-001/deploy"),
        ("post", "/budget-policy-001/rollback"),
        ("get", "/budget-policy-001/audit"),
        ("get", "/budget-policy-001/versions"),
    ]:
        kwargs = {"json": POLICY} if method in ("post", "put") else {}
        response = getattr(non_admin_client, method)(f"/api/v1/policies{path}", **kwargs)
        assert response.status_code == 403, (method, path, response.text)


def test_admin_can_create(admin_client):
    response = admin_client.post("/api/v1/policies", json=POLICY)
    assert response.status_code == 201


############################
# CRUD
############################


def test_create_policy_draft(admin_client):
    response = admin_client.post("/api/v1/policies", json=POLICY)
    assert response.status_code == 201
    body = response.json()
    assert body["id"] == "budget-policy-001"
    assert body["status"] == "draft"
    assert body["compiled_rego"] is None
    assert body["created_by"] == "admin-1"


def test_create_invalid_policy_id_400(admin_client):
    response = admin_client.post("/api/v1/policies", json={**POLICY, "id": "../evil"})
    assert response.status_code == 400


def test_create_duplicate_409(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.post("/api/v1/policies", json=POLICY)
    assert response.status_code == 409


def test_list_policies(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    admin_client.post("/api/v1/policies", json={**POLICY, "id": "second-policy"})
    response = admin_client.get("/api/v1/policies")
    assert response.status_code == 200
    assert response.json()["total"] == 2


def test_list_filter_by_status(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.get("/api/v1/policies", params={"status": "draft"})
    assert response.json()["total"] == 1
    response = admin_client.get("/api/v1/policies", params={"status": "active"})
    assert response.json()["total"] == 0


def test_list_invalid_status_400(admin_client):
    response = admin_client.get("/api/v1/policies", params={"status": "bogus"})
    assert response.status_code == 400


def test_get_policy(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.get("/api/v1/policies/budget-policy-001")
    assert response.status_code == 200
    assert response.json()["name"] == "Budget Limit Policy"


def test_get_policy_404(admin_client):
    response = admin_client.get("/api/v1/policies/nope")
    assert response.status_code == 404


def test_update_draft_ok(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.put(
        "/api/v1/policies/budget-policy-001", json={"markdown_content": "New policy text."}
    )
    assert response.status_code == 200
    assert response.json()["markdown_content"] == "New policy text."
    assert response.json()["status"] == "draft"


def test_update_active_400(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    set_active(admin_client)
    response = admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "x"})
    assert response.status_code == 400


def test_delete_draft_ok(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.delete("/api/v1/policies/budget-policy-001")
    assert response.status_code == 204


def test_delete_active_400(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    set_active(admin_client)
    response = admin_client.delete("/api/v1/policies/budget-policy-001")
    assert response.status_code == 400


def test_delete_404(admin_client):
    response = admin_client.delete("/api/v1/policies/nope")
    assert response.status_code == 404


############################
# Compile
############################


def test_compile_calls_node_backend_and_saves_rego(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO, "warnings": []})])

    response = admin_client.post("/api/v1/policies/budget-policy-001/compile")
    assert response.status_code == 200
    assert response.json()["compiled_rego"] == VALID_REGO

    # Rego persisted
    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["compiled_rego"] == VALID_REGO


def test_compile_node_backend_unreachable_503(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)

    class Unreachable(FakeAsyncClient):
        async def post(self, url, json=None, **kwargs):
            raise httpx.ConnectError("connection refused")

    with patch_httpx_with(Unreachable)([]):
        response = admin_client.post("/api/v1/policies/budget-policy-001/compile")
    assert response.status_code == 503


def test_compile_llm_error_400(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(400, {"error": "Markdown is too vague for compilation"})])
    response = admin_client.post("/api/v1/policies/budget-policy-001/compile")
    assert response.status_code == 400
    assert "too vague" in response.json()["error"]


def test_compile_404(admin_client):
    response = admin_client.post("/api/v1/policies/nope/compile")
    assert response.status_code == 404


def test_draft_calls_node_backend_and_returns_content(admin_client, patch_httpx):
    patch_httpx([FakeResponse(200, {"content": "What vendor should this apply to?", "draftMarkdown": None})])

    response = admin_client.post(
        "/api/v1/policies/draft", json={"messages": [{"role": "user", "content": "Add a spend cap"}]}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "What vendor should this apply to?"
    assert body["draft_markdown"] is None


def test_draft_returns_draft_markdown_when_ready(admin_client, patch_httpx):
    patch_httpx([FakeResponse(200, {"content": "Here it is:\n```markdown\n# Policy\n```", "draftMarkdown": "# Policy"})])

    response = admin_client.post(
        "/api/v1/policies/draft", json={"messages": [{"role": "user", "content": "Cap DeepSeek at $0.10"}]}
    )
    assert response.status_code == 200
    assert response.json()["draft_markdown"] == "# Policy"


def test_draft_requires_non_empty_messages(admin_client):
    response = admin_client.post("/api/v1/policies/draft", json={"messages": []})
    assert response.status_code == 400


def test_draft_node_backend_unreachable_503(admin_client):
    class Unreachable(FakeAsyncClient):
        async def post(self, url, json=None, **kwargs):
            raise httpx.ConnectError("connection refused")

    with patch_httpx_with(Unreachable)([]):
        response = admin_client.post(
            "/api/v1/policies/draft", json={"messages": [{"role": "user", "content": "hi"}]}
        )
    assert response.status_code == 503


def test_draft_requires_admin(non_admin_client):
    response = non_admin_client.post(
        "/api/v1/policies/draft", json={"messages": [{"role": "user", "content": "hi"}]}
    )
    assert response.status_code == 403


############################
# Deploy
############################


def test_deploy_success(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")

    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    assert response.status_code == 200
    assert response.json()["status"] == "active"

    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "active"
    assert stored["active_rego"] == VALID_REGO
    assert stored["deployed_at"] is not None
    assert stored["last_error"] is None


def test_deploy_already_active_400(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    assert response.status_code == 400


def test_deploy_without_compile_400(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    assert response.status_code == 400


def _deploy_flow_to_active(admin_client, patch_httpx):
    """create → compile v1 → deploy v1 → active, then rollback to draft for editing."""
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    # FR-4: take the (first-version) active policy offline for editing
    assert admin_client.post("/api/v1/policies/budget-policy-001/rollback").status_code == 200


def test_deploy_made_error_rolls_back_to_previous(admin_client, patch_httpx):
    _deploy_flow_to_active(admin_client, patch_httpx)

    # Edit + recompile to v2, then deploy fails → rollback to v1
    admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    V2 = VALID_REGO + "\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.01 }\n"
    patch_httpx([FakeResponse(200, {"rego": V2})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")

    fake = FakeAsyncClient(
        [
            FakeResponse(400, {"detail": "rego invalid: line 5"}),
            FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"}),
        ]
    )
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    assert response.status_code == 400
    body = response.json()
    assert body["rolled_back"] is True
    assert body["status"] == "draft"

    # Rollback call sent v1 (the previous active_rego), not v2
    deploy_calls = [json for _, json in fake.calls if json["rego_content"] == VALID_REGO]
    assert len(deploy_calls) == 1

    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] == VALID_REGO
    assert stored["last_error"]


def test_rollback_first_version_keeps_made_untouched(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    fake = FakeAsyncClient([])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        response = admin_client.post("/api/v1/policies/budget-policy-001/rollback")

    assert response.status_code == 200
    assert response.json()["status"] == "draft"
    assert fake.calls == []  # nothing to restore, MADE untouched

    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] == VALID_REGO  # still what's live in MADE


def test_rollback_restores_previous_version(admin_client, patch_httpx):
    # v1 active → offline → edit v2 → v2 rejected → fix v3 → active → rollback restores v1
    _deploy_flow_to_active(admin_client, patch_httpx)
    admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    V2 = VALID_REGO + "\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.01 }\n"
    patch_httpx([FakeResponse(200, {"rego": V2})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    fake = FakeAsyncClient([FakeResponse(400, {"detail": "rego invalid: line 5"}),
                            FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        assert admin_client.post("/api/v1/policies/budget-policy-001/deploy").status_code == 400

    # v3 deploys → active, previous_rego (v1) still recorded
    V3 = VALID_REGO + "\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.005 }\n"
    patch_httpx([FakeResponse(200, {"rego": V3})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    assert admin_client.get("/api/v1/policies/budget-policy-001").json()["status"] == "active"

    # FR-4 rollback: previous_rego exists → v1 re-deployed to MADE, policy editable again
    fake2 = FakeAsyncClient([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake2):
        resp = admin_client.post("/api/v1/policies/budget-policy-001/rollback")
    assert resp.status_code == 200
    assert [j for _, j in fake2.calls if j["rego_content"] == VALID_REGO]

    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] == VALID_REGO
    assert stored["previous_rego"] is None


def test_rollback_not_active_400(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    response = admin_client.post("/api/v1/policies/budget-policy-001/rollback")
    assert response.status_code == 400


def test_rollback_404(admin_client):
    response = admin_client.post("/api/v1/policies/nope/rollback")
    assert response.status_code == 404


def test_deploy_first_time_no_rollback(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")

    fake = FakeAsyncClient([FakeResponse(400, {"detail": "rego invalid: line 3"})])
    with patch.object(policies_router.httpx, "AsyncClient", lambda **kw: fake):
        response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    assert response.status_code == 400
    body = response.json()
    assert body["rolled_back"] is False
    assert len(fake.calls) == 1  # no second MADE call for rollback

    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"
    assert stored["active_rego"] is None


def test_deploy_made_unreachable_502_no_rollback(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")

    class Unreachable(FakeAsyncClient):
        async def post(self, url, json=None, **kwargs):
            raise httpx.ConnectError("connection refused")

    with patch_httpx_with(Unreachable)([]):
        response = admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    assert response.status_code == 502
    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["status"] == "draft"


############################
# Audit logging (C3-A)
############################


def audit_entries(client, policy_id="budget-policy-001"):
    return client.get(f"/api/v1/policies/{policy_id}/audit").json()["entries"]


def test_audit_log_on_create(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    entries = audit_entries(admin_client)
    assert len(entries) == 1
    e = entries[0]
    assert e["action"] == "create"
    assert e["user_id"] == "admin-1"
    assert e["before"] is None
    assert "markdown_content" in e["after"]
    assert e["compile_success"] is None


def test_audit_log_on_update(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "New text."})
    e = audit_entries(admin_client)[0]
    assert e["action"] == "update"
    assert e["before"]["markdown_content"] == POLICY["markdown_content"]
    assert e["after"]["markdown_content"] == "New text."


def test_audit_log_on_compile_success(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO, "warnings": []})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    e = audit_entries(admin_client)[0]
    assert e["action"] == "compile"
    assert e["compile_success"] is True
    assert e["compile_error"] is None
    assert e["after"]["compiled_rego"] == VALID_REGO


def test_audit_log_on_compile_error(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(400, {"error": "Markdown is too vague for compilation"})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    e = audit_entries(admin_client)[0]
    assert e["action"] == "compile"
    assert e["compile_success"] is False
    assert "too vague" in e["compile_error"]


def test_audit_log_on_deploy(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    e = audit_entries(admin_client)[0]
    assert e["action"] == "deploy"
    assert e["made_response"]["outcome"] == "ok"
    assert e["after"]["status"] == "active"


def test_audit_log_on_rollback(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")
    admin_client.post("/api/v1/policies/budget-policy-001/rollback")
    e = audit_entries(admin_client)[0]
    assert e["action"] == "rollback"
    assert e["after"]["status"] == "draft"


def test_audit_log_on_delete(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    admin_client.delete("/api/v1/policies/budget-policy-001")
    # trail survives the policy row (audit has no FK to it): create + delete
    entries = audit_entries(admin_client)
    assert [e["action"] for e in entries] == ["delete", "create"]
    assert entries[0]["after"] is None
    assert entries[0]["before"]["id"] == "budget-policy-001"


def test_audit_filter_by_action(admin_client):
    admin_client.post("/api/v1/policies", json=POLICY)
    admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "x"})

    resp = admin_client.get("/api/v1/policies/budget-policy-001/audit", params={"action": "update"})
    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["entries"][0]["action"] == "update"

    resp = admin_client.get("/api/v1/policies/budget-policy-001/audit", params={"action": "deploy"})
    assert resp.json()["total"] == 0

    resp = admin_client.get("/api/v1/policies/budget-policy-001/audit", params={"action": "bogus"})
    assert resp.status_code == 400


def test_audit_unknown_policy_empty(admin_client):
    # no policy-exists check: deleted policies keep their trail readable
    resp = admin_client.get("/api/v1/policies/nope/audit")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


############################
# Versioning (C3-B)
############################


def versions_list(client, policy_id="budget-policy-001"):
    return client.get(f"/api/v1/policies/{policy_id}/versions").json()


def test_version_created_on_first_deploy(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    body = versions_list(admin_client)
    assert body["total"] == 1
    v1 = body["versions"][0]
    assert v1["version_number"] == 1
    assert v1["rego_content"] == VALID_REGO
    assert v1["deployed_by"] == "admin-1"
    # policy points at its latest version
    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["current_version_id"] == v1["id"]


def test_version_number_increments(admin_client, patch_httpx):
    _deploy_flow_to_active(admin_client, patch_httpx)  # deploy v1, rollback → draft
    admin_client.put("/api/v1/policies/budget-policy-001", json={"markdown_content": "tighter"})
    V2 = VALID_REGO + "\ndeny[msg] { input.candidate.cost_per_1k_tokens > 0.01 }\n"
    patch_httpx([FakeResponse(200, {"rego": V2})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    body = versions_list(admin_client)
    assert [v["version_number"] for v in body["versions"]] == [2, 1]
    assert body["versions"][0]["rego_content"] == V2
    assert body["versions"][1]["rego_content"] == VALID_REGO
    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["current_version_id"] == body["versions"][0]["id"]


def test_no_version_on_failed_deploy(admin_client, patch_httpx):
    admin_client.post("/api/v1/policies", json=POLICY)
    patch_httpx([FakeResponse(200, {"rego": VALID_REGO})])
    admin_client.post("/api/v1/policies/budget-policy-001/compile")
    patch_httpx([FakeResponse(400, {"detail": "rego invalid: line 3"})])
    admin_client.post("/api/v1/policies/budget-policy-001/deploy")

    assert versions_list(admin_client)["total"] == 0
    stored = admin_client.get("/api/v1/policies/budget-policy-001").json()
    assert stored["current_version_id"] is None


def test_rollback_creates_no_version(admin_client, patch_httpx):
    _deploy_flow_to_active(admin_client, patch_httpx)
    # only the deploy is versioned, not the rollback (FR-C1)
    assert versions_list(admin_client)["total"] == 1


def test_versions_404(admin_client):
    assert admin_client.get("/api/v1/policies/nope/versions").status_code == 404


############################
# Helpers
############################


def set_active(client):
    """Bootstrap a policy into active state (compile + deploy success)."""
    import open_webui.routers.policies as r

    fake = FakeAsyncClient(
        [
            FakeResponse(200, {"rego": VALID_REGO}),
            FakeResponse(200, {"policy_id": "budget-policy-001", "status": "deployed"}),
        ]
    )
    with patch.object(r.httpx, "AsyncClient", lambda **kw: fake):
        client.post("/api/v1/policies/budget-policy-001/compile")
        client.post("/api/v1/policies/budget-policy-001/deploy")
