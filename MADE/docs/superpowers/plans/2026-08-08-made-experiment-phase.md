# MADE Experiment Phase (T17-T23, Real DeepSeek Scoring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the experiment harness that compares MADE against 4 baselines (AHP-SAW, always-strong, always-cheap, no-policy) across 100+ scenarios, using real DeepSeek v4-flash/v4-pro API calls for cost+latency and an LLM-judge (v4-pro) for quality, producing CSV results and a statistical comparison — corresponding to T17-T23 in `docs/TASKS_MADE.md`.

**Architecture:** `core/experiment/` is a plain Python package (no HTTP dependency) with a DeepSeek client, an LLM-judge, a SQLite-backed score cache, 5 baseline selection strategies, and a harness that orchestrates them. DeepSeek is called **once per (scenario, real candidate)** — never once per baseline — and the result is cached and reused by all 5 strategies, so the comparison is fair and the API cost is bounded. Every strategy's selected candidate is re-checked against OPA post-hoc (ground-truth `policy_violation`), regardless of whether that strategy itself consults policy.

**Tech Stack:** Same as MADE v1 (Python 3.11+, FastAPI, Pydantic v2, SQLModel, PyYAML, OPA, pytest, httpx) plus `python-dotenv` (load `.env`) and `scipy` (paired significance tests, `wilcoxon`).

## Global Constraints

- `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` are read from environment variables (populated via `.env`, already gitignored) — never hardcoded, never logged, never included in test output or committed fixtures.
- The `pytest` suite must **never** make real DeepSeek API calls — every test touching `core/experiment/deepseek_client.py` or `core/experiment/judge.py` mocks the HTTP/completion layer. Real API calls only happen via `scripts/run_experiment.py`, run manually and deliberately.
- DeepSeek is called at most **once per (scenario_id, candidate_id)** — results are cached in the `score_cache` table and reused by all 5 baselines and by `made`. A cache hit must never trigger a new API call.
- `evaluate_hard_constraints` (existing, fail-closed) is used to compute `policy_violation` for **every** baseline's selected candidate, not only `made`'s.
- DeepSeek transient failures (timeout/rate limit) retry up to 3 attempts total inside `deepseek_client.complete`, then raise `DeepSeekError`; a scenario whose real-candidate call ultimately fails is marked `status: "failed"` and the harness continues to the next scenario — one failure must never abort a 100+-scenario run.
- The judge model is fixed as `deepseek-v4-pro` for every quality score, regardless of which candidate produced the response (never self-judging with a per-candidate-matched model).
- `experiments/ahp_weights.yaml` stays a separate file from `policies/epm.yaml` (the AHP-SAW baseline must not "borrow" MADE's own MODM weights).
- Every source file gets a corresponding test file; no task is complete without its tests passing.
- Commit after every task.

---

## File Structure Overview

```
core/experiment/
  __init__.py
  deepseek_client.py       # complete(model, prompt) -> CompletionResult, real cost+latency, retry-then-raise
  judge.py                  # judge_quality(prompt, response_text) -> float 0-1, deepseek-v4-pro rubric
  score_cache.py             # get_cached_score / put_score against SQLite
  config_loader.py            # load_candidates_config, load_ahp_weights
  baselines.py                 # select_ahp_saw, select_always_strong, select_always_cheap, select_no_policy
  harness.py                    # load_scenarios, build_candidate_infos, is_policy_violation,
                                 # run_scenario_for_baseline, run_experiment
  metrics.py                     # compute_baseline_summary, export_results_csv
experiments/
  __init__.py
  generate_scenarios.py          # generate_scenarios(count, seed) -> list[dict], CLI entrypoint
  ahp_weights.yaml
  scenarios/
    v1.jsonl                      # generated, 120 scenarios
  analyze_results.py               # T22: load_results, summarize, CLI table
  statistical_tests.py              # T23: paired_values, compare_baseline (wilcoxon), CLI
  results/                            # gitignored, CSV output lands here
storage/
  models.py                          # + ScoreCacheRecord, ExperimentRun, ExperimentResult
config/
  candidates.yaml                     # + deepseek-v4-flash, deepseek-v4-pro entries
api/
  schemas.py                          # + ExperimentRunRequest/Response, BaselineSummaryOut
  main.py                              # + POST /experiment/run
scripts/
  run_experiment.py                    # CLI: real API run end-to-end, exports CSV
.env, .env.example, pyproject.toml     # modified: DEEPSEEK_* already present; add python-dotenv, scipy
tests/
  core/experiment/
    test_deepseek_client.py
    test_judge.py
    test_score_cache.py
    test_config_loader.py
    test_baselines.py
    test_harness.py
    test_harness_orchestration.py
    test_metrics.py
  experiments/
    __init__.py
    test_generate_scenarios.py
    test_analyze_results.py
    test_statistical_tests.py
  api/
    test_experiment_endpoint.py
```

---

### Task 1: Storage extensions (`score_cache`, `experiment_runs`, `experiment_results`)

**Files:**
- Modify: `storage/models.py`
- Test: `tests/storage/test_experiment_models.py`

**Interfaces:**
- Produces: `ScoreCacheRecord(scenario_id: str, candidate_id: str, cost_usd: float, quality: float, latency_ms: float, business_risk: float, raw_response: str, judge_raw: str, created_at: datetime)` with composite primary key `(scenario_id, candidate_id)`; `ExperimentRun(id: str, created_at: datetime, baseline: str, scenario_dataset_version: str)`; `ExperimentResult(id: str, run_id: str, scenario_id: str, selected_candidate_id: str | None, policy_violation: bool, cost_usd: float, quality_score: float, latency_ms: float, status: str)`. All three become tables via the existing `make_engine`'s `SQLModel.metadata.create_all` — no change needed to `storage/db.py`.

- [ ] **Step 1: Write the failing test**

```python
# tests/storage/test_experiment_models.py
from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun, ScoreCacheRecord


def test_score_cache_record_roundtrip_with_composite_key(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        session.add(ScoreCacheRecord(
            scenario_id="s-001", candidate_id="deepseek-v4-flash",
            cost_usd=0.002, quality=0.8, latency_ms=450.0, business_risk=0.25,
            raw_response="hello world", judge_raw="8",
        ))
        session.commit()

    with get_session(engine) as session:
        fetched = session.get(ScoreCacheRecord, ("s-001", "deepseek-v4-flash"))
        assert fetched.cost_usd == 0.002
        assert fetched.quality == 0.8


def test_experiment_run_and_result_roundtrip(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run = ExperimentRun(baseline="made", scenario_dataset_version="v1")
        session.add(run)
        session.commit()
        session.refresh(run)
        run_id = run.id

        session.add(ExperimentResult(
            run_id=run_id, scenario_id="s-001", selected_candidate_id="deepseek-v4-flash",
            policy_violation=False, cost_usd=0.002, quality_score=0.8, latency_ms=450.0, status="ok",
        ))
        session.commit()

    with get_session(engine) as session:
        fetched_run = session.get(ExperimentRun, run_id)
        assert fetched_run.baseline == "made"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source .venv/bin/activate && pytest tests/storage/test_experiment_models.py -v`
Expected: FAIL with `ImportError: cannot import name 'ScoreCacheRecord' from 'storage.models'`

- [ ] **Step 3: Add the three tables to `storage/models.py`**

Append to the existing file (keep `DecisionRecord` unchanged):

```python
class ScoreCacheRecord(SQLModel, table=True):
    __tablename__ = "score_cache"

    scenario_id: str = Field(primary_key=True)
    candidate_id: str = Field(primary_key=True)
    cost_usd: float
    quality: float
    latency_ms: float
    business_risk: float
    raw_response: str
    judge_raw: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ExperimentRun(SQLModel, table=True):
    __tablename__ = "experiment_runs"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    baseline: str
    scenario_dataset_version: str


class ExperimentResult(SQLModel, table=True):
    __tablename__ = "experiment_results"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    run_id: str = Field(foreign_key="experiment_runs.id")
    scenario_id: str
    selected_candidate_id: str | None = None
    policy_violation: bool
    cost_usd: float
    quality_score: float
    latency_ms: float
    status: str
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/storage/test_experiment_models.py -v`
Expected: 2 passed

- [ ] **Step 5: Run the full existing suite to confirm no regressions**

Run: `pytest -v`
Expected: all previously-passing tests (27) still pass, plus the 2 new ones (29 total)

- [ ] **Step 6: Commit**

```bash
git add storage/models.py tests/storage/test_experiment_models.py
git commit -m "feat: add score_cache, experiment_runs, experiment_results tables"
```

---

### Task 2: Candidate config data (`config/candidates.yaml`, `experiments/ahp_weights.yaml`)

**Files:**
- Modify: `config/candidates.yaml`
- Create: `experiments/__init__.py`
- Create: `experiments/ahp_weights.yaml`

**Interfaces:**
- Produces: two `models` entries with `source: real` (no `cost_per_1k_tokens`/`scores` — filled at runtime by the harness) that later tasks' `config_loader.load_candidates_config` indexes by `id`; `experiments/ahp_weights.yaml` with a `weights` dict later read by `config_loader.load_ahp_weights`.

- [ ] **Step 1: Modify `config/candidates.yaml`** — add two entries to the `models` list, keep everything else unchanged:

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
  - id: deepseek-v4-flash
    vendor: deepseek
    kind: model
    source: real
    business_risk: 0.25
  - id: deepseek-v4-pro
    vendor: deepseek
    kind: model
    source: real
    business_risk: 0.15
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

- [ ] **Step 2: Create `experiments/__init__.py`** (empty file — this makes `experiments/` an importable package for later tasks' generator/analysis modules and their tests)

- [ ] **Step 3: Create `experiments/ahp_weights.yaml`**

```yaml
version: 1
weights:
  cost: 0.25
  quality: 0.5
  latency: 0.15
  business_risk: 0.1
```

- [ ] **Step 4: Verify the YAML parses correctly**

Run: `source .venv/bin/activate && python -c "import yaml; print(yaml.safe_load(open('config/candidates.yaml'))['models'][-1])"`
Expected: prints `{'id': 'deepseek-v4-pro', 'vendor': 'deepseek', 'kind': 'model', 'source': 'real', 'business_risk': 0.15}`

- [ ] **Step 5: Commit**

```bash
git add config/candidates.yaml experiments/__init__.py experiments/ahp_weights.yaml
git commit -m "feat: add DeepSeek candidates and AHP-SAW baseline weights"
```

---

### Task 3: Config loader (`core/experiment/config_loader.py`)

**Files:**
- Create: `core/experiment/__init__.py`
- Create: `core/experiment/config_loader.py`
- Create: `tests/core/experiment/__init__.py`
- Test: `tests/core/experiment/test_config_loader.py`

**Interfaces:**
- Produces: `load_candidates_config(path: Path) -> dict` returning `{"models_by_id": dict[str, dict], "raw": dict}`; `load_ahp_weights(path: Path) -> dict[str, float]`, raising `ValueError` if weights don't sum to ~1.0 (±0.01).

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_config_loader.py
import pytest

from core.experiment.config_loader import load_ahp_weights, load_candidates_config


def test_load_candidates_config_indexes_models_by_id(tmp_path):
    config_path = tmp_path / "candidates.yaml"
    config_path.write_text(
        "models:\n"
        "  - id: deepseek-v4-flash\n"
        "    vendor: deepseek\n"
        "    kind: model\n"
        "    source: real\n"
        "    business_risk: 0.25\n"
        "tools: []\n"
    )

    config = load_candidates_config(config_path)

    assert "deepseek-v4-flash" in config["models_by_id"]
    assert config["models_by_id"]["deepseek-v4-flash"]["business_risk"] == 0.25


def test_load_ahp_weights_returns_dict(tmp_path):
    weights_path = tmp_path / "ahp_weights.yaml"
    weights_path.write_text(
        "version: 1\n"
        "weights:\n"
        "  cost: 0.25\n"
        "  quality: 0.5\n"
        "  latency: 0.15\n"
        "  business_risk: 0.1\n"
    )

    weights = load_ahp_weights(weights_path)

    assert weights == {"cost": 0.25, "quality": 0.5, "latency": 0.15, "business_risk": 0.1}


def test_load_ahp_weights_rejects_bad_sum(tmp_path):
    weights_path = tmp_path / "ahp_weights.yaml"
    weights_path.write_text(
        "version: 1\nweights:\n  cost: 0.9\n  quality: 0.0\n  latency: 0.0\n  business_risk: 0.0\n"
    )

    with pytest.raises(ValueError, match="sum to"):
        load_ahp_weights(weights_path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_config_loader.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment'`

- [ ] **Step 3: Create `core/experiment/__init__.py`** (empty) and `tests/core/experiment/__init__.py` (empty)

- [ ] **Step 4: Write `core/experiment/config_loader.py`**

```python
from pathlib import Path

import yaml


def load_candidates_config(path: Path) -> dict:
    raw = yaml.safe_load(path.read_text())
    models_by_id = {m["id"]: m for m in raw.get("models", [])}
    return {"models_by_id": models_by_id, "raw": raw}


def load_ahp_weights(path: Path) -> dict[str, float]:
    raw = yaml.safe_load(path.read_text())
    weights = raw["weights"]
    total = sum(weights.values())
    if abs(total - 1.0) > 0.01:
        raise ValueError(f"ahp weights in {path} must sum to ~1.0, got {total}")
    return weights
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_config_loader.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add core/experiment/__init__.py core/experiment/config_loader.py tests/core/experiment/__init__.py tests/core/experiment/test_config_loader.py
git commit -m "feat: add candidate config and AHP weights loader"
```

---

### Task 4: DeepSeek client (`core/experiment/deepseek_client.py`)

**Files:**
- Create: `core/experiment/deepseek_client.py`
- Modify: `pyproject.toml`
- Test: `tests/core/experiment/test_deepseek_client.py`

**Interfaces:**
- Produces: `DeepSeekError(RuntimeError)`; `CompletionResult(text: str, cost_usd: float, latency_ms: float)` (dataclass); `complete(model: str, prompt: str) -> CompletionResult`, reading `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` from `os.environ`, retrying transient HTTP failures up to 3 attempts, raising `DeepSeekError` for unknown model pricing, missing API key, or exhausted retries.

- [ ] **Step 1: Add `python-dotenv` to `pyproject.toml` dependencies**

In the `dependencies` list (after `"httpx>=0.27",`), add:
```toml
    "python-dotenv>=1.0",
```

- [ ] **Step 2: Install the new dependency**

Run: `source .venv/bin/activate && pip install -e ".[dev]"`
Expected: `python-dotenv` installs successfully

- [ ] **Step 3: Write the failing test**

```python
# tests/core/experiment/test_deepseek_client.py
import httpx
import pytest

from core.experiment.deepseek_client import DeepSeekError, complete


class _MockResponse:
    def __init__(self, status_code, json_body, text=""):
        self.status_code = status_code
        self._json_body = json_body
        self.text = text or str(json_body)

    def json(self):
        return self._json_body


def test_complete_returns_cost_and_latency_on_success(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_post(url, headers, json, timeout):
        return _MockResponse(200, {
            "choices": [{"message": {"content": "hello world"}}],
            "usage": {"total_tokens": 1000},
        })

    monkeypatch.setattr(httpx, "post", fake_post)

    result = complete("deepseek-v4-flash", "say hi")

    assert result.text == "hello world"
    assert result.cost_usd == pytest.approx(0.001)
    assert result.latency_ms >= 0


def test_complete_raises_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    with pytest.raises(DeepSeekError, match="DEEPSEEK_API_KEY"):
        complete("deepseek-v4-flash", "say hi")


def test_complete_retries_then_raises_on_persistent_failure(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    call_count = {"n": 0}

    def fake_post(url, headers, json, timeout):
        call_count["n"] += 1
        return _MockResponse(500, {}, text="server error")

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr("core.experiment.deepseek_client.time.sleep", lambda seconds: None)

    with pytest.raises(DeepSeekError, match="failed after 3 attempts"):
        complete("deepseek-v4-flash", "say hi")

    assert call_count["n"] == 3


def test_complete_raises_for_unknown_model_pricing(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    with pytest.raises(DeepSeekError, match="unknown pricing"):
        complete("gpt-4o", "say hi")
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_deepseek_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.deepseek_client'`

- [ ] **Step 5: Write `core/experiment/deepseek_client.py`**

```python
import os
import time
from dataclasses import dataclass

import httpx


class DeepSeekError(RuntimeError):
    pass


@dataclass
class CompletionResult:
    text: str
    cost_usd: float
    latency_ms: float


_PRICING_USD_PER_1K_TOKENS = {
    "deepseek-v4-flash": 0.001,
    "deepseek-v4-pro": 0.01,
}

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 1.0


def _base_url() -> str:
    return os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")


def _api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise DeepSeekError("DEEPSEEK_API_KEY not set")
    return key


def complete(model: str, prompt: str) -> CompletionResult:
    if model not in _PRICING_USD_PER_1K_TOKENS:
        raise DeepSeekError(f"unknown pricing for model {model!r}")
    api_key = _api_key()

    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        start = time.monotonic()
        try:
            response = httpx.post(
                f"{_base_url()}/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
                timeout=60,
            )
            latency_ms = (time.monotonic() - start) * 1000
            if response.status_code != 200:
                raise DeepSeekError(f"DeepSeek API returned {response.status_code}: {response.text}")
            body = response.json()
            text = body["choices"][0]["message"]["content"]
            total_tokens = body["usage"]["total_tokens"]
            cost_usd = (total_tokens / 1000) * _PRICING_USD_PER_1K_TOKENS[model]
            return CompletionResult(text=text, cost_usd=cost_usd, latency_ms=latency_ms)
        except (httpx.TimeoutException, httpx.NetworkError, DeepSeekError) as exc:
            last_error = exc
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_RETRY_BACKOFF_SECONDS)

    raise DeepSeekError(f"DeepSeek API call failed after {_MAX_RETRIES} attempts: {last_error}") from last_error
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_deepseek_client.py -v`
Expected: 4 passed

- [ ] **Step 7: Commit**

```bash
git add core/experiment/deepseek_client.py pyproject.toml tests/core/experiment/test_deepseek_client.py
git commit -m "feat: add DeepSeek API client with real cost/latency and retry"
```

---

### Task 5: LLM-judge (`core/experiment/judge.py`)

**Files:**
- Create: `core/experiment/judge.py`
- Test: `tests/core/experiment/test_judge.py`

**Interfaces:**
- Consumes: `complete`, `DeepSeekError`, `CompletionResult` from `core.experiment.deepseek_client` (Task 4).
- Produces: `judge_quality(prompt: str, response_text: str) -> float`, always calling `deepseek-v4-pro`, returning a score in `[0, 1]`, retrying once on unparseable/out-of-range judge output before raising `DeepSeekError`.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_judge.py
from unittest.mock import patch

import pytest

from core.experiment.deepseek_client import CompletionResult, DeepSeekError
from core.experiment.judge import judge_quality


def test_judge_quality_parses_score_and_normalizes():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="7", cost_usd=0.001, latency_ms=100.0)
        score = judge_quality("summarize this", "a decent summary")

    assert score == pytest.approx(0.7)


def test_judge_quality_parses_score_with_extra_text():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="Score: 8.5 out of 10", cost_usd=0.001, latency_ms=100.0)
        score = judge_quality("summarize this", "a good summary")

    assert score == pytest.approx(0.85)


def test_judge_quality_retries_once_on_unparseable_output_then_succeeds():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.side_effect = [
            CompletionResult(text="I cannot rate this.", cost_usd=0.001, latency_ms=100.0),
            CompletionResult(text="6", cost_usd=0.001, latency_ms=100.0),
        ]
        score = judge_quality("summarize this", "a summary")

    assert score == pytest.approx(0.6)
    assert mock_complete.call_count == 2


def test_judge_quality_raises_after_retry_exhausted():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="unparseable", cost_usd=0.001, latency_ms=100.0)
        with pytest.raises(DeepSeekError, match="could not parse"):
            judge_quality("summarize this", "a summary")

    assert mock_complete.call_count == 2


def test_judge_quality_always_uses_v4_pro_regardless_of_candidate():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="9", cost_usd=0.001, latency_ms=100.0)
        judge_quality("prompt", "response from deepseek-v4-flash")

    called_model = mock_complete.call_args[0][0]
    assert called_model == "deepseek-v4-pro"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_judge.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.judge'`

- [ ] **Step 3: Write `core/experiment/judge.py`**

```python
import re

from core.experiment.deepseek_client import DeepSeekError, complete

JUDGE_MODEL = "deepseek-v4-pro"

_RUBRIC_PROMPT = """You are evaluating the quality of an AI assistant's response to a task.

Task prompt:
{prompt}

Response to evaluate:
{response_text}

Rate the response's quality on a scale from 0 to 10, where 0 is completely
unhelpful or incorrect and 10 is excellent, accurate, and complete.
Reply with ONLY the number, nothing else."""


def judge_quality(prompt: str, response_text: str) -> float:
    judge_prompt = _RUBRIC_PROMPT.format(prompt=prompt, response_text=response_text)

    last_error: DeepSeekError | None = None
    for _attempt in range(2):
        result = complete(JUDGE_MODEL, judge_prompt)
        match = re.search(r"\d+(\.\d+)?", result.text)
        if match:
            score = float(match.group())
            if 0 <= score <= 10:
                return score / 10.0
            last_error = DeepSeekError(f"judge score out of range 0-10: {score}")
        else:
            last_error = DeepSeekError(f"could not parse judge score from: {result.text!r}")

    raise last_error
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_judge.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add core/experiment/judge.py tests/core/experiment/test_judge.py
git commit -m "feat: add deepseek-v4-pro LLM-judge for quality scoring"
```

---

### Task 6: Score cache (`core/experiment/score_cache.py`)

**Files:**
- Create: `core/experiment/score_cache.py`
- Test: `tests/core/experiment/test_score_cache.py`

**Interfaces:**
- Consumes: `ScoreCacheRecord` from `storage.models` (Task 1); `get_session`, `make_engine` from `storage.db`.
- Produces: `get_cached_score(session: Session, scenario_id: str, candidate_id: str) -> ScoreCacheRecord | None`; `put_score(session: Session, scenario_id: str, candidate_id: str, cost_usd: float, quality: float, latency_ms: float, business_risk: float, raw_response: str, judge_raw: str) -> ScoreCacheRecord`.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_score_cache.py
from core.experiment.score_cache import get_cached_score, put_score
from storage.db import get_session, make_engine


def test_put_then_get_returns_same_score(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        put_score(
            session, "s-001", "deepseek-v4-flash",
            cost_usd=0.002, quality=0.8, latency_ms=850.0, business_risk=0.25,
            raw_response="hello", judge_raw="8",
        )

    with get_session(engine) as session:
        cached = get_cached_score(session, "s-001", "deepseek-v4-flash")

    assert cached is not None
    assert cached.cost_usd == 0.002
    assert cached.quality == 0.8


def test_get_cached_score_returns_none_for_miss(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        cached = get_cached_score(session, "s-999", "unknown")

    assert cached is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_score_cache.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.score_cache'`

- [ ] **Step 3: Write `core/experiment/score_cache.py`**

```python
from sqlmodel import Session, select

from storage.models import ScoreCacheRecord


def get_cached_score(session: Session, scenario_id: str, candidate_id: str) -> ScoreCacheRecord | None:
    statement = select(ScoreCacheRecord).where(
        ScoreCacheRecord.scenario_id == scenario_id,
        ScoreCacheRecord.candidate_id == candidate_id,
    )
    return session.exec(statement).first()


def put_score(
    session: Session,
    scenario_id: str,
    candidate_id: str,
    cost_usd: float,
    quality: float,
    latency_ms: float,
    business_risk: float,
    raw_response: str,
    judge_raw: str,
) -> ScoreCacheRecord:
    record = ScoreCacheRecord(
        scenario_id=scenario_id,
        candidate_id=candidate_id,
        cost_usd=cost_usd,
        quality=quality,
        latency_ms=latency_ms,
        business_risk=business_risk,
        raw_response=raw_response,
        judge_raw=judge_raw,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_score_cache.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add core/experiment/score_cache.py tests/core/experiment/test_score_cache.py
git commit -m "feat: add score cache to avoid redundant DeepSeek API calls"
```

---

### Task 7: Baseline selection strategies (`core/experiment/baselines.py`)

**Files:**
- Create: `core/experiment/baselines.py`
- Test: `tests/core/experiment/test_baselines.py`

**Interfaces:**
- Consumes: `Candidate`, `Objective` from `core.modm.models`; `weighted_sum` from `core.modm.weighted_sum` (both existing, Tasks 2-3 of the v1 plan).
- Produces: `select_ahp_saw(candidates: list[Candidate], weights: dict[str, float]) -> str | None`; `select_no_policy(candidates: list[Candidate]) -> str | None`; `select_always_strong(candidates: list[Candidate]) -> str | None`; `select_always_cheap(candidates: list[Candidate]) -> str | None`. All return `None` for an empty candidate list. `made`'s own selection is NOT here — it's the existing `core.decision.engine.decide()`, invoked directly by the harness (Task 9-10).

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_baselines.py
from core.experiment.baselines import (
    select_ahp_saw, select_always_cheap, select_always_strong, select_no_policy,
)
from core.modm.models import Candidate

CANDIDATES = [
    Candidate(id="cheap", scores={"cost": 0.001, "quality": 0.5, "latency": 1.0, "business_risk": 0.3}),
    Candidate(id="strong", scores={"cost": 0.02, "quality": 0.95, "latency": 1.5, "business_risk": 0.1}),
]


def test_select_always_strong_picks_highest_quality():
    assert select_always_strong(CANDIDATES) == "strong"


def test_select_always_cheap_picks_lowest_cost():
    assert select_always_cheap(CANDIDATES) == "cheap"


def test_select_ahp_saw_uses_given_weights():
    weights = {"cost": 0.1, "quality": 0.7, "latency": 0.1, "business_risk": 0.1}
    assert select_ahp_saw(CANDIDATES, weights) == "strong"


def test_select_no_policy_uses_equal_weights():
    result = select_no_policy(CANDIDATES)
    assert result in {"cheap", "strong"}


def test_empty_candidates_returns_none_for_all_strategies():
    assert select_always_strong([]) is None
    assert select_always_cheap([]) is None
    assert select_ahp_saw([], {"cost": 1.0, "quality": 0.0, "latency": 0.0, "business_risk": 0.0}) is None
    assert select_no_policy([]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_baselines.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.baselines'`

- [ ] **Step 3: Write `core/experiment/baselines.py`**

```python
from core.modm.models import Candidate, Objective
from core.modm.weighted_sum import weighted_sum

_STANDARD_OBJECTIVES = [
    ("cost", "minimize"),
    ("quality", "maximize"),
    ("latency", "minimize"),
    ("business_risk", "minimize"),
]


def _objectives_with_weights(weights: dict[str, float]) -> list[Objective]:
    return [
        Objective(name=name, direction=direction, weight=weights[name])
        for name, direction in _STANDARD_OBJECTIVES
    ]


def select_ahp_saw(candidates: list[Candidate], weights: dict[str, float]) -> str | None:
    if not candidates:
        return None
    ranking = weighted_sum(candidates, _objectives_with_weights(weights))
    return ranking.best.id if ranking.best else None


def select_no_policy(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    equal_weights = {"cost": 0.25, "quality": 0.25, "latency": 0.25, "business_risk": 0.25}
    ranking = weighted_sum(candidates, _objectives_with_weights(equal_weights))
    return ranking.best.id if ranking.best else None


def select_always_strong(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    return max(candidates, key=lambda c: c.scores["quality"]).id


def select_always_cheap(candidates: list[Candidate]) -> str | None:
    if not candidates:
        return None
    return min(candidates, key=lambda c: c.scores["cost"]).id
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_baselines.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add core/experiment/baselines.py tests/core/experiment/test_baselines.py
git commit -m "feat: add 4 baseline selection strategies (AHP-SAW, always-strong/cheap, no-policy)"
```

---

### Task 8: Scenario generator (`experiments/generate_scenarios.py`)

**Files:**
- Create: `experiments/generate_scenarios.py`
- Create: `tests/experiments/__init__.py`
- Test: `tests/experiments/test_generate_scenarios.py`

**Interfaces:**
- Produces: `generate_scenarios(count: int, seed: int) -> list[dict]`, each dict shaped `{"scenario_id": str, "task": {"type": str, "data_classification": str}, "prompt": str, "real_candidates": ["deepseek-v4-flash", "deepseek-v4-pro"], "synthetic_candidates": [dict], "org": {"budget_remaining_usd": float, "region": str}, "policy_set": "default"}`; a CLI (`python experiments/generate_scenarios.py`) writing `experiments/scenarios/v1.jsonl`.

- [ ] **Step 1: Write the failing test**

```python
# tests/experiments/test_generate_scenarios.py
from experiments.generate_scenarios import generate_scenarios


def test_generates_requested_count_with_valid_schema():
    scenarios = generate_scenarios(count=120, seed=42)

    assert len(scenarios) == 120
    ids = [s["scenario_id"] for s in scenarios]
    assert len(ids) == len(set(ids))

    for s in scenarios:
        assert s["task"]["type"] and s["task"]["data_classification"]
        assert isinstance(s["prompt"], str) and len(s["prompt"]) > 0
        assert s["real_candidates"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
        assert len(s["synthetic_candidates"]) == 1
        synth = s["synthetic_candidates"][0]
        assert set(synth["scores"].keys()) == {"cost", "quality", "latency", "business_risk"}
        assert "budget_remaining_usd" in s["org"] and "region" in s["org"]
        assert s["policy_set"] == "default"


def test_deterministic_with_same_seed():
    first = generate_scenarios(count=50, seed=7)
    second = generate_scenarios(count=50, seed=7)
    assert first == second


def test_different_seed_produces_different_order():
    first = generate_scenarios(count=50, seed=1)
    second = generate_scenarios(count=50, seed=2)
    assert [s["scenario_id"] for s in first] != [] and first != second
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/experiments/test_generate_scenarios.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'experiments.generate_scenarios'`

- [ ] **Step 3: Create `tests/experiments/__init__.py`** (empty)

- [ ] **Step 4: Write `experiments/generate_scenarios.py`**

```python
"""Generate MADE experiment scenarios: task_type x data_classification x
budget_level x region combinations, with a fixed prompt per task_type.

Run:
  python experiments/generate_scenarios.py --count 120 --seed 42
"""
import argparse
import itertools
import json
import random
from pathlib import Path

TASK_TEMPLATES = [
    ("summarization", "Ringkas laporan kuartalan berikut dalam 3 poin utama: pendapatan naik 12%, biaya operasional turun 5%, ekspansi ke dua pasar baru direncanakan tahun depan."),
    ("summarization", "Ringkas notulen rapat berikut: tim sepakat menunda peluncuran fitur X ke Q3, menambah anggaran marketing 15%, dan merekrut dua engineer baru."),
    ("contract_review", "Tinjau klausul berikut untuk risiko hukum: pihak kedua berhak membatalkan kontrak sepihak dengan pemberitahuan 7 hari tanpa kompensasi."),
    ("contract_review", "Tinjau klausul kerahasiaan berikut: informasi rahasia hanya dilindungi selama 6 bulan setelah kontrak berakhir."),
    ("automation", "Buat langkah-langkah untuk memindahkan file log lama ke folder arsip setiap malam."),
    ("automation", "Jelaskan langkah untuk membersihkan cache aplikasi secara otomatis setiap minggu."),
    ("customer_support", "Balas keluhan pelanggan berikut dengan sopan: 'Pesanan saya belum sampai setelah 10 hari, saya kecewa.'"),
    ("customer_support", "Jawab pertanyaan pelanggan berikut: 'Apakah produk ini bisa dikembalikan dalam 30 hari?'"),
]

DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"]

BUDGET_LEVELS = {
    "generous": 1.0,
    "tight": 0.01,
    "very_tight": 0.0005,
}

REGIONS = ["us", "eu"]

REAL_CANDIDATES = ["deepseek-v4-flash", "deepseek-v4-pro"]

SYNTHETIC_DENY_CANDIDATE = {
    "id": "local-llama",
    "vendor": "unverified-oss",
    "kind": "model",
    "cost_per_1k_tokens": 0.0,
    "scores": {"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4},
}


def generate_scenarios(count: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    combos = list(itertools.product(TASK_TEMPLATES, DATA_CLASSIFICATIONS, BUDGET_LEVELS.items(), REGIONS))
    rng.shuffle(combos)

    scenarios = []
    for i, ((task_type, prompt), data_classification, (_budget_label, budget_value), region) in enumerate(
        combos[:count]
    ):
        scenarios.append({
            "scenario_id": f"s-{i + 1:03d}",
            "task": {"type": task_type, "data_classification": data_classification},
            "prompt": prompt,
            "real_candidates": REAL_CANDIDATES,
            "synthetic_candidates": [SYNTHETIC_DENY_CANDIDATE],
            "org": {"budget_remaining_usd": budget_value, "region": region},
            "policy_set": "default",
        })
    return scenarios


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "scenarios" / "v1.jsonl")
    args = parser.parse_args()

    scenarios = generate_scenarios(args.count, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as f:
        for scenario in scenarios:
            f.write(json.dumps(scenario) + "\n")

    print(f"Generated {len(scenarios)} scenarios to {args.output}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/experiments/test_generate_scenarios.py -v`
Expected: 3 passed

- [ ] **Step 6: Generate the actual dataset file**

Run: `python experiments/generate_scenarios.py --count 120 --seed 42`
Expected: prints `Generated 120 scenarios to .../experiments/scenarios/v1.jsonl`; the file now exists with 120 lines

- [ ] **Step 7: Commit**

```bash
git add experiments/generate_scenarios.py tests/experiments/__init__.py tests/experiments/test_generate_scenarios.py experiments/scenarios/v1.jsonl
git commit -m "feat: add scenario generator and generate v1 dataset (120 scenarios)"
```

---

### Task 9: Harness — scoring and ground-truth violation check (`core/experiment/harness.py`, part 1)

**Files:**
- Create: `core/experiment/harness.py`
- Test: `tests/core/experiment/test_harness.py`

**Interfaces:**
- Consumes: `complete` from `core.experiment.deepseek_client`; `judge_quality` from `core.experiment.judge`; `get_cached_score`, `put_score` from `core.experiment.score_cache`; `evaluate_hard_constraints` from `core.epm.opa_client`.
- Produces: `load_scenarios(path: Path) -> list[dict]`; `build_candidate_infos(scenario: dict, session: Session, candidates_config: dict) -> list[dict]` (each dict shaped `{"id", "vendor", "kind", "cost_per_1k_tokens", "scores": {cost, quality, latency, business_risk}, "status": "ok"|"failed"}`); `is_policy_violation(scenario: dict, candidate_info: dict) -> bool`. `POLICIES_ROOT` module-level constant (`Path` to the repo's `policies/` dir, mirroring `api/main.py`'s `POLICIES_ROOT`).

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_harness.py
import json
from unittest.mock import patch

from core.experiment.deepseek_client import CompletionResult, DeepSeekError
from core.experiment.harness import build_candidate_infos, is_policy_violation, load_scenarios
from storage.db import get_session, make_engine

SCENARIO = {
    "scenario_id": "s-001",
    "task": {"type": "summarization", "data_classification": "public"},
    "prompt": "Ringkas teks berikut.",
    "real_candidates": ["deepseek-v4-flash"],
    "synthetic_candidates": [
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2.0, "business_risk": 0.4}},
    ],
    "org": {"budget_remaining_usd": 1.0, "region": "us"},
    "policy_set": "default",
}

CANDIDATES_CONFIG = {
    "models_by_id": {
        "deepseek-v4-flash": {"id": "deepseek-v4-flash", "vendor": "deepseek", "business_risk": 0.25},
    }
}


def test_build_candidate_infos_calls_api_on_cache_miss(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan singkat", cost_usd=0.001, latency_ms=500.0)
        mock_judge.return_value = 0.8

        with get_session(engine) as session:
            infos = build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    assert mock_complete.call_count == 1
    real_info = next(i for i in infos if i["id"] == "deepseek-v4-flash")
    assert real_info["status"] == "ok"
    assert real_info["scores"]["quality"] == 0.8
    synth_info = next(i for i in infos if i["id"] == "local-llama")
    assert synth_info["scores"]["business_risk"] == 0.4


def test_build_candidate_infos_uses_cache_on_second_call(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = 0.7

        with get_session(engine) as session:
            build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

        with get_session(engine) as session:
            build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    assert mock_complete.call_count == 1


def test_build_candidate_infos_marks_failed_on_persistent_api_error(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete:
        mock_complete.side_effect = DeepSeekError("persistent failure")

        with get_session(engine) as session:
            infos = build_candidate_infos(SCENARIO, session, CANDIDATES_CONFIG)

    real_info = next(i for i in infos if i["id"] == "deepseek-v4-flash")
    assert real_info["status"] == "failed"


def test_is_policy_violation_true_for_denied_candidate():
    denied_info = {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0}
    confidential_scenario = {**SCENARIO, "task": {"type": "summarization", "data_classification": "confidential"}}

    assert is_policy_violation(confidential_scenario, denied_info) is True


def test_is_policy_violation_false_for_compliant_candidate():
    allowed_info = {"id": "deepseek-v4-flash", "vendor": "deepseek", "kind": "model", "cost_per_1k_tokens": 0.001}

    assert is_policy_violation(SCENARIO, allowed_info) is False


def test_load_scenarios_parses_jsonl(tmp_path):
    scenarios_path = tmp_path / "v1.jsonl"
    scenarios_path.write_text(json.dumps(SCENARIO) + "\n")

    scenarios = load_scenarios(scenarios_path)

    assert len(scenarios) == 1
    assert scenarios[0]["scenario_id"] == "s-001"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_harness.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.harness'`

- [ ] **Step 3: Write `core/experiment/harness.py`** (this task writes only the pieces this test file exercises — `run_scenario_for_baseline`/`run_experiment` are added in Task 10, appended to this same file)

```python
import json
from pathlib import Path

from sqlmodel import Session

from core.epm.opa_client import evaluate_hard_constraints
from core.experiment.deepseek_client import DeepSeekError, complete
from core.experiment.judge import judge_quality
from core.experiment.score_cache import get_cached_score, put_score

POLICIES_ROOT = Path(__file__).resolve().parent.parent.parent / "policies"


def load_scenarios(path: Path) -> list[dict]:
    scenarios = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                scenarios.append(json.loads(line))
    return scenarios


def build_candidate_infos(scenario: dict, session: Session, candidates_config: dict) -> list[dict]:
    infos: list[dict] = []

    for candidate_id in scenario["real_candidates"]:
        model_config = candidates_config["models_by_id"][candidate_id]
        cached = get_cached_score(session, scenario["scenario_id"], candidate_id)
        if cached is None:
            try:
                completion = complete(candidate_id, scenario["prompt"])
                quality = judge_quality(scenario["prompt"], completion.text)
            except DeepSeekError as exc:
                infos.append({"id": candidate_id, "status": "failed", "error": str(exc)})
                continue
            cached = put_score(
                session, scenario["scenario_id"], candidate_id,
                cost_usd=completion.cost_usd, quality=quality, latency_ms=completion.latency_ms,
                business_risk=model_config["business_risk"],
                raw_response=completion.text, judge_raw=str(quality),
            )
        infos.append({
            "id": candidate_id,
            "vendor": model_config["vendor"],
            "kind": "model",
            "cost_per_1k_tokens": cached.cost_usd,
            "scores": {
                "cost": cached.cost_usd, "quality": cached.quality,
                "latency": cached.latency_ms, "business_risk": cached.business_risk,
            },
            "status": "ok",
        })

    for synth in scenario["synthetic_candidates"]:
        infos.append({
            "id": synth["id"],
            "vendor": synth["vendor"],
            "kind": synth["kind"],
            "cost_per_1k_tokens": synth["cost_per_1k_tokens"],
            "scores": dict(synth["scores"]),
            "status": "ok",
        })

    return infos


def is_policy_violation(scenario: dict, candidate_info: dict) -> bool:
    input_doc = {
        "task": scenario["task"],
        "candidate": {
            "kind": candidate_info["kind"],
            "id": candidate_info["id"],
            "vendor": candidate_info["vendor"],
            "cost_per_1k_tokens": candidate_info["cost_per_1k_tokens"],
        },
        "org": scenario["org"],
    }
    result = evaluate_hard_constraints(input_doc, POLICIES_ROOT / "hard")
    return not result["allow"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_harness.py -v`
Expected: 6 passed (requires real OPA on PATH and real `policies/hard/` for the `is_policy_violation` tests, no real DeepSeek calls since those are mocked)

- [ ] **Step 5: Commit**

```bash
git add core/experiment/harness.py tests/core/experiment/test_harness.py
git commit -m "feat: add harness scoring (cache-aware) and ground-truth violation check"
```

---

### Task 10: Harness — baseline dispatch and orchestration (`core/experiment/harness.py`, part 2)

**Files:**
- Modify: `core/experiment/harness.py` (append)
- Test: `tests/core/experiment/test_harness_orchestration.py`

**Interfaces:**
- Consumes: `load_scenarios`, `build_candidate_infos`, `is_policy_violation`, `POLICIES_ROOT` from this same module (Task 9); `Task`, `Org`, `DecisionCandidate`, `decide` from `core.decision.engine`; `Candidate` from `core.modm.models`; `select_ahp_saw`, `select_always_strong`, `select_always_cheap`, `select_no_policy` from `core.experiment.baselines`; `ExperimentRun`, `ExperimentResult` from `storage.models`.
- Produces: `BASELINES = ["made", "ahp_saw", "always_strong", "always_cheap", "no_policy"]`; `run_scenario_for_baseline(baseline: str, scenario: dict, infos: list[dict], ahp_weights: dict[str, float]) -> dict` (shaped `{"selected_candidate_id": str | None, "policy_violation": bool, "cost_usd": float, "quality_score": float, "latency_ms": float, "status": "ok"|"failed"}`); `run_experiment(session: Session, scenarios: list[dict], candidates_config: dict, ahp_weights: dict[str, float], scenario_dataset_version: str) -> dict[str, str]` (returns `{baseline: run_id}`), persisting one `ExperimentRun` per baseline and one `ExperimentResult` per (scenario, baseline).

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_harness_orchestration.py
from unittest.mock import patch

from sqlmodel import select

from core.experiment.deepseek_client import CompletionResult
from core.experiment.harness import run_experiment, run_scenario_for_baseline
from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun

AHP_WEIGHTS = {"cost": 0.25, "quality": 0.5, "latency": 0.15, "business_risk": 0.1}

SCENARIO = {
    "scenario_id": "s-001",
    "task": {"type": "summarization", "data_classification": "public"},
    "prompt": "Ringkas teks berikut.",
    "real_candidates": ["deepseek-v4-flash"],
    "synthetic_candidates": [
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}},
    ],
    "org": {"budget_remaining_usd": 1.0, "region": "us"},
    "policy_set": "default",
}

CANDIDATES_CONFIG = {
    "models_by_id": {
        "deepseek-v4-flash": {"id": "deepseek-v4-flash", "vendor": "deepseek", "business_risk": 0.25},
    }
}

PREFILLED_INFOS = [
    {"id": "deepseek-v4-flash", "vendor": "deepseek", "kind": "model", "cost_per_1k_tokens": 0.001,
     "scores": {"cost": 0.001, "quality": 0.8, "latency": 400.0, "business_risk": 0.25}, "status": "ok"},
    {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
     "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}, "status": "ok"},
]


def test_run_scenario_for_baseline_always_cheap_picks_local_llama():
    outcome = run_scenario_for_baseline("always_cheap", SCENARIO, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "local-llama"
    assert outcome["status"] == "ok"


def test_run_scenario_for_baseline_made_excludes_denied_candidate_for_confidential():
    confidential_scenario = {**SCENARIO, "task": {"type": "summarization", "data_classification": "confidential"}}
    outcome = run_scenario_for_baseline("made", confidential_scenario, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "deepseek-v4-flash"
    assert outcome["policy_violation"] is False


def test_run_scenario_for_baseline_always_cheap_flagged_as_violation_for_confidential():
    confidential_scenario = {**SCENARIO, "task": {"type": "summarization", "data_classification": "confidential"}}
    outcome = run_scenario_for_baseline("always_cheap", confidential_scenario, PREFILLED_INFOS, AHP_WEIGHTS)
    assert outcome["selected_candidate_id"] == "local-llama"
    assert outcome["policy_violation"] is True


def test_run_experiment_persists_results_for_all_baselines(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = 0.8

        with get_session(engine) as session:
            run_ids = run_experiment(
                session, [SCENARIO], CANDIDATES_CONFIG, AHP_WEIGHTS, scenario_dataset_version="test-v1",
            )

    assert set(run_ids.keys()) == {"made", "ahp_saw", "always_strong", "always_cheap", "no_policy"}

    with get_session(engine) as session:
        runs = session.exec(select(ExperimentRun)).all()
        results = session.exec(select(ExperimentResult)).all()

    assert len(runs) == 5
    assert len(results) == 5
    assert all(r.scenario_id == "s-001" for r in results)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_harness_orchestration.py -v`
Expected: FAIL with `ImportError: cannot import name 'run_scenario_for_baseline' from 'core.experiment.harness'`

- [ ] **Step 3: Append to `core/experiment/harness.py`**

Add these imports at the top (merge with existing imports from Task 9):

```python
from core.decision.engine import DecisionCandidate, Org, Task, decide
from core.experiment.baselines import (
    select_ahp_saw, select_always_cheap, select_always_strong, select_no_policy,
)
from core.modm.models import Candidate
from storage.models import ExperimentResult, ExperimentRun
```

Append the following to the end of the file:

```python
BASELINES = ["made", "ahp_saw", "always_strong", "always_cheap", "no_policy"]


def _make_decision_candidates(infos: list[dict]) -> list[DecisionCandidate]:
    return [
        DecisionCandidate(
            id=i["id"], vendor=i["vendor"], kind=i["kind"],
            cost_per_1k_tokens=i["cost_per_1k_tokens"], scores=i["scores"],
        )
        for i in infos if i["status"] == "ok"
    ]


def _make_modm_candidates(infos: list[dict]) -> list[Candidate]:
    return [Candidate(id=i["id"], scores=i["scores"]) for i in infos if i["status"] == "ok"]


def run_scenario_for_baseline(
    baseline: str, scenario: dict, infos: list[dict], ahp_weights: dict[str, float],
) -> dict:
    ok_infos = [i for i in infos if i["status"] == "ok"]
    info_by_id = {i["id"]: i for i in ok_infos}

    if not ok_infos:
        return {"selected_candidate_id": None, "policy_violation": False,
                "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"}

    if baseline == "made":
        task = Task(type=scenario["task"]["type"], data_classification=scenario["task"]["data_classification"])
        org = Org(budget_remaining_usd=scenario["org"]["budget_remaining_usd"], region=scenario["org"]["region"])
        result = decide(
            task=task, org=org, candidates=_make_decision_candidates(ok_infos), policies_dir=POLICIES_ROOT,
        )
        selected_id = result.selected_candidate_id
    else:
        modm_candidates = _make_modm_candidates(ok_infos)
        if baseline == "ahp_saw":
            selected_id = select_ahp_saw(modm_candidates, ahp_weights)
        elif baseline == "always_strong":
            selected_id = select_always_strong(modm_candidates)
        elif baseline == "always_cheap":
            selected_id = select_always_cheap(modm_candidates)
        elif baseline == "no_policy":
            selected_id = select_no_policy(modm_candidates)
        else:
            raise ValueError(f"unknown baseline {baseline!r}")

    if selected_id is None:
        return {"selected_candidate_id": None, "policy_violation": False,
                "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "ok"}

    selected_info = info_by_id[selected_id]
    violation = is_policy_violation(scenario, selected_info)

    return {
        "selected_candidate_id": selected_id,
        "policy_violation": violation,
        "cost_usd": selected_info["scores"]["cost"],
        "quality_score": selected_info["scores"]["quality"],
        "latency_ms": selected_info["scores"]["latency"],
        "status": "ok",
    }


def run_experiment(
    session: Session,
    scenarios: list[dict],
    candidates_config: dict,
    ahp_weights: dict[str, float],
    scenario_dataset_version: str,
) -> dict[str, str]:
    run_ids: dict[str, str] = {}
    for baseline in BASELINES:
        run = ExperimentRun(baseline=baseline, scenario_dataset_version=scenario_dataset_version)
        session.add(run)
        session.commit()
        session.refresh(run)
        run_ids[baseline] = run.id

    for scenario in scenarios:
        infos = build_candidate_infos(scenario, session, candidates_config)
        for baseline in BASELINES:
            outcome = run_scenario_for_baseline(baseline, scenario, infos, ahp_weights)
            session.add(ExperimentResult(
                run_id=run_ids[baseline], scenario_id=scenario["scenario_id"], **outcome,
            ))
        session.commit()

    return run_ids
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_harness_orchestration.py -v`
Expected: 4 passed

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `pytest -v`
Expected: all previous tests plus this task's new ones pass (no failures)

- [ ] **Step 6: Commit**

```bash
git add core/experiment/harness.py tests/core/experiment/test_harness_orchestration.py
git commit -m "feat: add baseline dispatch and full experiment orchestration to harness"
```

---

### Task 11: Metrics aggregation and CSV export (`core/experiment/metrics.py`)

**Files:**
- Create: `core/experiment/metrics.py`
- Test: `tests/core/experiment/test_metrics.py`

**Interfaces:**
- Consumes: `ExperimentResult`, `ExperimentRun` from `storage.models`.
- Produces: `compute_baseline_summary(session: Session, run_id: str) -> dict` (`{"run_id", "n_scenarios", "n_failed", "policy_violation_rate", "mean_cost_usd", "mean_quality", "mean_latency_ms"}`, means/rate are `None` when `n_scenarios == 0`); `export_results_csv(session: Session, run_ids: dict[str, str], output_path: Path) -> None`.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/experiment/test_metrics.py
import csv

from core.experiment.metrics import compute_baseline_summary, export_results_csv
from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun


def _seed_run(session, baseline, results):
    run = ExperimentRun(baseline=baseline, scenario_dataset_version="test-v1")
    session.add(run)
    session.commit()
    session.refresh(run)
    for r in results:
        session.add(ExperimentResult(run_id=run.id, **r))
    session.commit()
    return run.id


def test_compute_baseline_summary_calculates_violation_rate_and_means(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "always_cheap", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": True,
             "cost_usd": 0.0, "quality_score": 0.5, "latency_ms": 100.0, "status": "ok"},
            {"scenario_id": "s-2", "selected_candidate_id": "b", "policy_violation": False,
             "cost_usd": 0.002, "quality_score": 0.9, "latency_ms": 300.0, "status": "ok"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 2
    assert summary["policy_violation_rate"] == 0.5
    assert summary["mean_cost_usd"] == 0.001
    assert summary["mean_quality"] == 0.7


def test_compute_baseline_summary_excludes_failed_scenarios(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": False,
             "cost_usd": 0.001, "quality_score": 0.8, "latency_ms": 200.0, "status": "ok"},
            {"scenario_id": "s-2", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 1
    assert summary["n_failed"] == 1


def test_compute_baseline_summary_returns_none_means_when_all_failed(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": None, "policy_violation": False,
             "cost_usd": 0.0, "quality_score": 0.0, "latency_ms": 0.0, "status": "failed"},
        ])

    with get_session(engine) as session:
        summary = compute_baseline_summary(session, run_id)

    assert summary["n_scenarios"] == 0
    assert summary["policy_violation_rate"] is None


def test_export_results_csv_writes_all_baselines(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run_id = _seed_run(session, "made", [
            {"scenario_id": "s-1", "selected_candidate_id": "a", "policy_violation": False,
             "cost_usd": 0.001, "quality_score": 0.8, "latency_ms": 200.0, "status": "ok"},
        ])

    output_path = tmp_path / "results.csv"
    with get_session(engine) as session:
        export_results_csv(session, {"made": run_id}, output_path)

    with output_path.open() as f:
        rows = list(csv.DictReader(f))

    assert len(rows) == 1
    assert rows[0]["baseline"] == "made"
    assert rows[0]["scenario_id"] == "s-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/experiment/test_metrics.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.experiment.metrics'`

- [ ] **Step 3: Write `core/experiment/metrics.py`**

```python
import csv
from pathlib import Path

from sqlmodel import Session, select

from storage.models import ExperimentResult


def compute_baseline_summary(session: Session, run_id: str) -> dict:
    results = session.exec(
        select(ExperimentResult).where(ExperimentResult.run_id == run_id)
    ).all()
    ok_results = [r for r in results if r.status == "ok"]

    if not ok_results:
        return {
            "run_id": run_id, "n_scenarios": 0, "n_failed": len(results),
            "policy_violation_rate": None, "mean_cost_usd": None,
            "mean_quality": None, "mean_latency_ms": None,
        }

    n = len(ok_results)
    violations = sum(1 for r in ok_results if r.policy_violation)

    return {
        "run_id": run_id,
        "n_scenarios": n,
        "n_failed": len(results) - n,
        "policy_violation_rate": violations / n,
        "mean_cost_usd": sum(r.cost_usd for r in ok_results) / n,
        "mean_quality": sum(r.quality_score for r in ok_results) / n,
        "mean_latency_ms": sum(r.latency_ms for r in ok_results) / n,
    }


def export_results_csv(session: Session, run_ids: dict[str, str], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "baseline", "run_id", "scenario_id", "selected_candidate_id",
            "policy_violation", "cost_usd", "quality_score", "latency_ms", "status",
        ])
        for baseline, run_id in run_ids.items():
            results = session.exec(
                select(ExperimentResult).where(ExperimentResult.run_id == run_id)
            ).all()
            for r in results:
                writer.writerow([
                    baseline, run_id, r.scenario_id, r.selected_candidate_id,
                    r.policy_violation, r.cost_usd, r.quality_score, r.latency_ms, r.status,
                ])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/core/experiment/test_metrics.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add core/experiment/metrics.py tests/core/experiment/test_metrics.py
git commit -m "feat: add per-baseline metrics aggregation and CSV export"
```

---

### Task 12: API endpoint (`POST /experiment/run`) and CLI runner

**Files:**
- Modify: `api/schemas.py`
- Modify: `api/main.py`
- Create: `scripts/run_experiment.py`
- Modify: `.gitignore`
- Test: `tests/api/test_experiment_endpoint.py`

**Interfaces:**
- Consumes: `load_scenarios`, `run_experiment` from `core.experiment.harness`; `compute_baseline_summary`, `export_results_csv` from `core.experiment.metrics`; `load_candidates_config`, `load_ahp_weights` from `core.experiment.config_loader`; `get_engine`, `get_session` from `api.main`/`storage.db` (existing).
- Produces: `POST /experiment/run` accepting `{"scenario_dataset_version": str}`, returning `{"scenario_dataset_version": str, "summary": {baseline: BaselineSummaryOut}}`; `scripts/run_experiment.py` — a CLI that loads `.env`, runs the full experiment with real DeepSeek calls, prints summaries, and exports CSV to `experiments/results/<version>.csv`.

- [ ] **Step 1: Add schemas to `api/schemas.py`** — append to the end of the file:

```python
class ExperimentRunRequest(BaseModel):
    scenario_dataset_version: str = "v1"


class BaselineSummaryOut(BaseModel):
    run_id: str
    n_scenarios: int
    n_failed: int
    policy_violation_rate: float | None
    mean_cost_usd: float | None
    mean_quality: float | None
    mean_latency_ms: float | None


class ExperimentRunResponse(BaseModel):
    scenario_dataset_version: str
    summary: dict[str, BaselineSummaryOut]
```

- [ ] **Step 2: Write the failing test**

```python
# tests/api/test_experiment_endpoint.py
import json
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.experiment.deepseek_client import CompletionResult

SCENARIO = {
    "scenario_id": "s-001",
    "task": {"type": "summarization", "data_classification": "public"},
    "prompt": "Ringkas teks berikut.",
    "real_candidates": ["deepseek-v4-flash"],
    "synthetic_candidates": [
        {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0,
         "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}},
    ],
    "org": {"budget_remaining_usd": 1.0, "region": "us"},
    "policy_set": "default",
}


def _client(tmp_path, monkeypatch, scenarios_dir: Path):
    monkeypatch.setenv("MADE_DB_PATH", str(tmp_path / "test.db"))
    import api.main as main_module
    main_module._engine = None
    monkeypatch.setattr(main_module, "SCENARIOS_DIR", scenarios_dir)
    return TestClient(main_module.app)


def test_post_experiment_run_returns_summary_for_all_baselines(tmp_path, monkeypatch):
    scenarios_dir = tmp_path / "scenarios"
    scenarios_dir.mkdir()
    (scenarios_dir / "test.jsonl").write_text(json.dumps(SCENARIO) + "\n")

    with patch("core.experiment.harness.complete") as mock_complete, \
         patch("core.experiment.harness.judge_quality") as mock_judge:
        mock_complete.return_value = CompletionResult(text="ringkasan", cost_usd=0.001, latency_ms=400.0)
        mock_judge.return_value = 0.8

        client = _client(tmp_path, monkeypatch, scenarios_dir)
        response = client.post("/experiment/run", json={"scenario_dataset_version": "test"})

    assert response.status_code == 200
    body = response.json()
    assert set(body["summary"].keys()) == {"made", "ahp_saw", "always_strong", "always_cheap", "no_policy"}
    assert body["summary"]["made"]["n_scenarios"] == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/api/test_experiment_endpoint.py -v`
Expected: FAIL with 404 (route doesn't exist yet)

- [ ] **Step 4: Add imports and the endpoint to `api/main.py`**

Add to the imports section (after the existing `from storage.models import DecisionRecord` line):

```python
from api.schemas import BaselineSummaryOut, ExperimentRunRequest, ExperimentRunResponse
from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary
```

Add module-level constants (after `POLICIES_ROOT = ...`):

```python
CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
EXPERIMENTS_DIR = Path(__file__).resolve().parent.parent / "experiments"
SCENARIOS_DIR = EXPERIMENTS_DIR / "scenarios"
```

Append the endpoint at the end of the file:

```python
@app.post("/experiment/run", response_model=ExperimentRunResponse)
def post_experiment_run(request: ExperimentRunRequest) -> ExperimentRunResponse:
    scenarios_path = SCENARIOS_DIR / f"{request.scenario_dataset_version}.jsonl"
    scenarios = load_scenarios(scenarios_path)
    candidates_config = load_candidates_config(CONFIG_DIR / "candidates.yaml")
    ahp_weights = load_ahp_weights(EXPERIMENTS_DIR / "ahp_weights.yaml")

    with get_session(get_engine()) as session:
        run_ids = run_experiment(
            session, scenarios, candidates_config, ahp_weights, request.scenario_dataset_version,
        )
        summary = {
            baseline: BaselineSummaryOut(**compute_baseline_summary(session, run_id))
            for baseline, run_id in run_ids.items()
        }

    return ExperimentRunResponse(scenario_dataset_version=request.scenario_dataset_version, summary=summary)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/api/test_experiment_endpoint.py -v`
Expected: 1 passed

- [ ] **Step 6: Write `scripts/run_experiment.py`**

```python
"""Run the full MADE vs baseline comparison experiment using real DeepSeek API calls.

Prerequisites:
  - DEEPSEEK_API_KEY set in .env
  - OPA installed and on PATH
  - experiments/scenarios/<version>.jsonl generated (python experiments/generate_scenarios.py)

Run:
  python scripts/run_experiment.py --dataset-version v1
"""
import argparse
from pathlib import Path

from dotenv import load_dotenv

from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary, export_results_csv
from storage.db import get_session, make_engine

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    load_dotenv(REPO_ROOT / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-version", default="v1")
    parser.add_argument("--db-path", type=Path, default=REPO_ROOT / "made.db")
    parser.add_argument("--output-csv", type=Path, default=None)
    args = parser.parse_args()

    output_csv = args.output_csv or REPO_ROOT / "experiments" / "results" / f"{args.dataset_version}.csv"

    scenarios = load_scenarios(REPO_ROOT / "experiments" / "scenarios" / f"{args.dataset_version}.jsonl")
    candidates_config = load_candidates_config(REPO_ROOT / "config" / "candidates.yaml")
    ahp_weights = load_ahp_weights(REPO_ROOT / "experiments" / "ahp_weights.yaml")

    print(f"Running experiment: {len(scenarios)} scenarios, dataset version {args.dataset_version!r}")

    engine = make_engine(args.db_path)
    with get_session(engine) as session:
        run_ids = run_experiment(session, scenarios, candidates_config, ahp_weights, args.dataset_version)
        for baseline, run_id in run_ids.items():
            summary = compute_baseline_summary(session, run_id)
            print(f"{baseline}: {summary}")
        export_results_csv(session, run_ids, output_csv)

    print(f"\nResults exported to {output_csv}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Add `experiments/results/` to `.gitignore`** — append this line:

```
experiments/results/
```

- [ ] **Step 8: Run the full test suite to confirm no regressions**

Run: `pytest -v`
Expected: all tests pass (no real API calls triggered — everything in this suite is mocked)

- [ ] **Step 9: Commit**

```bash
git add api/schemas.py api/main.py scripts/run_experiment.py .gitignore tests/api/test_experiment_endpoint.py
git commit -m "feat: add POST /experiment/run endpoint and CLI experiment runner"
```

---

### Task 13: Results analysis and statistical comparison (T22-T23)

**Files:**
- Create: `experiments/analyze_results.py`
- Create: `experiments/statistical_tests.py`
- Modify: `pyproject.toml`
- Test: `tests/experiments/test_analyze_results.py`
- Test: `tests/experiments/test_statistical_tests.py`

**Interfaces:**
- Consumes: nothing from earlier `core/` modules — reads the CSV produced by `export_results_csv` (Task 11) directly, so these scripts can run standalone against `experiments/results/v1.csv` without touching the database.
- Produces: `experiments/analyze_results.py` — `load_results(csv_path: Path) -> dict[str, list[dict]]`, `summarize(rows: list[dict]) -> dict`, and a CLI printing a per-baseline table. `experiments/statistical_tests.py` — `paired_values(by_baseline, baseline, metric) -> tuple[list[float], list[float]]`, `compare_baseline(by_baseline, baseline) -> dict`, and a CLI printing paired Wilcoxon test p-values for `made` vs each other baseline on `cost_usd`, `quality_score`, `latency_ms`.

- [ ] **Step 1: Add `scipy` to `pyproject.toml` dependencies**

In the `dependencies` list (after `"python-dotenv>=1.0",`), add:
```toml
    "scipy>=1.13",
```

- [ ] **Step 2: Install the new dependency**

Run: `source .venv/bin/activate && pip install -e ".[dev]"`
Expected: `scipy` installs successfully

- [ ] **Step 3: Write the failing test for `analyze_results.py`**

```python
# tests/experiments/test_analyze_results.py
import csv

from experiments.analyze_results import load_results, summarize


def _write_csv(tmp_path, rows):
    path = tmp_path / "results.csv"
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "baseline", "run_id", "scenario_id", "selected_candidate_id",
            "policy_violation", "cost_usd", "quality_score", "latency_ms", "status",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def test_load_results_groups_by_baseline(tmp_path):
    path = _write_csv(tmp_path, [
        {"baseline": "made", "run_id": "r1", "scenario_id": "s-1", "selected_candidate_id": "a",
         "policy_violation": "False", "cost_usd": "0.001", "quality_score": "0.8",
         "latency_ms": "200", "status": "ok"},
        {"baseline": "always_cheap", "run_id": "r2", "scenario_id": "s-1", "selected_candidate_id": "b",
         "policy_violation": "True", "cost_usd": "0.0", "quality_score": "0.5",
         "latency_ms": "2000", "status": "ok"},
    ])

    by_baseline = load_results(path)

    assert set(by_baseline.keys()) == {"made", "always_cheap"}
    assert len(by_baseline["made"]) == 1


def test_summarize_computes_violation_rate_and_means():
    rows = [
        {"policy_violation": "True", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "100", "status": "ok"},
        {"policy_violation": "False", "cost_usd": "0.002", "quality_score": "0.9", "latency_ms": "300", "status": "ok"},
    ]

    summary = summarize(rows)

    assert summary["n"] == 2
    assert summary["policy_violation_rate"] == 0.5
    assert summary["mean_cost_usd"] == 0.001
    assert summary["mean_quality"] == 0.7


def test_summarize_excludes_failed_rows():
    rows = [
        {"policy_violation": "False", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"},
        {"policy_violation": "False", "cost_usd": "0", "quality_score": "0", "latency_ms": "0", "status": "failed"},
    ]

    summary = summarize(rows)

    assert summary["n"] == 1
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pytest tests/experiments/test_analyze_results.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'experiments.analyze_results'`

- [ ] **Step 5: Write `experiments/analyze_results.py`**

```python
"""Aggregate policy_violation_rate/cost/quality/latency per baseline from an
experiment results CSV (produced by core.experiment.metrics.export_results_csv).

Run:
  python experiments/analyze_results.py experiments/results/v1.csv
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path


def load_results(csv_path: Path) -> dict[str, list[dict]]:
    by_baseline: dict[str, list[dict]] = defaultdict(list)
    with csv_path.open() as f:
        for row in csv.DictReader(f):
            by_baseline[row["baseline"]].append(row)
    return dict(by_baseline)


def summarize(rows: list[dict]) -> dict:
    ok_rows = [r for r in rows if r["status"] == "ok"]
    n = len(ok_rows)
    if n == 0:
        return {"n": 0, "policy_violation_rate": None, "mean_cost_usd": None,
                "mean_quality": None, "mean_latency_ms": None}

    violations = sum(1 for r in ok_rows if r["policy_violation"] in ("True", "true", "1"))
    return {
        "n": n,
        "policy_violation_rate": violations / n,
        "mean_cost_usd": sum(float(r["cost_usd"]) for r in ok_rows) / n,
        "mean_quality": sum(float(r["quality_score"]) for r in ok_rows) / n,
        "mean_latency_ms": sum(float(r["latency_ms"]) for r in ok_rows) / n,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python experiments/analyze_results.py <results.csv>")
        return 1

    csv_path = Path(sys.argv[1])
    by_baseline = load_results(csv_path)

    header = f"{'baseline':<15} {'n':>5} {'violation_rate':>15} {'mean_cost':>12} {'mean_quality':>13} {'mean_latency_ms':>16}"
    print(header)
    for baseline, rows in sorted(by_baseline.items()):
        s = summarize(rows)
        if s["n"] == 0:
            print(f"{baseline:<15} {s['n']:>5} {'n/a':>15} {'n/a':>12} {'n/a':>13} {'n/a':>16}")
            continue
        print(f"{baseline:<15} {s['n']:>5} {s['policy_violation_rate']:>15.3f} "
              f"{s['mean_cost_usd']:>12.5f} {s['mean_quality']:>13.3f} {s['mean_latency_ms']:>16.1f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/experiments/test_analyze_results.py -v`
Expected: 3 passed

- [ ] **Step 7: Write the failing test for `statistical_tests.py`**

```python
# tests/experiments/test_statistical_tests.py
from experiments.statistical_tests import compare_baseline, paired_values


def test_paired_values_matches_by_scenario_id():
    by_baseline = {
        "made": [
            {"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.9", "latency_ms": "200", "status": "ok"},
            {"scenario_id": "s-2", "cost_usd": "0.002", "quality_score": "0.8", "latency_ms": "300", "status": "ok"},
        ],
        "always_cheap": [
            {"scenario_id": "s-1", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "2000", "status": "ok"},
            {"scenario_id": "s-2", "cost_usd": "0.0", "quality_score": "0.5", "latency_ms": "2000", "status": "ok"},
        ],
    }

    made_values, other_values = paired_values(by_baseline, "always_cheap", "quality_score")

    assert made_values == [0.9, 0.8]
    assert other_values == [0.5, 0.5]


def test_compare_baseline_returns_p_value_for_each_metric():
    by_baseline = {
        "made": [
            {"scenario_id": f"s-{i}", "cost_usd": "0.001", "quality_score": str(0.9 - i * 0.01),
             "latency_ms": "200", "status": "ok"}
            for i in range(10)
        ],
        "always_cheap": [
            {"scenario_id": f"s-{i}", "cost_usd": "0.0", "quality_score": str(0.5 + i * 0.01),
             "latency_ms": "2000", "status": "ok"}
            for i in range(10)
        ],
    }

    comparison = compare_baseline(by_baseline, "always_cheap")

    assert comparison["baseline"] == "always_cheap"
    assert comparison["quality_score"]["n"] == 10
    assert comparison["quality_score"]["p_value"] is not None


def test_compare_baseline_handles_identical_values_without_crashing():
    by_baseline = {
        "made": [{"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"}],
        "always_cheap": [{"scenario_id": "s-1", "cost_usd": "0.001", "quality_score": "0.8", "latency_ms": "200", "status": "ok"}],
    }

    comparison = compare_baseline(by_baseline, "always_cheap")

    assert comparison["quality_score"]["p_value"] is None
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pytest tests/experiments/test_statistical_tests.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'experiments.statistical_tests'`

- [ ] **Step 9: Write `experiments/statistical_tests.py`**

```python
"""Paired statistical comparison of MADE vs each baseline, from an experiment
results CSV (produced by core.experiment.metrics.export_results_csv).

Run:
  python experiments/statistical_tests.py experiments/results/v1.csv
"""
import sys
from pathlib import Path

from scipy import stats

from experiments.analyze_results import load_results

METRICS = ["cost_usd", "quality_score", "latency_ms"]


def paired_values(by_baseline: dict[str, list[dict]], baseline: str, metric: str) -> tuple[list[float], list[float]]:
    made_by_scenario = {r["scenario_id"]: r for r in by_baseline["made"] if r["status"] == "ok"}
    other_by_scenario = {r["scenario_id"]: r for r in by_baseline[baseline] if r["status"] == "ok"}
    common_ids = sorted(set(made_by_scenario) & set(other_by_scenario))

    made_values = [float(made_by_scenario[sid][metric]) for sid in common_ids]
    other_values = [float(other_by_scenario[sid][metric]) for sid in common_ids]
    return made_values, other_values


def compare_baseline(by_baseline: dict[str, list[dict]], baseline: str) -> dict:
    result: dict = {"baseline": baseline}
    for metric in METRICS:
        made_values, other_values = paired_values(by_baseline, baseline, metric)
        if len(made_values) < 2 or made_values == other_values:
            result[metric] = {"n": len(made_values), "p_value": None}
            continue
        statistic, p_value = stats.wilcoxon(made_values, other_values)
        result[metric] = {"n": len(made_values), "statistic": statistic, "p_value": p_value}
    return result


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python experiments/statistical_tests.py <results.csv>")
        return 1

    by_baseline = load_results(Path(sys.argv[1]))
    other_baselines = [b for b in by_baseline if b != "made"]

    for baseline in sorted(other_baselines):
        comparison = compare_baseline(by_baseline, baseline)
        print(f"\nmade vs {baseline}:")
        for metric in METRICS:
            m = comparison[metric]
            if m["p_value"] is None:
                print(f"  {metric}: n={m['n']} (not enough variation for test)")
            else:
                print(f"  {metric}: n={m['n']} p={m['p_value']:.4f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pytest tests/experiments/test_statistical_tests.py -v`
Expected: 4 passed

- [ ] **Step 11: Run the full test suite one final time**

Run: `pytest -v`
Expected: all tests pass (this plan's ~45 new tests plus the 27 from the v1 prototype, none making real network calls)

- [ ] **Step 12: Commit**

```bash
git add experiments/analyze_results.py experiments/statistical_tests.py pyproject.toml tests/experiments/test_analyze_results.py tests/experiments/test_statistical_tests.py
git commit -m "feat: add results analysis and paired statistical comparison (T22-T23)"
```

---

## Definition of Done

- `pytest -v` passes with no failures and makes zero real DeepSeek API calls.
- `opa test policies/hard -v` still passes (unaffected by this plan).
- `python experiments/generate_scenarios.py` produces `experiments/scenarios/v1.jsonl` with 120 scenarios.
- `python scripts/run_experiment.py --dataset-version v1` runs successfully against the real DeepSeek API (manual, deliberate, costs real money) and produces `experiments/results/v1.csv` with 5 baselines × 120 scenarios = 600 rows (minus any `status: "failed"` rows from transient API errors).
- `python experiments/analyze_results.py experiments/results/v1.csv` prints a per-baseline summary table.
- `python experiments/statistical_tests.py experiments/results/v1.csv` prints paired Wilcoxon p-values for `made` vs each of the 4 baselines on cost, quality, and latency.
- This completes T17-T23 in `docs/TASKS_MADE.md` (Fase 9-11), answering RQ3.
