# MADE Prototype v1 (EPM + MODM, Model & Tool Selection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working MADE service (FastAPI) that filters candidate AI models/tools through hard-constraint policies (OPA/Rego) and ranks the survivors with a multi-objective technique (weighted-sum or TOPSIS), for `model_selection`, `tool_selection`, and `human_approval` decisions — corresponding to Fase 3-8 / T1-T16 in `docs/TASKS_MADE.md`.

**Architecture:** Core decision logic (`core/epm`, `core/modm`, `core/decision`) is a plain Python package with no HTTP dependency, so it can be called in-process by a batch harness later. `api/` is a thin FastAPI layer that validates requests, calls `core.decision.decide`, and logs each decision to SQLite (`storage/`). Hard constraints live as Rego files evaluated by a real OPA binary (subprocess); soft preferences live in `policies/epm.yaml`.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, SQLModel (SQLite), PyYAML, OPA (external binary, not a Python dependency), pytest, httpx.

## Global Constraints

- Python >=3.11, dependencies pinned with lower bounds only (see Task 1 `pyproject.toml`).
- OPA CLI must be installed and on `PATH` (`opa version` must succeed) — this is an external prerequisite, not something this plan installs.
- Fail-closed: any OPA error must surface as HTTP 503, never silently treated as "allow" (per `docs/ARCHITECTURE_MADE.md` §4).
- `policies/` (EPM: `.rego` + `epm.yaml`) is file-based and version-controlled — never write generated policy content into SQLite.
- Every source file gets a corresponding test file; no task is complete without its tests passing.
- Commit after every task (see Task Structure below) — this repo is not yet a git repo, so Task 1 initializes it.

---

## File Structure Overview

```
pyproject.toml
.gitignore
core/
  __init__.py
  modm/
    __init__.py
    models.py          # Objective, Candidate, RankingEntry, Ranking
    weighted_sum.py
    topsis.py
  epm/
    __init__.py
    loader.py           # EpmManifest, load_epm_manifest, EpmValidationError
    opa_client.py        # evaluate_hard_constraints, OpaEvaluationError
  decision/
    __init__.py
    engine.py            # Task, Org, DecisionCandidate, DecisionResult, decide()
api/
  __init__.py
  schemas.py             # request/response Pydantic models
  main.py                # FastAPI app: POST /decide, GET /policies/{policy_set}
storage/
  __init__.py
  models.py              # DecisionRecord (SQLModel table)
  db.py                  # make_engine, get_session
policies/
  epm.yaml
  hard/
    base.rego
    compliance.rego
    security.rego
    privacy.rego
    cost.rego
    approval.rego
    base_test.rego
    compliance_test.rego
    security_test.rego
    privacy_test.rego
    cost_test.rego
    approval_test.rego
config/
  candidates.yaml         # sample registered models/tools for the manual smoke test
scripts/
  manual_smoke_test.py
tests/
  core/
    modm/test_weighted_sum.py
    modm/test_topsis.py
    epm/test_loader.py
    epm/test_opa_client.py
    decision/test_engine.py
  api/
    test_decide.py
    test_policies_endpoint.py
  storage/
    test_db.py
```

---

### Task 1: Project scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Create: `core/__init__.py`, `core/modm/__init__.py`, `core/epm/__init__.py`, `core/decision/__init__.py`
- Create: `api/__init__.py`
- Create: `storage/__init__.py`
- Create: `tests/__init__.py`, `tests/core/__init__.py`, `tests/core/modm/__init__.py`, `tests/core/epm/__init__.py`, `tests/core/decision/__init__.py`, `tests/api/__init__.py`, `tests/storage/__init__.py`

**Interfaces:**
- Produces: an installable local package layout importable as `core.*`, `api.*`, `storage.*` from repo root; `pytest` runnable from repo root.

- [ ] **Step 1: Initialize git and verify OPA is installed**

```bash
git init
opa version
```

Expected: `git init` succeeds; `opa version` prints a version string. If `opa version` fails with "command not found", stop and install OPA first (https://www.openpolicyagent.org/docs/latest/#running-opa) — every later task depends on it.

- [ ] **Step 2: Write `pyproject.toml`**

```toml
[project]
name = "made"
version = "0.1.0"
description = "Multi-Objective Agent Decision Engine (EPM+MODM) prototype"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "pydantic>=2.9",
    "sqlmodel>=0.0.22",
    "pyyaml>=6.0",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
]

[tool.pytest.ini_options]
pythonpath = ["."]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
```

- [ ] **Step 3: Write `.gitignore`**

```
__pycache__/
*.pyc
.venv/
*.db
.pytest_cache/
*.egg-info/
```

- [ ] **Step 4: Create package directories with empty `__init__.py` files**

```bash
mkdir -p core/modm core/epm core/decision api storage policies/hard config scripts \
  tests/core/modm tests/core/epm tests/core/decision tests/api tests/storage
touch core/__init__.py core/modm/__init__.py core/epm/__init__.py core/decision/__init__.py \
  api/__init__.py storage/__init__.py \
  tests/__init__.py tests/core/__init__.py tests/core/modm/__init__.py \
  tests/core/epm/__init__.py tests/core/decision/__init__.py tests/api/__init__.py tests/storage/__init__.py
```

- [ ] **Step 5: Install dependencies and verify pytest runs (with zero tests)**

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

Expected: pytest reports "no tests ran" (exit code 5) — not an import error.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore core api storage tests
git commit -m "chore: scaffold MADE project structure"
```

---

### Task 2: MODM data models + weighted-sum technique

**Files:**
- Create: `core/modm/models.py`
- Create: `core/modm/weighted_sum.py`
- Test: `tests/core/modm/test_weighted_sum.py`

**Interfaces:**
- Produces: `Objective(name: str, direction: str, weight: float)`, `Candidate(id: str, scores: dict[str, float])`, `RankingEntry(id: str, score: float)`, `Ranking(entries: list[RankingEntry])` with `Ranking.best -> RankingEntry | None`; `weighted_sum(candidates: list[Candidate], objectives: list[Objective]) -> Ranking`.

- [ ] **Step 1: Write `core/modm/models.py`**

```python
from pydantic import BaseModel


class Objective(BaseModel):
    name: str
    direction: str  # "minimize" | "maximize"
    weight: float


class Candidate(BaseModel):
    id: str
    scores: dict[str, float]  # objective name -> raw score


class RankingEntry(BaseModel):
    id: str
    score: float


class Ranking(BaseModel):
    entries: list[RankingEntry]  # sorted descending by score

    @property
    def best(self) -> RankingEntry | None:
        return self.entries[0] if self.entries else None
```

- [ ] **Step 2: Write the failing test for weighted-sum**

```python
# tests/core/modm/test_weighted_sum.py
from core.modm.models import Candidate, Objective
from core.modm.weighted_sum import weighted_sum


def test_prefers_cheaper_higher_quality_candidate():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0, "quality": 1.0}),
        Candidate(id="b", scores={"cost": 1.0, "quality": 0.0}),
    ]
    objectives = [
        Objective(name="cost", direction="minimize", weight=0.5),
        Objective(name="quality", direction="maximize", weight=0.5),
    ]

    ranking = weighted_sum(candidates, objectives)

    assert ranking.best.id == "a"
    assert ranking.entries[0].score == 1.0
    assert ranking.entries[1].score == 0.0


def test_empty_candidates_returns_empty_ranking():
    ranking = weighted_sum([], [Objective(name="cost", direction="minimize", weight=1.0)])
    assert ranking.entries == []
    assert ranking.best is None


def test_identical_scores_all_tie_at_full_score():
    candidates = [
        Candidate(id="a", scores={"cost": 5.0}),
        Candidate(id="b", scores={"cost": 5.0}),
    ]
    objectives = [Objective(name="cost", direction="minimize", weight=1.0)]

    ranking = weighted_sum(candidates, objectives)

    assert {e.score for e in ranking.entries} == {1.0}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/core/modm/test_weighted_sum.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.modm.weighted_sum'`

- [ ] **Step 4: Write `core/modm/weighted_sum.py`**

```python
from core.modm.models import Candidate, Objective, Ranking, RankingEntry


def weighted_sum(candidates: list[Candidate], objectives: list[Objective]) -> Ranking:
    if not candidates:
        return Ranking(entries=[])

    mins = {obj.name: min(c.scores[obj.name] for c in candidates) for obj in objectives}
    maxs = {obj.name: max(c.scores[obj.name] for c in candidates) for obj in objectives}

    entries = []
    for candidate in candidates:
        total = 0.0
        for obj in objectives:
            lo, hi = mins[obj.name], maxs[obj.name]
            raw = candidate.scores[obj.name]
            if hi == lo:
                normalized = 1.0
            elif obj.direction == "maximize":
                normalized = (raw - lo) / (hi - lo)
            else:
                normalized = (hi - raw) / (hi - lo)
            total += normalized * obj.weight
        entries.append(RankingEntry(id=candidate.id, score=total))

    entries.sort(key=lambda e: e.score, reverse=True)
    return Ranking(entries=entries)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/core/modm/test_weighted_sum.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add core/modm/models.py core/modm/weighted_sum.py tests/core/modm/test_weighted_sum.py
git commit -m "feat: add MODM models and weighted-sum ranking technique"
```

---

### Task 3: TOPSIS technique

**Files:**
- Create: `core/modm/topsis.py`
- Test: `tests/core/modm/test_topsis.py`

**Interfaces:**
- Consumes: `Candidate`, `Objective`, `Ranking`, `RankingEntry` from `core.modm.models` (Task 2).
- Produces: `topsis(candidates: list[Candidate], objectives: list[Objective]) -> Ranking` — same signature as `weighted_sum`, interchangeable by callers.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/modm/test_topsis.py
from core.modm.models import Candidate, Objective
from core.modm.topsis import topsis


def test_prefers_cheaper_higher_quality_candidate():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0, "quality": 1.0}),
        Candidate(id="b", scores={"cost": 1.0, "quality": 0.0}),
    ]
    objectives = [
        Objective(name="cost", direction="minimize", weight=0.5),
        Objective(name="quality", direction="maximize", weight=0.5),
    ]

    ranking = topsis(candidates, objectives)

    assert ranking.best.id == "a"
    assert ranking.entries[0].score > ranking.entries[1].score


def test_empty_candidates_returns_empty_ranking():
    ranking = topsis([], [Objective(name="cost", direction="minimize", weight=1.0)])
    assert ranking.entries == []
    assert ranking.best is None


def test_all_zero_scores_does_not_raise_division_error():
    candidates = [
        Candidate(id="a", scores={"cost": 0.0}),
        Candidate(id="b", scores={"cost": 0.0}),
    ]
    objectives = [Objective(name="cost", direction="minimize", weight=1.0)]

    ranking = topsis(candidates, objectives)

    assert len(ranking.entries) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/modm/test_topsis.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.modm.topsis'`

- [ ] **Step 3: Write `core/modm/topsis.py`**

```python
import math

from core.modm.models import Candidate, Objective, Ranking, RankingEntry


def topsis(candidates: list[Candidate], objectives: list[Objective]) -> Ranking:
    if not candidates:
        return Ranking(entries=[])

    norms = {}
    for obj in objectives:
        denom = math.sqrt(sum(c.scores[obj.name] ** 2 for c in candidates))
        norms[obj.name] = denom if denom > 0 else 1.0

    weighted = {
        c.id: {
            obj.name: (c.scores[obj.name] / norms[obj.name]) * obj.weight
            for obj in objectives
        }
        for c in candidates
    }

    ideal_best: dict[str, float] = {}
    ideal_worst: dict[str, float] = {}
    for obj in objectives:
        values = [weighted[c.id][obj.name] for c in candidates]
        if obj.direction == "maximize":
            ideal_best[obj.name] = max(values)
            ideal_worst[obj.name] = min(values)
        else:
            ideal_best[obj.name] = min(values)
            ideal_worst[obj.name] = max(values)

    entries = []
    for candidate in candidates:
        dist_best = math.sqrt(sum(
            (weighted[candidate.id][obj.name] - ideal_best[obj.name]) ** 2 for obj in objectives
        ))
        dist_worst = math.sqrt(sum(
            (weighted[candidate.id][obj.name] - ideal_worst[obj.name]) ** 2 for obj in objectives
        ))
        denom = dist_best + dist_worst
        closeness = dist_worst / denom if denom > 0 else 0.0
        entries.append(RankingEntry(id=candidate.id, score=closeness))

    entries.sort(key=lambda e: e.score, reverse=True)
    return Ranking(entries=entries)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/modm/test_topsis.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add core/modm/topsis.py tests/core/modm/test_topsis.py
git commit -m "feat: add TOPSIS ranking technique"
```

---

### Task 4: EPM manifest loader (`epm.yaml`)

**Files:**
- Create: `core/epm/loader.py`
- Test: `tests/core/epm/test_loader.py`

**Interfaces:**
- Consumes: `Objective` from `core.modm.models` (Task 2).
- Produces: `EpmManifest(version: int, objectives: list[Objective], technique: str)`, `EpmValidationError(ValueError)`, `load_epm_manifest(path: Path) -> EpmManifest`.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/epm/test_loader.py
import pytest

from core.epm.loader import EpmValidationError, load_epm_manifest


def test_loads_valid_manifest(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.6\n"
        "  - name: quality\n"
        "    direction: maximize\n"
        "    weight: 0.4\n"
        "technique: topsis\n"
    )

    manifest = load_epm_manifest(manifest_path)

    assert manifest.version == 1
    assert manifest.technique == "topsis"
    assert [o.name for o in manifest.objectives] == ["cost", "quality"]


def test_rejects_weights_not_summing_to_one(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.9\n"
        "technique: weighted_sum\n"
    )

    with pytest.raises(EpmValidationError, match="sum to"):
        load_epm_manifest(manifest_path)


def test_rejects_duplicate_objective_names(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.5\n"
        "  - name: cost\n"
        "    direction: maximize\n"
        "    weight: 0.5\n"
        "technique: weighted_sum\n"
    )

    with pytest.raises(EpmValidationError, match="duplicate"):
        load_epm_manifest(manifest_path)


def test_rejects_unknown_technique(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 1.0\n"
        "technique: pareto\n"
    )

    with pytest.raises(Exception):
        load_epm_manifest(manifest_path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/epm/test_loader.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.epm.loader'`

- [ ] **Step 3: Write `core/epm/loader.py`**

```python
from pathlib import Path

import yaml
from pydantic import BaseModel, field_validator

from core.modm.models import Objective


class EpmManifest(BaseModel):
    version: int
    objectives: list[Objective]
    technique: str  # "topsis" | "weighted_sum"

    @field_validator("technique")
    @classmethod
    def validate_technique(cls, v: str) -> str:
        if v not in ("topsis", "weighted_sum"):
            raise ValueError(f"technique must be 'topsis' or 'weighted_sum', got {v!r}")
        return v


class EpmValidationError(ValueError):
    pass


def load_epm_manifest(path: Path) -> EpmManifest:
    raw = yaml.safe_load(path.read_text())
    manifest = EpmManifest.model_validate(raw)

    names = [o.name for o in manifest.objectives]
    if len(names) != len(set(names)):
        raise EpmValidationError(f"duplicate objective names in {path}: {names}")

    total_weight = sum(o.weight for o in manifest.objectives)
    if abs(total_weight - 1.0) > 0.01:
        raise EpmValidationError(
            f"objective weights in {path} must sum to ~1.0, got {total_weight}"
        )

    return manifest
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/epm/test_loader.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add core/epm/loader.py tests/core/epm/test_loader.py
git commit -m "feat: add EPM manifest loader with validation"
```

---

### Task 5: Hard-constraint Rego policies

**Files:**
- Create: `policies/hard/base.rego`
- Create: `policies/hard/compliance.rego`
- Create: `policies/hard/security.rego`
- Create: `policies/hard/privacy.rego`
- Create: `policies/hard/cost.rego`
- Create: `policies/hard/approval.rego`
- Create: `policies/hard/base_test.rego`
- Create: `policies/hard/compliance_test.rego`
- Create: `policies/hard/security_test.rego`
- Create: `policies/hard/privacy_test.rego`
- Create: `policies/hard/cost_test.rego`
- Create: `policies/hard/approval_test.rego`

**Interfaces:**
- Produces: OPA document `data.made.hard` with fields `allow` (bool), `deny` (set of strings), `require_approval` (set of strings) — this is the contract Task 6 (`opa_client.py`) queries.

- [ ] **Step 1: Write `policies/hard/base.rego` (aggregation rule)**

```rego
package made.hard

default allow := true

allow := false if {
	count(deny) > 0
}
```

- [ ] **Step 2: Write `policies/hard/compliance.rego`**

```rego
package made.hard

# ponytail: single hardcoded vendor set, replace with a real vendor registry lookup if the list grows past a handful of entries
unverified_vendors := {"unverified-oss"}

deny contains reason if {
	input.task.data_classification in {"confidential", "restricted"}
	input.candidate.vendor in unverified_vendors
	reason := sprintf("compliance: vendor '%s' not approved for data_classification '%s'", [input.candidate.vendor, input.task.data_classification])
}
```

- [ ] **Step 3: Write `policies/hard/security.rego`**

```rego
package made.hard

high_risk_tools := {"shell_exec"}

deny contains reason if {
	input.candidate.kind == "tool"
	input.candidate.id in high_risk_tools
	input.task.data_classification != "public"
	reason := sprintf("security: tool '%s' only permitted for public data_classification", [input.candidate.id])
}
```

- [ ] **Step 4: Write `policies/hard/privacy.rego`**

```rego
package made.hard

non_eu_vendors := {"openai"}

deny contains reason if {
	input.task.data_classification == "restricted"
	input.org.region == "eu"
	input.candidate.vendor in non_eu_vendors
	reason := sprintf("privacy: vendor '%s' fails EU data residency for restricted data", [input.candidate.vendor])
}
```

- [ ] **Step 5: Write `policies/hard/cost.rego`**

```rego
package made.hard

# ponytail: cost_per_1k_tokens compared directly against budget_remaining_usd as a per-request cap, replace with real token-volume estimation if the budget model needs multi-request accounting
deny contains reason if {
	input.candidate.cost_per_1k_tokens > input.org.budget_remaining_usd
	reason := sprintf("cost: candidate '%s' cost_per_1k_tokens %v exceeds remaining budget %v", [input.candidate.id, input.candidate.cost_per_1k_tokens, input.org.budget_remaining_usd])
}
```

- [ ] **Step 6: Write `policies/hard/approval.rego`**

```rego
package made.hard

require_approval contains reason if {
	input.task.data_classification == "restricted"
	reason := "approval: restricted data_classification always requires human approval"
}

require_approval contains reason if {
	input.task.type == "contract_review"
	reason := "approval: contract_review tasks always require human approval"
}
```

- [ ] **Step 7: Write test files**

```rego
# policies/hard/base_test.rego
package made.hard

test_allow_true_when_no_denies if {
	allow with deny as set()
}

test_allow_false_when_denies_present if {
	not allow with deny as {"some reason"}
}
```

```rego
# policies/hard/compliance_test.rego
package made.hard

test_deny_unverified_vendor_for_confidential if {
	deny["compliance: vendor 'unverified-oss' not approved for data_classification 'confidential'"] with input as {
		"task": {"type": "summarization", "data_classification": "confidential"},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "unverified-oss", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_unverified_vendor_for_public if {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "unverified-oss", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

```rego
# policies/hard/security_test.rego
package made.hard

test_deny_shell_exec_for_internal_data if {
	deny["security: tool 'shell_exec' only permitted for public data_classification"] with input as {
		"task": {"type": "automation", "data_classification": "internal"},
		"candidate": {"kind": "tool", "id": "shell_exec", "vendor": "internal", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_shell_exec_for_public_data if {
	count(deny) == 0 with input as {
		"task": {"type": "automation", "data_classification": "public"},
		"candidate": {"kind": "tool", "id": "shell_exec", "vendor": "internal", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

```rego
# policies/hard/privacy_test.rego
package made.hard

test_deny_openai_for_eu_restricted if {
	deny["privacy: vendor 'openai' fails EU data residency for restricted data"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "eu"},
	}
}

test_allow_openai_for_us_restricted if {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

```rego
# policies/hard/cost_test.rego
package made.hard

test_deny_candidate_over_budget if {
	deny["cost: candidate 'gpt-4o' cost_per_1k_tokens 0.5 exceeds remaining budget 0.1"] with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.5},
		"org": {"budget_remaining_usd": 0.1, "region": "us"},
	}
}

test_allow_candidate_under_budget if {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

```rego
# policies/hard/approval_test.rego
package made.hard

test_require_approval_for_restricted_data if {
	require_approval["approval: restricted data_classification always requires human approval"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_no_approval_for_internal_summarization if {
	count(require_approval) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "internal"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

- [ ] **Step 8: Run OPA's native test suite**

Run: `opa test policies/hard -v`
Expected: all `test_*` rules PASS (12 tests: 2 base + 2 per domain file × 5 domain files).

- [ ] **Step 9: Commit**

```bash
git add policies/hard
git commit -m "feat: add EPM hard-constraint Rego policies with opa tests"
```

---

### Task 6: OPA client (`core/epm/opa_client.py`)

**Files:**
- Create: `core/epm/opa_client.py`
- Test: `tests/core/epm/test_opa_client.py`

**Interfaces:**
- Consumes: `policies/hard/` directory from Task 5 (tests reference it via a fixture path).
- Produces: `OpaEvaluationError(RuntimeError)`, `evaluate_hard_constraints(input_doc: dict, policies_dir: Path) -> dict` returning `{"allow": bool, "deny_reasons": list[str], "requires_human_approval": bool, "approval_reasons": list[str]}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/epm/test_opa_client.py
from pathlib import Path

import pytest

from core.epm.opa_client import OpaEvaluationError, evaluate_hard_constraints

POLICIES_HARD_DIR = Path(__file__).resolve().parents[3] / "policies" / "hard"


def test_allows_compliant_candidate():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "public"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
            "org": {"budget_remaining_usd": 10.0, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["allow"] is True
    assert result["deny_reasons"] == []
    assert result["requires_human_approval"] is False


def test_denies_and_reports_reason_for_over_budget_candidate():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "public"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 5.0},
            "org": {"budget_remaining_usd": 0.1, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["allow"] is False
    assert any("cost:" in reason for reason in result["deny_reasons"])


def test_flags_human_approval_for_restricted_data():
    result = evaluate_hard_constraints(
        {
            "task": {"type": "summarization", "data_classification": "restricted"},
            "candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
            "org": {"budget_remaining_usd": 10.0, "region": "us"},
        },
        POLICIES_HARD_DIR,
    )

    assert result["requires_human_approval"] is True
    assert len(result["approval_reasons"]) > 0


def test_raises_on_nonexistent_policies_dir(tmp_path):
    with pytest.raises(OpaEvaluationError):
        evaluate_hard_constraints(
            {"task": {}, "candidate": {}, "org": {}},
            tmp_path / "does_not_exist",
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/epm/test_opa_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.epm.opa_client'`

- [ ] **Step 3: Write `core/epm/opa_client.py`**

```python
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class OpaEvaluationError(RuntimeError):
    pass


def evaluate_hard_constraints(input_doc: dict[str, Any], policies_dir: Path) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(input_doc, f)
        input_path = f.name

    try:
        proc = subprocess.run(
            [
                "opa", "eval",
                "--format", "json",
                "--input", input_path,
                "--data", str(policies_dir),
                "data.made.hard",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError as exc:
        raise OpaEvaluationError("opa binary not found on PATH") from exc
    finally:
        Path(input_path).unlink(missing_ok=True)

    if proc.returncode != 0:
        raise OpaEvaluationError(f"opa eval failed: {proc.stderr.strip()}")

    try:
        parsed = json.loads(proc.stdout)
        value = parsed["result"][0]["expressions"][0]["value"]
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        raise OpaEvaluationError(f"unexpected opa output: {proc.stdout}") from exc

    return {
        "allow": value.get("allow", True),
        "deny_reasons": sorted(value.get("deny", [])),
        "requires_human_approval": len(value.get("require_approval", [])) > 0,
        "approval_reasons": sorted(value.get("require_approval", [])),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/epm/test_opa_client.py -v`
Expected: 4 passed (requires `opa` on PATH and `policies/hard/` from Task 5)

- [ ] **Step 5: Commit**

```bash
git add core/epm/opa_client.py tests/core/epm/test_opa_client.py
git commit -m "feat: add OPA subprocess client for hard-constraint evaluation"
```

---

### Task 7: Decision engine

**Files:**
- Create: `core/decision/engine.py`
- Test: `tests/core/decision/test_engine.py`

**Interfaces:**
- Consumes: `Candidate`, `Objective` from `core.modm.models`; `weighted_sum`, `topsis` from `core.modm.weighted_sum`/`core.modm.topsis`; `load_epm_manifest` from `core.epm.loader`; `evaluate_hard_constraints`, `OpaEvaluationError` from `core.epm.opa_client`.
- Produces: `Task(type: str, data_classification: str)`, `Org(budget_remaining_usd: float, region: str)`, `DecisionCandidate(id: str, vendor: str, kind: str, cost_per_1k_tokens: float, scores: dict[str, float])`, `ExcludedCandidate(id: str, reason: str)`, `DecisionResult(selected_candidate_id: str | None, requires_human_approval: bool, ranking: list[dict], excluded: list[ExcludedCandidate], technique_used: str)`, `decide(task: Task, org: Org, candidates: list[DecisionCandidate], policies_dir: Path) -> DecisionResult`. `policies_dir` must contain `epm.yaml` and a `hard/` subdirectory (Task 4/5/6 contracts).

- [ ] **Step 1: Write the failing test**

```python
# tests/core/decision/test_engine.py
from pathlib import Path

from core.decision.engine import DecisionCandidate, Org, Task, decide

POLICIES_DIR = Path(__file__).resolve().parents[3] / "policies"


def test_selects_best_candidate_among_compliant_options():
    result = decide(
        task=Task(type="summarization", data_classification="internal"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="gpt-4o", vendor="openai", kind="model", cost_per_1k_tokens=0.02,
                scores={"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            ),
            DecisionCandidate(
                id="gpt-3.5", vendor="openai", kind="model", cost_per_1k_tokens=0.005,
                scores={"cost": 0.005, "quality": 0.6, "latency": 0.8, "business_risk": 0.2},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id in {"gpt-4o", "gpt-3.5"}
    assert len(result.ranking) == 2
    assert result.excluded == []
    assert result.technique_used == "topsis"


def test_excludes_candidate_denied_by_hard_constraint():
    result = decide(
        task=Task(type="summarization", data_classification="confidential"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="local-llama", vendor="unverified-oss", kind="model", cost_per_1k_tokens=0.0,
                scores={"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.selected_candidate_id is None
    assert result.ranking == []
    assert len(result.excluded) == 1
    assert result.excluded[0].id == "local-llama"
    assert "compliance:" in result.excluded[0].reason


def test_flags_human_approval_without_blocking_selection():
    result = decide(
        task=Task(type="contract_review", data_classification="internal"),
        org=Org(budget_remaining_usd=10.0, region="us"),
        candidates=[
            DecisionCandidate(
                id="gpt-4o", vendor="openai", kind="model", cost_per_1k_tokens=0.02,
                scores={"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            ),
        ],
        policies_dir=POLICIES_DIR,
    )

    assert result.requires_human_approval is True
    assert result.selected_candidate_id == "gpt-4o"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/decision/test_engine.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.decision.engine'`

- [ ] **Step 3: Write `core/decision/engine.py`**

```python
from pathlib import Path

from pydantic import BaseModel

from core.epm.loader import load_epm_manifest
from core.epm.opa_client import evaluate_hard_constraints
from core.modm.models import Candidate
from core.modm.topsis import topsis
from core.modm.weighted_sum import weighted_sum


class Task(BaseModel):
    type: str
    data_classification: str


class Org(BaseModel):
    budget_remaining_usd: float
    region: str


class DecisionCandidate(BaseModel):
    id: str
    vendor: str
    kind: str  # "model" | "tool"
    cost_per_1k_tokens: float
    scores: dict[str, float]


class ExcludedCandidate(BaseModel):
    id: str
    reason: str


class DecisionResult(BaseModel):
    selected_candidate_id: str | None
    requires_human_approval: bool
    ranking: list[dict]
    excluded: list[ExcludedCandidate]
    technique_used: str


_TECHNIQUES = {"weighted_sum": weighted_sum, "topsis": topsis}


def decide(
    task: Task,
    org: Org,
    candidates: list[DecisionCandidate],
    policies_dir: Path,
) -> DecisionResult:
    manifest = load_epm_manifest(policies_dir / "epm.yaml")
    hard_dir = policies_dir / "hard"

    passing: list[DecisionCandidate] = []
    excluded: list[ExcludedCandidate] = []
    requires_human_approval = False

    for candidate in candidates:
        input_doc = {
            "task": task.model_dump(),
            "candidate": {
                "kind": candidate.kind,
                "id": candidate.id,
                "vendor": candidate.vendor,
                "cost_per_1k_tokens": candidate.cost_per_1k_tokens,
            },
            "org": org.model_dump(),
        }
        result = evaluate_hard_constraints(input_doc, hard_dir)

        if result["requires_human_approval"]:
            requires_human_approval = True

        if result["allow"]:
            passing.append(candidate)
        else:
            excluded.append(ExcludedCandidate(
                id=candidate.id,
                reason="; ".join(result["deny_reasons"]) or "denied by policy",
            ))

    if not passing:
        return DecisionResult(
            selected_candidate_id=None,
            requires_human_approval=requires_human_approval,
            ranking=[],
            excluded=excluded,
            technique_used=manifest.technique,
        )

    modm_candidates = [Candidate(id=c.id, scores=c.scores) for c in passing]
    ranking = _TECHNIQUES[manifest.technique](modm_candidates, manifest.objectives)

    return DecisionResult(
        selected_candidate_id=ranking.best.id if ranking.best else None,
        requires_human_approval=requires_human_approval,
        ranking=[{"id": e.id, "score": e.score} for e in ranking.entries],
        excluded=excluded,
        technique_used=manifest.technique,
    )
```

- [ ] **Step 4: Create `policies/epm.yaml` (needed for this test to run)**

```yaml
version: 1
objectives:
  - name: cost
    direction: minimize
    weight: 0.3
  - name: quality
    direction: maximize
    weight: 0.4
  - name: latency
    direction: minimize
    weight: 0.2
  - name: business_risk
    direction: minimize
    weight: 0.1
technique: topsis
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/core/decision/test_engine.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add core/decision/engine.py tests/core/decision/test_engine.py policies/epm.yaml
git commit -m "feat: add decision engine combining EPM filtering and MODM ranking"
```

---

### Task 8: Storage layer

**Files:**
- Create: `storage/models.py`
- Create: `storage/db.py`
- Test: `tests/storage/test_db.py`

**Interfaces:**
- Produces: `DecisionRecord` (SQLModel table `decisions` with columns `id, created_at, decision_kind, request_json, response_json, policy_version`), `make_engine(db_path: Path) -> Engine`, `get_session(engine) -> Session`.

- [ ] **Step 1: Write the failing test**

```python
# tests/storage/test_db.py
from storage.db import get_session, make_engine
from storage.models import DecisionRecord


def test_decision_record_roundtrip(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        record = DecisionRecord(
            decision_kind="model_selection",
            request_json="{}",
            response_json="{}",
            policy_version="test-sha",
        )
        session.add(record)
        session.commit()
        session.refresh(record)
        record_id = record.id

    assert record_id is not None

    with get_session(engine) as session:
        fetched = session.get(DecisionRecord, record_id)
        assert fetched.decision_kind == "model_selection"
        assert fetched.policy_version == "test-sha"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/storage/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'storage.db'`

- [ ] **Step 3: Write `storage/models.py`**

```python
import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


class DecisionRecord(SQLModel, table=True):
    __tablename__ = "decisions"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    decision_kind: str
    request_json: str
    response_json: str
    policy_version: str
```

- [ ] **Step 4: Write `storage/db.py`**

```python
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine


def make_engine(db_path: Path):
    engine = create_engine(f"sqlite:///{db_path}")
    SQLModel.metadata.create_all(engine)
    return engine


def get_session(engine) -> Session:
    return Session(engine)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/storage/test_db.py -v`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add storage/models.py storage/db.py tests/storage/test_db.py
git commit -m "feat: add SQLite-backed decision log storage"
```

---

### Task 9: API — `POST /decide`

**Files:**
- Create: `api/schemas.py`
- Create: `api/main.py`
- Test: `tests/api/test_decide.py`

**Interfaces:**
- Consumes: `Task`, `Org`, `DecisionCandidate`, `decide` from `core.decision.engine`; `OpaEvaluationError` from `core.epm.opa_client`; `load_epm_manifest` from `core.epm.loader`; `make_engine`, `get_session` from `storage.db`; `DecisionRecord` from `storage.models`.
- Produces: FastAPI app at `api.main.app`; `api.main.get_engine()` (lazily creates/reuses the SQLite engine, path overridable via `MADE_DB_PATH` env var — this is how tests isolate the DB); `POST /decide` endpoint.

- [ ] **Step 1: Write `api/schemas.py`**

```python
from pydantic import BaseModel


class TaskIn(BaseModel):
    type: str
    data_classification: str


class OrgIn(BaseModel):
    budget_remaining_usd: float = 1000.0
    region: str = "us"


class CandidateIn(BaseModel):
    id: str
    vendor: str
    kind: str
    cost_per_1k_tokens: float
    scores: dict[str, float]


class DecideRequest(BaseModel):
    task: TaskIn
    org: OrgIn = OrgIn()
    decision_kind: str
    candidates: list[CandidateIn]
    policy_set: str = "default"


class RankingEntryOut(BaseModel):
    id: str
    score: float


class ExcludedOut(BaseModel):
    id: str
    reason: str


class DecideResponse(BaseModel):
    decision_id: str
    selected_candidate_id: str | None
    requires_human_approval: bool
    ranking: list[RankingEntryOut]
    excluded: list[ExcludedOut]
    technique_used: str
    policy_version: str
```

- [ ] **Step 2: Write the failing test**

```python
# tests/api/test_decide.py
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module
    main_module._engine = None
    return TestClient(main_module.app)


def test_decide_selects_a_candidate(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "summarization", "data_classification": "public"},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "gpt-4o", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.02,
                "scores": {"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1},
            },
            {
                "id": "gpt-3.5", "vendor": "openai", "kind": "model", "cost_per_1k_tokens": 0.005,
                "scores": {"cost": 0.005, "quality": 0.6, "latency": 0.8, "business_risk": 0.2},
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] in {"gpt-4o", "gpt-3.5"}
    assert body["technique_used"] == "topsis"
    assert body["excluded"] == []


def test_decide_reports_exclusions_and_still_returns_200(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "summarization", "data_classification": "confidential"},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
                "scores": {"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4},
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] is None
    assert len(body["excluded"]) == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/api/test_decide.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.main'`

- [ ] **Step 4: Write `api/main.py`**

```python
import os
import subprocess
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException

from api.schemas import DecideRequest, DecideResponse, ExcludedOut, RankingEntryOut
from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.epm.loader import load_epm_manifest
from core.epm.opa_client import OpaEvaluationError
from storage.db import get_session, make_engine
from storage.models import DecisionRecord

POLICIES_ROOT = Path(__file__).resolve().parent.parent / "policies"

app = FastAPI(title="MADE")

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        db_path = Path(os.environ.get("MADE_DB_PATH", str(Path(__file__).resolve().parent.parent / "made.db")))
        _engine = make_engine(db_path)
    return _engine


def _policy_version(policies_dir: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=policies_dir, capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            return f"epm.yaml@{result.stdout.strip()}"
    except FileNotFoundError:
        pass
    return "epm.yaml@unversioned"


@app.on_event("startup")
def validate_policies_on_startup() -> None:
    load_epm_manifest(POLICIES_ROOT / "epm.yaml")


@app.post("/decide", response_model=DecideResponse)
def post_decide(request: DecideRequest) -> DecideResponse:
    task = Task(type=request.task.type, data_classification=request.task.data_classification)
    org = Org(budget_remaining_usd=request.org.budget_remaining_usd, region=request.org.region)
    candidates = [
        DecisionCandidate(
            id=c.id, vendor=c.vendor, kind=c.kind,
            cost_per_1k_tokens=c.cost_per_1k_tokens, scores=c.scores,
        )
        for c in request.candidates
    ]

    try:
        result = decide(task=task, org=org, candidates=candidates, policies_dir=POLICIES_ROOT)
    except OpaEvaluationError as exc:
        raise HTTPException(status_code=503, detail=f"policy engine unavailable: {exc}") from exc

    decision_id = str(uuid.uuid4())
    policy_version = _policy_version(POLICIES_ROOT)

    response = DecideResponse(
        decision_id=decision_id,
        selected_candidate_id=result.selected_candidate_id,
        requires_human_approval=result.requires_human_approval,
        ranking=[RankingEntryOut(**r) for r in result.ranking],
        excluded=[ExcludedOut(id=e.id, reason=e.reason) for e in result.excluded],
        technique_used=result.technique_used,
        policy_version=policy_version,
    )

    with get_session(get_engine()) as session:
        session.add(DecisionRecord(
            id=decision_id,
            decision_kind=request.decision_kind,
            request_json=request.model_dump_json(),
            response_json=response.model_dump_json(),
            policy_version=policy_version,
        ))
        session.commit()

    return response
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/api/test_decide.py -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add api/schemas.py api/main.py tests/api/test_decide.py
git commit -m "feat: add POST /decide API endpoint with decision logging"
```

---

### Task 10: API — `GET /policies/{policy_set}`

**Files:**
- Modify: `api/main.py`
- Test: `tests/api/test_policies_endpoint.py`

**Interfaces:**
- Consumes: `POLICIES_ROOT`, `_policy_version` from `api/main.py` (Task 9).
- Produces: `GET /policies/{policy_set}` returning objectives, technique, hard-constraint filenames, and policy version; 404 for unknown `policy_set`.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_policies_endpoint.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_policies_endpoint.py -v`
Expected: FAIL with 404 for `/policies/default` (route doesn't exist yet, so both tests currently return 404 — the first assertion `response.status_code == 200` fails)

- [ ] **Step 3: Add the endpoint to `api/main.py`**

Add this function at the end of `api/main.py`, after `post_decide`:

```python
@app.get("/policies/{policy_set}")
def get_policy(policy_set: str) -> dict:
    if policy_set != "default":
        raise HTTPException(status_code=404, detail=f"unknown policy_set '{policy_set}'")

    manifest = load_epm_manifest(POLICIES_ROOT / "epm.yaml")
    hard_files = sorted(
        p.name for p in (POLICIES_ROOT / "hard").glob("*.rego")
        if not p.name.endswith("_test.rego")
    )

    return {
        "policy_set": policy_set,
        "objectives": [o.model_dump() for o in manifest.objectives],
        "technique": manifest.technique,
        "hard_constraint_files": hard_files,
        "policy_version": _policy_version(POLICIES_ROOT),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/api/test_policies_endpoint.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add api/main.py tests/api/test_policies_endpoint.py
git commit -m "feat: add GET /policies/{policy_set} introspection endpoint"
```

---

### Task 11: Tool-selection config and manual smoke test

**Files:**
- Create: `config/candidates.yaml`
- Create: `scripts/manual_smoke_test.py`

**Interfaces:**
- Consumes: running MADE API (`POST /decide`) from Task 9/10.
- Produces: a runnable script that exercises `model_selection`, `tool_selection`, and the `human_approval` gate end-to-end against a live server — this is the manual verification for T14/T16 in `docs/TASKS_MADE.md`.

- [ ] **Step 1: Write `config/candidates.yaml`**

```yaml
models:
  - id: gpt-4o
    vendor: openai
    kind: model
    cost_per_1k_tokens: 0.02
    scores: {cost: 0.02, quality: 0.95, latency: 1.5, business_risk: 0.1}
  - id: claude-haiku
    vendor: anthropic
    kind: model
    cost_per_1k_tokens: 0.003
    scores: {cost: 0.003, quality: 0.75, latency: 0.6, business_risk: 0.15}
  - id: local-llama
    vendor: unverified-oss
    kind: model
    cost_per_1k_tokens: 0.0
    scores: {cost: 0.0, quality: 0.5, latency: 2.0, business_risk: 0.4}
tools:
  - id: web_search
    vendor: internal
    kind: tool
    cost_per_1k_tokens: 0.001
    scores: {cost: 0.001, quality: 0.8, latency: 0.5, business_risk: 0.1}
  - id: shell_exec
    vendor: internal
    kind: tool
    cost_per_1k_tokens: 0.0
    scores: {cost: 0.0, quality: 0.9, latency: 0.2, business_risk: 0.5}
```

- [ ] **Step 2: Write `scripts/manual_smoke_test.py`**

```python
"""Manual smoke test: exercises POST /decide for model selection, tool
selection, and human-approval gating against a running MADE server.

Prerequisites:
  - OPA installed and on PATH
  - MADE server running: uvicorn api.main:app --reload

Run:
  python scripts/manual_smoke_test.py
"""
import sys
from pathlib import Path

import httpx
import yaml

BASE_URL = "http://127.0.0.1:8000"


def load_candidates() -> dict:
    path = Path(__file__).resolve().parent.parent / "config" / "candidates.yaml"
    return yaml.safe_load(path.read_text())


def run_case(name: str, payload: dict) -> None:
    response = httpx.post(f"{BASE_URL}/decide", json=payload, timeout=10)
    response.raise_for_status()
    body = response.json()
    print(f"\n=== {name} ===")
    print(f"selected: {body['selected_candidate_id']}")
    print(f"requires_human_approval: {body['requires_human_approval']}")
    print(f"excluded: {body['excluded']}")


def main() -> int:
    candidates = load_candidates()

    run_case("model_selection (internal data)", {
        "task": {"type": "summarization", "data_classification": "internal"},
        "decision_kind": "model_selection",
        "candidates": candidates["models"],
    })

    run_case("tool_selection (public data)", {
        "task": {"type": "automation", "data_classification": "public"},
        "decision_kind": "tool_selection",
        "candidates": candidates["tools"],
    })

    run_case("human_approval gate (restricted contract_review)", {
        "task": {"type": "contract_review", "data_classification": "restricted"},
        "decision_kind": "model_selection",
        "candidates": candidates["models"],
    })

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Run the full test suite one more time**

Run: `pytest -v`
Expected: all tests from Tasks 2-10 pass (should be ~20 tests total).

- [ ] **Step 4: Start the server and run the smoke test manually**

```bash
uvicorn api.main:app --reload &
sleep 2
python scripts/manual_smoke_test.py
kill %1
```

Expected: three `===` sections print, each with a `selected` id (or `null` for the model case if all models happen to be excluded), and the third case ("contract_review") prints `requires_human_approval: True`.

- [ ] **Step 5: Commit**

```bash
git add config/candidates.yaml scripts/manual_smoke_test.py
git commit -m "feat: add tool-selection config and manual smoke test script"
```

---

## Definition of Done

- `pytest -v` passes with no failures (Tasks 2-10 tests, ~20 tests).
- `opa test policies/hard -v` passes (Task 5, 12 tests).
- `scripts/manual_smoke_test.py` runs successfully against a live `uvicorn api.main:app` and demonstrates all three decision kinds (model_selection, tool_selection, human_approval flagging).
- This completes T1-T16 in `docs/TASKS_MADE.md` (Fase 3 through Fase 8). T17 onward (dataset eksperimen, baselines, harness, analysis) is a separate follow-up plan.
