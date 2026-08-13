# Route Open WebUI's Chat Completions Through MADE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open WebUI's chat completions get routed through MADE's `POST /decide` (model_selection) before dispatching to a provider — governed by hard constraints + TOPSIS ranking, with a real complexity signal MADE didn't have before, dynamic candidate discovery from Open WebUI's own model registry, and brand-only user-facing model selection with automatic fallback to manual tier selection when MADE has a sustained outage.

**Architecture:** Four independently-testable pieces: (1) MADE gains a `complexity` field on `TaskIn`/`Task` and a third manifest (`epm-high-complexity.yaml`) selected alongside the existing `data_classification`-driven selection — pure Python, in this project's own vendored `MADE/`. (2) A new Open WebUI Filter Function (Python, versioned at `openwebui-filters/made_routing.py` in this repo, NOT under `open-webui/`) that runs as Open WebUI's own inlet-filter extension point — collects candidates from Open WebUI's model registry, classifies message complexity, calls MADE, substitutes the model, and falls back to a static rule on transient failure. (3) A Node provisioning script (`src/openwebui-provision.ts`) that installs the Filter's source into Open WebUI's database via its own API — versioned source, idempotent install. (4) A Node health monitor (`src/openwebui-health-monitor.ts`) that periodically checks MADE and toggles the brand-vs-tier model visibility in Open WebUI accordingly.

## Global Constraints

- No changes to `open-webui/`'s own source — the integration is entirely the new Filter (a Function installed via its own API), never a source-tree edit.
- No changes to `MADE/policies/hard/*.rego` — this plan only adds a new soft-ranking manifest and a new `TaskIn` field, never touches hard-constraint policy files.
- No mandatory/blocking governance — every failure path (MADE unreachable, no eligible candidate, `requires_human_approval`) still lets the chat proceed.
- `WEBUI_SECRET_KEY`-style precedent: new `.env` vars for this plan (`OPENWEBUI_ADMIN_EMAIL`, `OPENWEBUI_ADMIN_PASSWORD`) are Open WebUI automation-account credentials, never LLM provider keys — follow the same "not an LLM key" documentation style already established in `.env.example`.
- Python code in `MADE/` uses this project's existing MADE test conventions (pytest, no fixtures/classes, direct Pydantic model construction — confirmed via `MADE/tests/core/decision/test_engine.py`). Python code in `openwebui-filters/` is a *separate*, minimal Python environment (its own `requirements.txt`, its own `.venv`) — it only needs an HTTP client and a test framework, it never imports MADE's own Python package directly (MADE is reached over HTTP only, consistent with how this project's own Node code already treats MADE).
- TypeScript code in `src/` follows this project's existing conventions (`node --import tsx --test`, no test framework beyond Node's built-in one, `npm test` picks up `tests/**/*.test.ts` automatically).

---

### Task 1: MADE — `complexity` field, new manifest, engine selection logic

**Files:**
- Modify: `MADE/api/schemas.py`
- Modify: `MADE/core/decision/engine.py`
- Create: `MADE/policies/epm-high-complexity.yaml`
- Modify: `MADE/tests/core/decision/test_engine.py`
- Modify: `MADE/tests/api/test_decide.py`

**Interfaces:**
- Produces: `TaskIn.complexity: Literal["low", "medium", "high"] = "medium"` (API-facing) and the parallel `Task.complexity` (engine-internal) — both default to `"medium"` so every existing caller (this project's own `src/chat.ts`/`agent-turn.ts`, which never sends this field) keeps working unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `MADE/tests/core/decision/test_engine.py` (mirroring the existing `test_critical_task_prefers_quality_over_cost` test's structure — two fixed candidates, only the field under test changes between two `decide()` calls):

```python
def test_high_complexity_prefers_quality_over_cost():
    candidates = [
        DecisionCandidate(id="cheap", vendor="v", kind="model", cost_per_1k_tokens=0.001, scores={"cost": 1.0, "quality": 0.3, "latency": 0.9, "business_risk": 0.9}),
        DecisionCandidate(id="premium", vendor="v", kind="model", cost_per_1k_tokens=0.02, scores={"cost": 0.1, "quality": 0.95, "latency": 0.6, "business_risk": 0.8}),
    ]
    org = Org(budget_remaining_usd=1000.0, region="us")

    low_result = decide(
        task=Task(type="chat", data_classification="internal", complexity="low"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )
    high_result = decide(
        task=Task(type="chat", data_classification="internal", complexity="high"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )

    assert low_result.selected_candidate_id == "cheap"
    assert high_result.selected_candidate_id == "premium"


def test_confidential_classification_still_wins_over_low_complexity():
    """data_classification's epm-critical.yaml selection takes priority over complexity — confirms the plan's documented precedence (classification dominates, complexity only matters when classification doesn't already force epm-critical.yaml)."""
    candidates = [
        DecisionCandidate(id="cheap", vendor="v", kind="model", cost_per_1k_tokens=0.001, scores={"cost": 1.0, "quality": 0.3, "latency": 0.9, "business_risk": 0.9}),
        DecisionCandidate(id="premium", vendor="v", kind="model", cost_per_1k_tokens=0.02, scores={"cost": 0.1, "quality": 0.95, "latency": 0.6, "business_risk": 0.8}),
    ]
    org = Org(budget_remaining_usd=1000.0, region="us")

    result = decide(
        task=Task(type="chat", data_classification="confidential", complexity="low"),
        org=org, candidates=candidates, policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id == "premium"
    assert result.technique_used == "topsis"
```

(Both new tests use whatever `DecisionCandidate`, `Org`, `Task`, `decide`, `POLICIES_DIR` imports the existing test file already has at its top — do not re-import, match the file's existing style.)

Add to `MADE/tests/api/test_decide.py` (find the existing test that POSTs a `TaskIn`-shaped body to `/decide` and mirror its structure exactly, adding `"complexity": "high"` to the request's `task` object; if no single obvious test to mirror exists, add a new one following the file's established pattern for constructing a request body and asserting on the JSON response):

```python
def test_decide_accepts_complexity_field(client):
    response = client.post("/decide", json={
        "task": {
            "type": "chat",
            "data_classification": "internal",
            "estimated_context_tokens": 100,
            "complexity": "high",
        },
        "decision_kind": "model_selection",
        "candidates": [
            {"id": "a", "vendor": "v", "kind": "model", "cost_per_1k_tokens": 0.001, "scores": {"cost": 1.0, "quality": 0.5, "latency": 0.9, "business_risk": 0.9}},
        ],
    })
    assert response.status_code == 200
```

(Match `client`'s exact fixture name/setup already used by neighboring tests in this file — do not invent a new fixture if one already exists.)

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `MADE/`, using its own `.venv`): `.venv/bin/pytest tests/core/decision/test_engine.py tests/api/test_decide.py -v`
Expected: FAIL — `Task`/`TaskIn` don't accept `complexity` yet (Pydantic validation error, extra field / or default swallowed silently depending on model config — either way the low/high-complexity ranking assertion fails since nothing branches on it yet), and `epm-high-complexity.yaml` doesn't exist yet.

- [ ] **Step 3: Add the `complexity` field to both `TaskIn` and `Task`**

In `MADE/api/schemas.py`, change:
```python
class TaskIn(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
```
to:
```python
class TaskIn(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
    complexity: Literal["low", "medium", "high"] = "medium"
```

In `MADE/core/decision/engine.py`, change:
```python
class Task(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
```
to:
```python
class Task(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
    complexity: Literal["low", "medium", "high"] = "medium"
```

- [ ] **Step 4: Create the new manifest**

Create `MADE/policies/epm-high-complexity.yaml`:

```yaml
version: 1
objectives:
  - name: cost
    direction: minimize
    weight: 0.15
  - name: quality
    direction: maximize
    weight: 0.6
  - name: latency
    direction: minimize
    weight: 0.15
  - name: business_risk
    direction: minimize
    weight: 0.1
technique: topsis
```

(Weights sum to 1.0, matching `load_epm_manifest`'s validation. Quality weighted higher than the default `epm.yaml` (0.4) but lower than `epm-critical.yaml` (0.7) — a high-complexity *task* deserves more weight on quality than routine chat, but this is a capability concern, not the same as `epm-critical.yaml`'s compliance-driven "confidential data" concern, so it gets its own, less extreme profile.)

- [ ] **Step 5: Wire manifest selection to check `complexity` too, with `data_classification` taking precedence**

In `MADE/core/decision/engine.py`, change:
```python
    manifest_name = "epm-critical.yaml" if task.data_classification in ("confidential", "restricted") else "epm.yaml"
```
to:
```python
    if task.data_classification in ("confidential", "restricted"):
        manifest_name = "epm-critical.yaml"
    elif task.complexity == "high":
        manifest_name = "epm-high-complexity.yaml"
    else:
        manifest_name = "epm.yaml"
```

(`data_classification` deliberately wins over `complexity` when both would apply — confidential/restricted data's compliance concern is not something a high-complexity *task* should be able to relax. This is exactly what `test_confidential_classification_still_wins_over_low_complexity` from Step 1 asserts.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/core/decision/test_engine.py tests/api/test_decide.py -v`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 7: Run MADE's full test suite**

Run (from `MADE/`): `.venv/bin/pytest`
Expected: all passing — `complexity`'s default value (`"medium"`) means every pre-existing test that never sets it keeps behaving exactly as before (routes to `epm.yaml` when classification doesn't force `epm-critical.yaml`, same as today).

- [ ] **Step 8: Commit**

```bash
git add MADE/api/schemas.py MADE/core/decision/engine.py MADE/policies/epm-high-complexity.yaml MADE/tests/core/decision/test_engine.py MADE/tests/api/test_decide.py
git commit -m "feat(MADE): add complexity signal to TaskIn, new epm-high-complexity.yaml manifest"
```

---

### Task 2: Open WebUI Filter — MADE-routing inlet function

**Files:**
- Create: `openwebui-filters/made_routing.py`
- Create: `openwebui-filters/requirements.txt`
- Create: `openwebui-filters/tests/test_made_routing.py`
- Create: `openwebui-filters/tests/__init__.py` (empty, makes the tests dir a package if the chosen test runner needs it — confirm during implementation whether pytest's default rootdir discovery needs this; omit if not)

**Interfaces:**
- Consumes: MADE's `POST /decide` (Task 1's new `complexity` field is optional server-side with a default, so this Filter can omit it entirely for a minimal first version, or set it — this task sets it, calling the classifier from Step 5 below).
- Produces: `class Filter` with `async def inlet(self, body: dict, __user__: dict = None) -> dict` — the actual code Task 3's provisioning script installs verbatim (byte-for-byte) as this Function's `content`.

- [ ] **Step 1: Set up the filter's own minimal Python environment**

```bash
mkdir -p openwebui-filters/tests
cd openwebui-filters
python3 -m venv .venv
```

Create `openwebui-filters/requirements.txt`:
```
requests==2.34.2
pytest==8.3.4
requests-mock==1.12.1
```

```bash
.venv/bin/pip install -r requirements.txt
```

- [ ] **Step 2: Write the failing tests**

Create `openwebui-filters/tests/test_made_routing.py`:

```python
import sys
import os
import requests_mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from made_routing import Filter


def make_filter():
    f = Filter()
    f.valves.MADE_URL = "http://made:8000"
    f.valves.OPENWEBUI_URL = "http://open-webui:8080"
    f.valves.OPENWEBUI_TOKEN = "test-token"
    f.valves.CLASSIFIER_MODEL = "deepseek-v4-flash"
    return f


BRAND_MODEL = {
    "id": "deepseek",
    "meta": {"made_scores": {"brand": "deepseek"}},
}
TIER_MODELS = [
    {
        "id": "deepseek-v4-flash",
        "is_active": False,
        "meta": {"made_scores": {"brand": "deepseek", "cost_per_1k_tokens": 0.0005, "quality": 0.6, "latency": 0.9, "business_risk": 0.9, "context_window_tokens": 32000}},
    },
    {
        "id": "deepseek-v4-pro",
        "is_active": False,
        "meta": {"made_scores": {"brand": "deepseek", "cost_per_1k_tokens": 0.003, "quality": 0.9, "latency": 0.6, "business_risk": 0.8, "context_window_tokens": 128000}},
    },
]


async def test_inlet_passes_through_when_model_is_already_a_tier():
    f = make_filter()
    body = {"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "hi"}]}

    result = await f.inlet(body, __user__={"id": "u1"})

    assert result["model"] == "deepseek-v4-flash"


async def test_inlet_calls_made_and_substitutes_model_for_brand_selection(requests_mock_fixture=None):
    with requests_mock.Mocker() as m:
        m.get(
            "http://open-webui:8080/api/v1/models/list",
            json={"data": [BRAND_MODEL] + TIER_MODELS},
        )
        m.post(
            "http://made:8000/decide",
            [
                {"json": {"content": "3"}},  # complexity classifier call (mocked as an OpenAI-style completion)
            ],
        )
        m.post(
            "http://made:8000/decide",
            json={
                "decision_id": "d1", "selected_candidate_id": "deepseek-v4-pro",
                "requires_human_approval": False, "ranking": [], "excluded": [],
                "technique_used": "topsis", "policy_version": "1",
            },
        )
        f = make_filter()
        body = {"model": "deepseek", "messages": [{"role": "user", "content": "explain quantum computing rigorously"}]}

        result = await f.inlet(body, __user__={"id": "u1"})

        assert result["model"] == "deepseek-v4-pro"


async def test_inlet_falls_back_to_cheapest_qualifying_tier_when_made_unreachable():
    with requests_mock.Mocker() as m:
        m.get(
            "http://open-webui:8080/api/v1/models/list",
            json={"data": [BRAND_MODEL] + TIER_MODELS},
        )
        m.post("http://made:8000/decide", exc=Exception("connection refused"))
        f = make_filter()
        body = {"model": "deepseek", "messages": [{"role": "user", "content": "hi"}]}

        result = await f.inlet(body, __user__={"id": "u1"})

        assert result["model"] == "deepseek-v4-flash"  # cheapest of the two tiers
```

(Exact HTTP mock shapes above are illustrative of the contract — adjust field names during implementation to match whatever `collect_candidates`/`call_made`/`classify_complexity` you actually write in Step 4 emit and expect; the test file's job is to pin down real, working behavior, not to match this brief byte-for-byte if a cleaner internal shape emerges. Async test functions need `pytest-asyncio` or an `asyncio.run(...)` wrapper — add `pytest-asyncio==0.24.0` to `requirements.txt` if you use bare `async def test_...` functions, or wrap each test body in `asyncio.run()` if you'd rather not add that dependency; either is fine, pick the one with less code.)

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `openwebui-filters/`): `.venv/bin/pytest tests/ -v`
Expected: FAIL — `made_routing.py` doesn't exist yet.

- [ ] **Step 4: Implement the Filter**

Create `openwebui-filters/made_routing.py`:

```python
"""
Open WebUI inlet Filter that routes chat completions through MADE's
POST /decide instead of using the user's raw model selection verbatim.

This file is the SOURCE OF TRUTH — src/openwebui-provision.ts installs this
exact content into Open WebUI's own database via its Functions API. Editing
Open WebUI's Function directly through its admin UI will be silently
overwritten the next time the provisioning script runs.
"""
import requests
from pydantic import BaseModel


class Filter:
    class Valves(BaseModel):
        MADE_URL: str = "http://made:8000"
        OPENWEBUI_URL: str = "http://open-webui:8080"
        OPENWEBUI_TOKEN: str = ""
        CLASSIFIER_MODEL: str = "deepseek-v4-flash"
        REQUEST_TIMEOUT_SECONDS: float = 8.0

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
        model_id = body.get("model", "")
        try:
            models = self._list_models()
        except Exception:
            return body  # can't even see the model registry — leave untouched

        brand_candidates = [m for m in models if _brand_of(m) and _brand_of(m) == _brand_of_id(models, model_id)]
        if len(brand_candidates) <= 1:
            # model_id is not a brand entry (it's already a real tier, or unknown) — nothing to route
            return body

        complexity = self._classify_complexity(body)
        try:
            selected = self._call_made(brand_candidates, complexity, body)
            if selected and any(c["id"] == selected for c in brand_candidates):
                body["model"] = selected
                return body
        except Exception:
            pass

        body["model"] = _cheapest_qualifying(brand_candidates)
        return body

    def _list_models(self) -> list[dict]:
        resp = requests.get(
            f"{self.valves.OPENWEBUI_URL}/api/v1/models/list",
            headers={"Authorization": f"Bearer {self.valves.OPENWEBUI_TOKEN}"},
            timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        return resp.json().get("data", [])

    def _classify_complexity(self, body: dict) -> str:
        last_user_message = next(
            (m["content"] for m in reversed(body.get("messages", [])) if m.get("role") == "user"),
            "",
        )
        try:
            resp = requests.post(
                f"{self.valves.OPENWEBUI_URL}/api/chat/completions",
                headers={"Authorization": f"Bearer {self.valves.OPENWEBUI_TOKEN}"},
                json={
                    "model": self.valves.CLASSIFIER_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": "Rate the complexity of the user's message as exactly one word: low, medium, or high. Reply with only that word.",
                        },
                        {"role": "user", "content": last_user_message},
                    ],
                    "stream": False,
                },
                timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            text = resp.json()["choices"][0]["message"]["content"].strip().lower()
            return text if text in ("low", "medium", "high") else "medium"
        except Exception:
            return "medium"

    def _call_made(self, brand_candidates: list[dict], complexity: str, body: dict) -> str | None:
        candidates = []
        for m in brand_candidates:
            scores = m.get("meta", {}).get("made_scores", {})
            if "brand" not in scores or scores.get("cost_per_1k_tokens") is None:
                continue  # skip the brand entry itself and any un-scored model
            candidates.append({
                "id": m["id"],
                "vendor": scores.get("brand", "unknown"),
                "kind": "model",
                "cost_per_1k_tokens": scores.get("cost_per_1k_tokens", 0.01),
                "scores": {
                    "cost": 1.0 - min(scores.get("cost_per_1k_tokens", 0.01) / 0.05, 1.0),
                    "quality": scores.get("quality", 0.5),
                    "latency": scores.get("latency", 0.5),
                    "business_risk": scores.get("business_risk", 0.5),
                },
                "context_window_tokens": scores.get("context_window_tokens"),
            })

        estimated_tokens = sum(len(m.get("content", "")) for m in body.get("messages", [])) // 4

        resp = requests.post(
            f"{self.valves.MADE_URL}/decide",
            json={
                "task": {
                    "type": "chat",
                    "data_classification": "internal",
                    "estimated_context_tokens": estimated_tokens,
                    "complexity": complexity,
                },
                "decision_kind": "model_selection",
                "candidates": candidates,
            },
            timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        decision = resp.json()
        if decision.get("requires_human_approval"):
            return None
        return decision.get("selected_candidate_id")


def _brand_of(model: dict) -> str | None:
    return model.get("meta", {}).get("made_scores", {}).get("brand")


def _brand_of_id(models: list[dict], model_id: str) -> str | None:
    match = next((m for m in models if m["id"] == model_id), None)
    return _brand_of(match) if match else None


def _cheapest_qualifying(brand_candidates: list[dict], min_quality: float = 0.4) -> str:
    scored = [
        (m["id"], m.get("meta", {}).get("made_scores", {}))
        for m in brand_candidates
        if m.get("meta", {}).get("made_scores", {}).get("cost_per_1k_tokens") is not None
    ]
    qualifying = [(mid, s) for mid, s in scored if s.get("quality", 0) >= min_quality]
    pool = qualifying if qualifying else scored
    return min(pool, key=lambda pair: pair[1].get("cost_per_1k_tokens", 999))[0]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/ -v`
Expected: PASS (all tests). If the illustrative mocks in Step 2 don't line up exactly with what this implementation calls (e.g. `_classify_complexity`'s endpoint/response shape), adjust the TEST file to match the real, working request/response shapes this implementation actually produces — the implementation in this step is the one that must be correct and minimal; the test's exact mock payloads are secondary as long as they exercise the same three real code paths (pass-through, MADE success, MADE failure/fallback).

- [ ] **Step 6: Commit**

```bash
git add openwebui-filters/
git commit -m "feat: MADE-routing inlet Filter for Open WebUI"
```

---

### Task 3: Provisioning script — install the Filter into Open WebUI

**Files:**
- Create: `src/openwebui-provision.ts`
- Create: `tests/openwebui-provision.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `openwebui-filters/made_routing.py`'s file content (read from disk).
- Produces: `provisionFilter(deps): Promise<{ok: boolean; error?: string}>`, callable as a script (`node --import tsx src/openwebui-provision.ts`) and unit-testable via injected dependencies (matching this project's existing `deps`-injection pattern already used throughout `src/`, e.g. `ChatDeps`/`AgentTurnDeps`).

- [ ] **Step 1: Add the new `.env.example` vars**

Append to `.env.example`:
```
# Automation account Open WebUI uses to install/update the MADE-routing
# Filter and to run the health monitor — NOT an LLM API key, just this
# dedicated admin account's own login (create it once via Open WebUI's
# sign-up screen, mark it admin).
OPENWEBUI_URL=http://open-webui:8080
OPENWEBUI_ADMIN_EMAIL=
OPENWEBUI_ADMIN_PASSWORD=
```

(Bare `npm run dev`, no-Docker block: this project's `.env.example` already has a commented-out "Bare npm run dev" section with `localhost`-based URLs mirroring the Docker block — add `OPENWEBUI_URL=http://localhost:3001` there too, commented out alongside the others, matching the file's existing structure.)

- [ ] **Step 2: Write the failing tests**

Create `tests/openwebui-provision.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionFilter } from "../src/openwebui-provision.ts";

test("provisionFilter() signs in then syncs the Filter's content", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/sync")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.functions[0].id, "made_routing");
      assert.equal(body.functions[0].type, "filter");
      assert.match(body.functions[0].content, /class Filter/);
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer tok-123");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/functions/sync")));
});

test("provisionFilter() returns ok:false with an error message when sign-in fails", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: "invalid credentials" }), { status: 400 });

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "wrong",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid credentials|sign-?in failed/i);
});

test("provisionFilter() is idempotent: running it twice sends the same sync payload both times", async () => {
  let syncBodies: unknown[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/sync")) {
      syncBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const deps = {
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  };

  await provisionFilter(deps);
  await provisionFilter(deps);

  assert.equal(syncBodies.length, 2);
  assert.deepEqual(syncBodies[0], syncBodies[1]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/openwebui-provision.test.ts`
Expected: FAIL — `src/openwebui-provision.ts` doesn't exist yet.

- [ ] **Step 4: Implement the provisioning script**

Create `src/openwebui-provision.ts`:

```ts
import { readFile } from "node:fs/promises";

export interface ProvisionDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  filterSourcePath: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

export async function provisionFilter(deps: ProvisionDeps): Promise<ProvisionResult> {
  const fetchFn = deps.fetchFn ?? fetch;

  const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
  });
  const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
  if (!signinRes.ok || !signinBody.token) {
    return { ok: false, error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}` };
  }

  const content = await readFile(deps.filterSourcePath, "utf8");
  const now = Math.floor(Date.now() / 1000);

  const syncRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signinBody.token}`,
    },
    body: JSON.stringify({
      functions: [
        {
          id: "made_routing",
          name: "MADE Routing",
          type: "filter",
          content,
          meta: { description: "Routes chat completions through MADE's /decide before dispatch" },
          is_active: true,
          is_global: true,
          created_at: now,
          updated_at: now,
        },
      ],
    }),
  });

  if (!syncRes.ok) {
    const body = (await syncRes.json().catch(() => ({}))) as { detail?: string };
    return { ok: false, error: body.detail ?? `functions/sync failed with status ${syncRes.status}` };
  }

  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openwebuiUrl = process.env.OPENWEBUI_URL ?? "http://localhost:3001";
  const adminEmail = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
  const filterSourcePath = new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname;

  provisionFilter({ openwebuiUrl, adminEmail, adminPassword, filterSourcePath }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    console.log("MADE-routing Filter provisioned successfully.");
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/openwebui-provision.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test` and `npx tsc --noEmit`
Expected: all passing, clean

- [ ] **Step 7: Commit**

```bash
git add src/openwebui-provision.ts tests/openwebui-provision.test.ts .env.example
git commit -m "feat: provisioning script installs the MADE-routing Filter into Open WebUI"
```

---

### Task 4: Health monitor — toggle brand/tier visibility based on MADE's health

**Files:**
- Create: `src/openwebui-health-monitor.ts`
- Create: `tests/openwebui-health-monitor.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces: `checkAndSyncVisibility(deps): Promise<{madeHealthy: boolean; changed: boolean}>` (one check-and-act cycle, unit-testable), and `startHealthMonitor(deps): { stop(): void }` (wraps it in a `setInterval`, called once from `server.ts`'s own startup block).

- [ ] **Step 1: Write the failing tests**

Create `tests/openwebui-health-monitor.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAndSyncVisibility } from "../src/openwebui-health-monitor.ts";

function fakeModelsList(models: Array<{ id: string; is_active: boolean; brand?: string }>) {
  return { data: models.map((m) => ({ id: m.id, is_active: m.is_active, meta: { made_scores: m.brand ? { brand: m.brand } : {} } })) };
}

test("checkAndSyncVisibility() activates the brand entry and deactivates tiers when MADE is healthy", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000") || u.includes("/decide")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: false, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-pro", is_active: true, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, true);
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(toggled), new Set(["deepseek", "deepseek-v4-flash", "deepseek-v4-pro"]));
});

test("checkAndSyncVisibility() activates tiers and deactivates the brand entry when MADE is unreachable", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("made:8000")) throw new Error("connection refused");
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: false, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, false);
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(toggled), new Set(["deepseek", "deepseek-v4-flash"]));
});

test("checkAndSyncVisibility() does not toggle anything when the current state already matches", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("made:8000")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: false, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.changed, false);
  assert.deepEqual(toggled, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/openwebui-health-monitor.test.ts`
Expected: FAIL — `src/openwebui-health-monitor.ts` doesn't exist yet.

- [ ] **Step 3: Implement the health monitor**

Create `src/openwebui-health-monitor.ts`:

```ts
export interface HealthCheckDeps {
  madeUrl: string;
  openwebuiUrl: string;
  adminToken: string;
  fetchFn?: typeof fetch;
}

export interface HealthCheckResult {
  madeHealthy: boolean;
  changed: boolean;
}

interface OpenWebUiModel {
  id: string;
  is_active: boolean;
  meta?: { made_scores?: { brand?: string } };
}

async function isMadeHealthy(madeUrl: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${madeUrl}/decide`, { method: "GET" });
    // MADE's /decide only accepts POST; a GET reaching it (even a 405) proves the process is up.
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function checkAndSyncVisibility(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const madeHealthy = await isMadeHealthy(deps.madeUrl, fetchFn);

  const listRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/models/list`, {
    headers: { authorization: `Bearer ${deps.adminToken}` },
  });
  const { data: models } = (await listRes.json()) as { data: OpenWebUiModel[] };

  const brandedModels = models.filter((m) => m.meta?.made_scores?.brand);
  const byBrand = new Map<string, OpenWebUiModel[]>();
  for (const m of brandedModels) {
    const brand = m.meta!.made_scores!.brand!;
    byBrand.set(brand, [...(byBrand.get(brand) ?? []), m]);
  }

  let changed = false;
  for (const brandModels of byBrand.values()) {
    // Heuristic: the brand entry is the one whose id matches its own brand string;
    // every other model in the group is a tier.
    for (const m of brandModels) {
      const isBrandEntry = m.id === m.meta!.made_scores!.brand;
      const wantActive = isBrandEntry ? madeHealthy : !madeHealthy;
      if (m.is_active !== wantActive) {
        changed = true;
        await fetchFn(`${deps.openwebuiUrl}/api/v1/models/model/toggle?id=${encodeURIComponent(m.id)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.adminToken}` },
        });
      }
    }
  }

  return { madeHealthy, changed };
}

export function startHealthMonitor(deps: HealthCheckDeps & { intervalMs?: number }): { stop(): void } {
  const intervalMs = deps.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    checkAndSyncVisibility(deps).catch((err) => console.error("health monitor cycle failed:", err));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/openwebui-health-monitor.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire `startHealthMonitor` into `server.ts`'s startup block**

In `src/server.ts`, find:
```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });
}
```
and change it to:
```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });

  const openwebuiAdminToken = process.env.OPENWEBUI_HEALTH_MONITOR_TOKEN;
  if (openwebuiAdminToken) {
    startHealthMonitor({
      madeUrl: process.env.MADE_URL ?? "http://made:8000",
      openwebuiUrl: process.env.OPENWEBUI_URL ?? "http://open-webui:8080",
      adminToken: openwebuiAdminToken,
    });
  }
}
```
and add the import at the top of the file (alongside the other imports):
```ts
import { startHealthMonitor } from "./openwebui-health-monitor.ts";
```

(`OPENWEBUI_HEALTH_MONITOR_TOKEN` — a fresh admin JWT, not the raw email/password — is deliberately a separate manual step from Task 3's provisioning script; see Task 5's runbook for how to obtain it. Gating the monitor on this var being present means a fresh deploy without it configured yet simply doesn't run the monitor, rather than crashing the whole server on startup.)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test` and `npx tsc --noEmit`
Expected: all passing, clean

- [ ] **Step 7: Commit**

```bash
git add src/openwebui-health-monitor.ts tests/openwebui-health-monitor.test.ts src/server.ts
git commit -m "feat: health monitor toggles Open WebUI brand/tier model visibility based on MADE's health"
```

---

### Task 5: Manual setup runbook (no code — a documented one-time procedure)

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — this task documents manual steps that can't be automated per the design spec's own Non-goals (brand-entry creation and per-tier score assignment are deliberately manual, via Open WebUI's existing UI).

- [ ] **Step 1: Add a new subsection to `CLAUDE.md`'s Docker/Open WebUI paragraph area**

After the existing paragraph documenting `open-webui`'s deployment (the one starting "Open WebUI is reachable at `http://localhost:3001`..."), add:

```markdown
**MADE-routing setup (one-time, manual, after `open-webui` is up):**
1. Create an automation admin account by signing up a second time with a
   dedicated email (or reuse your first admin account) — put its
   credentials in `.env` as `OPENWEBUI_ADMIN_EMAIL`/`OPENWEBUI_ADMIN_PASSWORD`.
2. Run `node --import tsx src/openwebui-provision.ts` to install the
   MADE-routing Filter (`openwebui-filters/made_routing.py`) into Open
   WebUI. Re-run this any time the Filter's source changes, or after a
   fresh volume/deploy.
3. In Open WebUI's Admin Settings → Models, create the tier models for
   each brand (e.g. `deepseek-v4-flash`, `deepseek-v4-pro`), each with a
   `meta.made_scores` object: `{ "brand": "deepseek", "cost_per_1k_tokens":
   <num>, "quality": <0-1>, "latency": <0-1>, "business_risk": <0-1>,
   "context_window_tokens": <num> }`.
4. Create one brand entry per brand (e.g. id `deepseek`) — `base_model_id`
   pointing at any one of that brand's tiers (MADE overrides it on every
   call while healthy), `meta.made_scores` = `{ "brand": "deepseek" }`
   only (no cost/quality/etc — this is what the Filter and health monitor
   use to recognize it as the brand entry, not a real tier).
5. To enable the health monitor: sign in as the automation admin
   (`POST /api/v1/auths/signin`) to get a token, set it as
   `OPENWEBUI_HEALTH_MONITOR_TOKEN` in `.env`, restart the `app` service.
   This token is separate from step 1's email/password on purpose — the
   monitor only needs read + toggle access, not the ability to re-run
   sign-in itself.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document MADE-routing one-time manual setup"
```

---

## Manual verification (recommended)

Automated coverage in this plan is real (MADE's Python tests, the Filter's
Python tests, both Node scripts' tests) — but the actual end-to-end
governance behavior only shows up with all pieces wired together and Open
WebUI genuinely running:

1. Complete Task 5's runbook against a real running stack.
2. Send a chat in Open WebUI, picking the brand entry (not a tier).
3. Confirm via `docker compose logs made` (or MADE's own decision log, if
   one exists) that `/decide` was actually called, and that the reply
   came from whichever tier MADE selected — not silently the brand
   entry's own `base_model_id` default.
4. Stop the `made` service (`docker compose stop made`), wait for one
   health-monitor interval, confirm the tier models reappear in Open
   WebUI's dropdown and the brand entry disappears. Send a chat picking a
   tier directly — confirm it works with no MADE call at all (per Task
   2's pass-through branch). Restart `made`, wait one more interval,
   confirm visibility flips back.
