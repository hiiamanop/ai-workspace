# MADE Context-Capacity Hard Constraint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MADE hard constraint that excludes any model candidate whose context window is smaller than a request's estimated token need, so MADE never routes a request to a model that will silently truncate it — replacing today's "AI returned no content" failure with a clear MADE-level exclusion.

**Architecture:** A new OPA/Rego hard-constraint file (`policies/hard/context.rego`) following the exact pattern of the existing `cost.rego`. Two new optional/defaulted fields — `CandidateIn.context_window_tokens` and `TaskIn.estimated_context_tokens` — flow from `ai-workspace`'s TypeScript request builders, through MADE's Pydantic schemas, into the OPA `input_doc`, and the Rego rule denies a candidate only when both fields are present and the estimate exceeds the window (fail-open otherwise). A new shared `src/token-estimate.ts` in `ai-workspace` computes the estimate from the actual system prompt, tool schemas, and message history, and both `src/chat.ts` and `src/agent-turn.ts` are wired to pass it. No changes to `core/modm/topsis.py`, `weighted_sum.py`, or `policies/epm.yaml`.

**Tech Stack:** MADE: Python 3.11, FastAPI, Pydantic v2, OPA (Rego), pytest. ai-workspace: Node.js, TypeScript (`node --test`), `tsx`.

## Global Constraints

- New Rego rule lives in `policies/hard/`, shared by both `epm.yaml` and `epm-critical.yaml` via their common `hard_dir` — no duplication needed for the critical-data path.
- The rule must fail open: a candidate or task missing either new field must never be denied by this rule. Both `context_window_tokens > 0` and `estimated_context_tokens > 0` guards are required before comparing.
- No changes to `core/modm/topsis.py`, `core/modm/weighted_sum.py`, or the objective weights in `policies/epm.yaml`.
- `OLLAMA_CANDIDATE.context_window_tokens` is read from a new env var `OLLAMA_CONTEXT_WINDOW` (parsed as an integer; falls back to `4096` if unset). It is not auto-detected from Ollama at runtime.
- `DEEPSEEK_CANDIDATE.context_window_tokens = 1_000_000` (DeepSeek's documented context window).
- `estimateContextTokens()` uses a chars/4 heuristic plus a fixed response-headroom buffer of `1000` tokens — not a real tokenizer. This is a feasibility gate, not precise accounting.
- `WEB_SEARCH_CANDIDATE`/`SCRAPE_CANDIDATE` (both `kind: "tool"`) get no `context_window_tokens` field — the Rego rule's `kind == "model"` guard means it's never evaluated for them.

---

### Task 1: MADE — `context.rego` hard constraint + schema fields

**Files:**
- Create: `MADE/policies/hard/context.rego`
- Create: `MADE/policies/hard/context_test.rego`
- Modify: `MADE/api/schemas.py:6-8` (`TaskIn`), `MADE/api/schemas.py:16-21` (`CandidateIn`)
- Modify: `MADE/core/decision/engine.py:13-15` (`Task`), `MADE/core/decision/engine.py:23-28` (`DecisionCandidate`), `MADE/core/decision/engine.py:61-71` (`decide()`'s `input_doc` candidate dict)
- Modify: `MADE/api/main.py:64` (`Task(...)` construction), `MADE/api/main.py:66-71` (`DecisionCandidate(...)` list comprehension)
- Modify: `MADE/tests/api/test_decide.py` (new integration test)

**Interfaces:**
- Produces: `TaskIn.estimated_context_tokens: int = 0`, `Task.estimated_context_tokens: int = 0`, `CandidateIn.context_window_tokens: int | None = None`, `DecisionCandidate.context_window_tokens: int | None = None` — Task 2 (ai-workspace TypeScript) sends these two fields by name over HTTP to `POST /decide`.

- [ ] **Step 1: Write the failing Rego tests**

Create `MADE/policies/hard/context_test.rego`:

```rego
package made.hard

test_deny_candidate_context_too_small {
	deny["context: candidate 'gemma4:12b' window 4096 tokens < required 9000"] with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 9000},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 4096},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_candidate_context_fits {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 2000},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 4096},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_candidate_when_fields_missing {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 0},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
```

- [ ] **Step 2: Run the Rego tests to verify they fail**

Run (from `MADE/`): `opa test policies/hard -v`
Expected: `test_deny_candidate_context_too_small` FAILS (no rule produces that deny message yet). The other two tests pass trivially since no existing rule denies on these inputs — that's fine, they're asserting the *absence* of a denial the not-yet-written rule will also not cause.

- [ ] **Step 3: Write `context.rego`**

Create `MADE/policies/hard/context.rego`:

```rego
package made.hard

deny[reason] {
	input.candidate.kind == "model"
	input.candidate.context_window_tokens > 0
	input.task.estimated_context_tokens > 0
	input.task.estimated_context_tokens > input.candidate.context_window_tokens
	reason := sprintf(
		"context: candidate '%s' window %v tokens < required %v",
		[input.candidate.id, input.candidate.context_window_tokens, input.task.estimated_context_tokens],
	)
}
```

- [ ] **Step 4: Run the Rego tests to verify they pass**

Run (from `MADE/`): `opa test policies/hard -v`
Expected: all tests in `policies/hard/` PASS, including the three new ones and every pre-existing test (`cost_test.rego`, `compliance_test.rego`, `privacy_test.rego`, `security_test.rego`, `approval_test.rego`, `base_test.rego`).

- [ ] **Step 5: Add the two schema fields**

In `MADE/api/schemas.py`, change `TaskIn` (currently lines 6-8):

```python
class TaskIn(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
```

In the same file, change `CandidateIn` (currently lines 16-21):

```python
class CandidateIn(BaseModel):
    id: str
    vendor: str
    kind: Literal["model", "tool"]
    cost_per_1k_tokens: float
    scores: dict[str, float]
    context_window_tokens: int | None = None
```

In `MADE/core/decision/engine.py`, change `Task` (currently lines 13-15):

```python
class Task(BaseModel):
    type: str
    data_classification: Literal["public", "internal", "confidential", "restricted"]
    estimated_context_tokens: int = 0
```

In the same file, change `DecisionCandidate` (currently lines 23-28):

```python
class DecisionCandidate(BaseModel):
    id: str
    vendor: str
    kind: Literal["model", "tool"]  # "model" | "tool"
    cost_per_1k_tokens: float
    scores: dict[str, float]
    context_window_tokens: int | None = None
```

In the same file, inside `decide()`, change the `input_doc` candidate dict (currently lines 64-69) to include the new field:

```python
        input_doc = {
            "task": task.model_dump(),
            "candidate": {
                "kind": candidate.kind,
                "id": candidate.id,
                "vendor": candidate.vendor,
                "cost_per_1k_tokens": candidate.cost_per_1k_tokens,
                "context_window_tokens": candidate.context_window_tokens,
            },
            "org": org.model_dump(),
        }
```

`task.model_dump()` already serializes every field on `Task`, so `estimated_context_tokens` flows through automatically once added to the model — no separate change needed there.

In `MADE/api/main.py`, change the `Task(...)` construction (currently line 64):

```python
    task = Task(
        type=request.task.type,
        data_classification=request.task.data_classification,
        estimated_context_tokens=request.task.estimated_context_tokens,
    )
```

In the same file, change the `DecisionCandidate(...)` list comprehension (currently lines 66-71):

```python
    candidates = [
        DecisionCandidate(
            id=c.id, vendor=c.vendor, kind=c.kind,
            cost_per_1k_tokens=c.cost_per_1k_tokens, scores=c.scores,
            context_window_tokens=c.context_window_tokens,
        )
        for c in request.candidates
    ]
```

- [ ] **Step 6: Write the failing integration test**

In `MADE/tests/api/test_decide.py`, add a new test at the end of the file:

```python
def test_decide_excludes_candidate_with_insufficient_context_window(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post("/decide", json={
        "task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 9000},
        "decision_kind": "model_selection",
        "candidates": [
            {
                "id": "gemma4:12b", "vendor": "ollama-local", "kind": "model", "cost_per_1k_tokens": 0.0,
                "scores": {"cost": 0.0, "quality": 0.75, "latency": 9000, "business_risk": 0.1},
                "context_window_tokens": 4096,
            },
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["selected_candidate_id"] is None
    assert len(body["excluded"]) == 1
    assert "context:" in body["excluded"][0]["reason"]
```

- [ ] **Step 7: Run the Python tests to verify the new test fails, then passes**

Run (from `MADE/`): `pytest tests/api/test_decide.py -v`
Expected before Step 5's edits are in place: this step is really a checkpoint — since Steps 3-5 already implemented the rule and schema fields together, run this now and expect all tests in the file to PASS, including the new one.

Run the full MADE suite to confirm nothing else broke: `pytest -v` (from `MADE/`)
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
cd MADE
git add policies/hard/context.rego policies/hard/context_test.rego api/schemas.py core/decision/engine.py api/main.py tests/api/test_decide.py
git commit -m "feat: add context-capacity hard constraint to MADE"
```

---

### Task 2: ai-workspace — `context_window_tokens` on candidates

**Files:**
- Modify: `src/types.ts:1-4` (`TaskIn` interface), `src/types.ts:11-17` (`CandidateIn` interface)
- Modify: `src/candidates.ts` (whole file — restructure `OLLAMA_CANDIDATE` into a function of `env`, add `context_window_tokens` to both `OLLAMA_CANDIDATE` and `DEEPSEEK_CANDIDATE`)
- Modify: `tests/candidates.test.ts` (new assertions)

**Interfaces:**
- Consumes: `CandidateIn` from `src/types.ts` (Task 1 partner shape — MADE's `CandidateIn.context_window_tokens` and `TaskIn.estimated_context_tokens`, same field names, already implemented in Task 1).
- Produces: `availableCandidates(env)` returns `CandidateIn[]` where the Ollama entry's `context_window_tokens` reflects `env.OLLAMA_CONTEXT_WINDOW` (parsed int, default `4096`), and the DeepSeek entry's is always `1_000_000` — Task 4 relies on these values being present when it reads `selected.context_window_tokens` is NOT needed by Task 4 (Task 4 only sets `task.estimated_context_tokens`; MADE does the comparison), but Task 4's tests do rely on `availableCandidates()` continuing to return valid `CandidateIn[]` shapes.

- [ ] **Step 1: Write the failing tests**

Add to `tests/candidates.test.ts` (after the existing tests):

```typescript
test("availableCandidates() sets the Ollama candidate's context_window_tokens from OLLAMA_CONTEXT_WINDOW, defaulting to 4096", () => {
  const withDefault = availableCandidates({});
  const ollamaDefault = withDefault.find((c) => c.id === "gemma4:12b");
  assert.equal(ollamaDefault?.context_window_tokens, 4096);

  const withOverride = availableCandidates({ OLLAMA_CONTEXT_WINDOW: "16384" });
  const ollamaOverride = withOverride.find((c) => c.id === "gemma4:12b");
  assert.equal(ollamaOverride?.context_window_tokens, 16384);
});

test("availableCandidates() sets the DeepSeek candidate's context_window_tokens to 1,000,000", () => {
  const candidates = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  const deepseek = candidates.find((c) => c.id === "deepseek-v4-flash");
  assert.equal(deepseek?.context_window_tokens, 1_000_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/candidates.test.ts`
Expected: FAIL — `context_window_tokens` is `undefined`, not `4096`/`16384`/`1000000`.

- [ ] **Step 3: Add the field to `CandidateIn` and `TaskIn` in `src/types.ts`**

Change `TaskIn` (currently lines 1-4):

```typescript
export interface TaskIn {
  type: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
  estimated_context_tokens?: number;
}
```

Change `CandidateIn` (currently lines 11-17):

```typescript
export interface CandidateIn {
  id: string;
  vendor: string;
  kind: "model" | "tool";
  cost_per_1k_tokens: number;
  scores: Record<string, number>;
  context_window_tokens?: number;
}
```

- [ ] **Step 4: Rewrite `src/candidates.ts`**

Replace the whole file:

```typescript
import type { CandidateIn } from "./types.ts";

// ponytail: static score estimates (cost/quality/latency/business_risk),
// not measured from real usage yet. Replace with a live score-cache
// (like MADE's own score_cache) once this app has real traffic to learn from.

function ollamaCandidate(env: NodeJS.ProcessEnv): CandidateIn {
  return {
    id: "gemma4:12b",
    vendor: "ollama-local",
    kind: "model",
    cost_per_1k_tokens: 0,
    scores: { cost: 0, quality: 0.75, latency: 9000, business_risk: 0.1 },
    context_window_tokens: Number(env.OLLAMA_CONTEXT_WINDOW ?? 4096),
  };
}

const DEEPSEEK_CANDIDATE: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: { cost: 0.001, quality: 0.9, latency: 15000, business_risk: 0.25 },
  context_window_tokens: 1_000_000,
};

const WEB_SEARCH_CANDIDATE: CandidateIn = {
  id: "web_search",
  vendor: "mcp-searxng",
  kind: "tool",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.7, latency: 3000, business_risk: 0.2 },
};

const SCRAPE_CANDIDATE: CandidateIn = {
  id: "scrape",
  vendor: "scrapling",
  kind: "tool",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.7, latency: 6000, business_risk: 0.3 },
};

export function availableCandidates(env: NodeJS.ProcessEnv = process.env): CandidateIn[] {
  const candidates = [ollamaCandidate(env)];
  if (env.DEEPSEEK_API_KEY) {
    candidates.push(DEEPSEEK_CANDIDATE);
  }
  return candidates;
}

export function availableToolCandidates(): CandidateIn[] {
  return [WEB_SEARCH_CANDIDATE, SCRAPE_CANDIDATE];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/candidates.test.ts`
Expected: PASS, including the two new tests and all pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/candidates.ts tests/candidates.test.ts
git commit -m "feat: add context_window_tokens to MADE candidates"
```

---

### Task 3: ai-workspace — `estimateContextTokens()`

**Files:**
- Create: `src/token-estimate.ts`
- Create: `tests/token-estimate.test.ts`

**Interfaces:**
- Produces: `estimateContextTokens(system: string, tools: unknown[], messages: unknown[]): number` — Task 4 imports this and passes its result as `task.estimated_context_tokens` when building `DecideRequest`s in `src/chat.ts` and `src/agent-turn.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/token-estimate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateContextTokens } from "../src/token-estimate.ts";

test("estimateContextTokens() grows with system prompt length", () => {
  const short = estimateContextTokens("hi", [], []);
  const long = estimateContextTokens("hi".repeat(1000), [], []);
  assert.ok(long > short);
});

test("estimateContextTokens() counts tool schema and message content", () => {
  const withoutExtras = estimateContextTokens("", [], []);
  const withExtras = estimateContextTokens(
    "",
    [{ type: "function", function: { name: "insert_content", description: "x".repeat(500), parameters: {} } }],
    [{ role: "user", content: "y".repeat(500) }]
  );
  assert.ok(withExtras > withoutExtras);
});

test("estimateContextTokens() always includes at least the response headroom buffer", () => {
  assert.equal(estimateContextTokens("", [], []), 1000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/token-estimate.test.ts`
Expected: FAIL with a module-not-found error (`src/token-estimate.ts` doesn't exist yet).

- [ ] **Step 3: Write `src/token-estimate.ts`**

```typescript
const CHARS_PER_TOKEN = 4;
const RESPONSE_TOKEN_BUFFER = 1000;

export function estimateContextTokens(system: string, tools: unknown[], messages: unknown[]): number {
  const charCount = system.length + JSON.stringify(tools).length + JSON.stringify(messages).length;
  return Math.ceil(charCount / CHARS_PER_TOKEN) + RESPONSE_TOKEN_BUFFER;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/token-estimate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/token-estimate.ts tests/token-estimate.test.ts
git commit -m "feat: add estimateContextTokens() token-estimation heuristic"
```

---

### Task 4: ai-workspace — wire `estimateContextTokens()` into `chat.ts` and `agent-turn.ts`

**Files:**
- Modify: `src/chat.ts:37-45` (`decideRequest()`), `src/chat.ts:63-95` (call sites in `handleChat()`)
- Modify: `src/agent-turn.ts:118-126` (`decideRequest()`), `src/agent-turn.ts:128-130` (call site in `handleAgentTurn()`)
- Modify: `tests/chat.test.ts` (assert non-zero `estimated_context_tokens`)
- Modify: `tests/agent-turn.test.ts` (assert non-zero `estimated_context_tokens`)

**Interfaces:**
- Consumes: `estimateContextTokens(system, tools, messages)` from `src/token-estimate.ts` (Task 3). `TOOL_DEFS` from `src/tools.ts` (existing, unchanged).

- [ ] **Step 1: Write the failing test for `chat.ts`**

In `tests/chat.test.ts`, find the `baseDeps` object and the first test (`"handleChat() skips tool wiring entirely when MADE allows no tools"`). Change that test's `decide` mock to also capture the request's `task.estimated_context_tokens`, and add an assertion after the existing `assert.deepEqual(decideCalls, ...)` line:

```typescript
test("handleChat() skips tool wiring entirely when MADE allows no tools", async () => {
  const decideCalls: string[] = [];
  const estimatedTokensSeen: number[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => {
      decideCalls.push(request.decision_kind);
      estimatedTokensSeen.push(request.task.estimated_context_tokens ?? 0);
      return request.decision_kind === "model_selection" ? modelDecision : noToolsDecision();
    },
    completeByProvider: {
      "ollama-local": async (_model, messages, tools) => {
        assert.deepEqual(tools, []);
        return { content: `echo: ${messages[0].content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {},
  };

  const result = await handleChat("hello there", deps);

  assert.deepEqual(decideCalls, ["model_selection", "tool_selection"]);
  assert.ok(estimatedTokensSeen.every((n) => n > 0));
  assert.equal(result.selectedCandidateId, "gemma4-12b");
```

(Leave the rest of the test body — the lines after `result.selectedCandidateId` — exactly as they already are; only the mock and the new assertion line are added.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: FAIL — `request.task.estimated_context_tokens` is `undefined`, so `estimatedTokensSeen` is `[0, 0]` and `every((n) => n > 0)` is `false`.

- [ ] **Step 3: Wire `estimateContextTokens()` into `src/chat.ts`**

Add the import at the top of `src/chat.ts` (after the existing `TOOL_DEFS` import on line 7):

```typescript
import { estimateContextTokens } from "./token-estimate.ts";
```

Change `decideRequest()` (currently lines 37-45) to accept the messages it should estimate from:

```typescript
function decideRequest(
  decisionKind: DecideRequest["decision_kind"],
  candidates: CandidateIn[],
  messages: ChatMessage[]
): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimateContextTokens("", Object.values(TOOL_DEFS), messages),
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: decisionKind,
    candidates,
    policy_set: "default",
  };
}
```

Change the two call sites inside `handleChat()`. The function currently builds `messages` (line 95) after both `decide()` calls (lines 65 and 85) — move the `messages` declaration up so both call sites can pass it. Replace lines 59-95 of `src/chat.ts` with:

```typescript
export async function handleChat(
  message: string,
  deps: ChatDeps = defaultDeps
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const candidates = deps.availableCandidates();
  const messages: ChatMessage[] = [{ role: "user", content: message }];

  const modelDecision = await deps.decide(decideRequest("model_selection", candidates, messages));

  if (!modelDecision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }
  if (modelDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  const selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${modelDecision.selected_candidate_id}`);
  }

  const complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }

  const toolCandidates = deps.availableToolCandidates();
  const toolDecision = await deps.decide(decideRequest("tool_selection", toolCandidates, messages));
  if (toolDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }
  const allowedToolIds = new Set(toolDecision.ranking.map((r) => r.id));
  const tools: ToolDef[] = toolCandidates
    .filter((c) => allowedToolIds.has(c.id))
    .map((c) => TOOL_DEFS[c.id])
    .filter((t): t is ToolDef => Boolean(t));

  const toolsUsed: string[] = [];
  let lastNonEmptyContent: string | null = null;
```

The rest of `handleChat()` (the `for` loop starting at what was line 99, through the end of the function) is unchanged — it already refers to `messages`, `tools`, `toolsUsed`, and `lastNonEmptyContent`, all still in scope.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: PASS, including the modified test and all other pre-existing tests in the file (they don't inspect `task.estimated_context_tokens`, so they're unaffected by the new field being populated).

- [ ] **Step 5: Write the failing test for `agent-turn.ts`**

In `tests/agent-turn.test.ts`, find the first test (`"handleAgentTurn() returns final text when the model calls no tools"`). Change its `decide` mock (in `baseDeps` it's currently `async () => modelDecision`) to capture the estimate, by overriding `decide` for this one test:

```typescript
test("handleAgentTurn() returns final text when the model calls no tools", async () => {
  let estimatedTokensSeen = 0;
  const deps: AgentTurnDeps = {
    ...baseDeps,
    decide: async (request) => {
      estimatedTokensSeen = request.task.estimated_context_tokens ?? 0;
      return modelDecision;
    },
    completeByProvider: {
      "ollama-local": async (_model, messages, tools) => {
        assert.equal(messages[0].role, "system");
        assert.deepEqual(
          tools.map((t) => t.function.name).sort(),
          ["insert_content", "scrape", "web_search"]
        );
        return { content: "hi there", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.ok(estimatedTokensSeen > 0);
  assert.deepEqual(result, { type: "text", text: "hi there" });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: FAIL — `estimatedTokensSeen` is `0`.

- [ ] **Step 7: Wire `estimateContextTokens()` into `src/agent-turn.ts`**

Add the import at the top of `src/agent-turn.ts` (after the existing `TOOL_DEFS` import on line 7):

```typescript
import { estimateContextTokens } from "./token-estimate.ts";
```

Change `decideRequest()` (currently lines 118-126) to take the request being estimated:

```typescript
function decideRequest(candidates: CandidateIn[], request: AgentTurnRequest): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimateContextTokens(request.system, request.tools, request.messages),
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  };
}
```

Change the call site inside `handleAgentTurn()` (currently line 130):

```typescript
  const modelDecision = await deps.decide(decideRequest(candidates, request));
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: PASS, including the modified test and all other pre-existing tests in the file.

- [ ] **Step 9: Run the full ai-workspace test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/chat.ts src/agent-turn.ts tests/chat.test.ts tests/agent-turn.test.ts
git commit -m "feat: wire estimateContextTokens() into chat and agent-turn MADE requests"
```

---

## Post-plan verification (manual, not a task)

After all four tasks are merged and the Docker stack is rebuilt (`docker compose up --build made app`), the original failure scenario (multi-turn "search the web and write an article" request that previously exhausted Ollama's 8192-token `OLLAMA_CONTEXT_LENGTH`) should now either succeed (if the estimate fits) or fail fast with `"MADE returned no eligible candidate"` instead of a silent empty response — assuming `OLLAMA_CONTEXT_WINDOW` is set to match whatever `OLLAMA_CONTEXT_LENGTH` Ollama is actually running with. This plan does not include setting that env var in `.env`/`docker-compose.yaml`; do it manually to match the currently running Ollama instance (`OLLAMA_CONTEXT_LENGTH=8192` per the last confirmed restart).
