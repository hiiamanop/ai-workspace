# Context-Guard (Mid-Loop Context-Capacity Re-Check) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `chat.ts`'s and `agent-turn.ts`'s internal tool-calling loops from silently exceeding the context window of the model MADE originally selected, by re-checking capacity before every loop iteration and asking MADE for a better-fitting candidate when needed.

**Architecture:** One new shared module, `src/context-guard.ts`, exporting `ensureCandidateFits()` — given the currently-selected candidate, the full candidate list, a fresh token estimate, and MADE's `decide` function, it returns `"ok"` (no action), `"switched"` (a new candidate to use), or `"exhausted"` (nothing fits). Both `handleChat()` and `handleAgentTurn()` call it immediately before every `complete()` call inside their loops.

**Tech Stack:** Node.js, TypeScript (`node --test`), `tsx`.

## Global Constraints

- The capacity check runs before every loop iteration, including the first — no special-casing for iteration 0.
- When `current.context_window_tokens` is unset, or the fresh estimate still fits, `ensureCandidateFits()` returns `"ok"` **without calling `decide()`** — this must stay the zero-overhead path for the common case.
- On `"exhausted"`: if a partial answer already exists, return it with the marker `[context window exhausted — response may be incomplete]` appended. If no partial answer exists yet, throw `new Error("MADE returned no eligible candidate")` — reuse this exact existing message, do not invent new copy.
- On `"switched"`: if the new candidate's vendor has no registered provider client, throw `` new Error(`no provider client registered for vendor ${vendor}`) `` — reuse this exact existing message pattern.
- No changes to `src/token-estimate.ts`'s heuristic itself, `MADE/`, streaming, or conversation-history management — all out of scope for this plan.

---

### Task 1: `src/context-guard.ts`

**Files:**
- Create: `src/context-guard.ts`
- Create: `tests/context-guard.test.ts`

**Interfaces:**
- Produces: `CapacityCheckResult` (a discriminated union) and `ensureCandidateFits(current: CandidateIn, candidates: CandidateIn[], estimatedTokens: number, decide: (request: DecideRequest) => Promise<DecideResponse>): Promise<CapacityCheckResult>` — Tasks 2 and 3 both import and call this directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/context-guard.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureCandidateFits } from "../src/context-guard.ts";
import type { CandidateIn, DecideResponse } from "../src/types.ts";

const ollama: CandidateIn = {
  id: "gemma4-12b",
  vendor: "ollama-local",
  kind: "model",
  cost_per_1k_tokens: 0,
  scores: {},
  context_window_tokens: 4096,
};

const deepseek: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: {},
  context_window_tokens: 1_000_000,
};

const candidates = [ollama, deepseek];

function decision(overrides: Partial<DecideResponse>): DecideResponse {
  return {
    decision_id: "d1",
    selected_candidate_id: null,
    requires_human_approval: false,
    ranking: [],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
    ...overrides,
  };
}

test("ensureCandidateFits() returns ok without calling decide() when the estimate fits", async () => {
  let decideCalls = 0;
  const result = await ensureCandidateFits(ollama, candidates, 2000, async () => {
    decideCalls += 1;
    return decision({});
  });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(decideCalls, 0);
});

test("ensureCandidateFits() returns ok when the candidate has no context_window_tokens", async () => {
  const noWindow: CandidateIn = { ...ollama, context_window_tokens: undefined };
  let decideCalls = 0;
  const result = await ensureCandidateFits(noWindow, candidates, 999_999, async () => {
    decideCalls += 1;
    return decision({});
  });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(decideCalls, 0);
});

test("ensureCandidateFits() returns switched with the new candidate when decide() finds a better fit", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, async (request) => {
    assert.equal(request.task.estimated_context_tokens, 9000);
    assert.equal(request.decision_kind, "model_selection");
    return decision({ selected_candidate_id: "deepseek-v4-flash" });
  });

  assert.deepEqual(result, { status: "switched", candidate: deepseek });
});

test("ensureCandidateFits() returns exhausted when decide() finds no eligible candidate", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, async () =>
    decision({ selected_candidate_id: null })
  );

  assert.deepEqual(result, { status: "exhausted" });
});

test("ensureCandidateFits() returns exhausted when decide() requires human approval", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, async () =>
    decision({ selected_candidate_id: "deepseek-v4-flash", requires_human_approval: true })
  );

  assert.deepEqual(result, { status: "exhausted" });
});

test("ensureCandidateFits() returns exhausted when decide() selects a candidate id not in the list", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, async () =>
    decision({ selected_candidate_id: "unknown-model" })
  );

  assert.deepEqual(result, { status: "exhausted" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/context-guard.test.ts`
Expected: FAIL with a module-not-found error (`src/context-guard.ts` doesn't exist yet).

- [ ] **Step 3: Write `src/context-guard.ts`**

```typescript
import type { CandidateIn, DecideRequest, DecideResponse } from "./types.ts";

export type CapacityCheckResult =
  | { status: "ok" }
  | { status: "switched"; candidate: CandidateIn }
  | { status: "exhausted" };

export async function ensureCandidateFits(
  current: CandidateIn,
  candidates: CandidateIn[],
  estimatedTokens: number,
  decide: (request: DecideRequest) => Promise<DecideResponse>
): Promise<CapacityCheckResult> {
  if (!current.context_window_tokens || estimatedTokens <= current.context_window_tokens) {
    return { status: "ok" };
  }

  const decision = await decide({
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimatedTokens,
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  });

  if (!decision.selected_candidate_id || decision.requires_human_approval) {
    return { status: "exhausted" };
  }

  const next = candidates.find((c) => c.id === decision.selected_candidate_id);
  if (!next) {
    return { status: "exhausted" };
  }

  return { status: "switched", candidate: next };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/context-guard.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context-guard.ts tests/context-guard.test.ts
git commit -m "feat: add ensureCandidateFits() mid-loop context-capacity guard"
```

---

### Task 2: Wire `context-guard` into `src/chat.ts`

**Files:**
- Modify: `src/chat.ts` (add import; `const selected`/`const complete` become `let`; loop body gains a capacity check before each `complete()` call)
- Modify: `tests/chat.test.ts` (two new tests)

**Interfaces:**
- Consumes: `ensureCandidateFits()` from `src/context-guard.ts` (Task 1).

- [ ] **Step 1: Write the failing tests**

The exact token-estimate values used below were computed by actually running `estimateContextTokens()` against these exact message shapes — they are not approximations. Add these two tests to `tests/chat.test.ts`, after the existing `"handleChat() throws when MADE requires human approval for tool_selection"` test:

```typescript
test("handleChat() switches to a different candidate mid-loop when the estimate exceeds the current candidate's window", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1200,
  };
  const bigDeepseek = {
    id: "deepseek-v4-flash", vendor: "deepseek", kind: "model" as const,
    cost_per_1k_tokens: 0.001, scores: {}, context_window_tokens: 1_000_000,
  };
  const candidates = [smallOllama, bigDeepseek];

  let modelDecideCalls = 0;
  const deps: ChatDeps = {
    availableCandidates: () => candidates,
    availableToolCandidates: baseDeps.availableToolCandidates,
    decide: async (request) => {
      if (request.decision_kind === "tool_selection") return allowAllToolsDecision();
      modelDecideCalls += 1;
      if (modelDecideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: "deepseek-v4-flash" };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async (_model, messages) => {
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `answered by deepseek using: ${toolMessage?.content}`, toolCalls: [] };
      },
    },
    toolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleChat("search something", deps);

  // iteration 0 estimate for this exact message/tool shape is 1115 (fits 1200, no switch yet);
  // after the first tool round-trip, iteration 1's estimate is 1417 (exceeds 1200, triggers the switch).
  assert.equal(modelDecideCalls, 2);
  assert.equal(result.selectedCandidateId, "deepseek-v4-flash");
  assert.match(result.reply, /^answered by deepseek using:/);
});

test("handleChat() returns the last non-empty content with a note when MADE finds no candidate that fits mid-loop", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1200,
  };
  const candidates = [smallOllama];

  let modelDecideCalls = 0;
  const deps: ChatDeps = {
    availableCandidates: () => candidates,
    availableToolCandidates: baseDeps.availableToolCandidates,
    decide: async (request) => {
      if (request.decision_kind === "tool_selection") return allowAllToolsDecision();
      modelDecideCalls += 1;
      if (modelDecideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: null };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial thought",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
    },
    toolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleChat("search something", deps);

  assert.equal(result.reply, "partial thought\n\n[context window exhausted — response may be incomplete]");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: FAIL — both new tests fail because `handleChat()` never re-checks capacity mid-loop yet (`modelDecideCalls` stays `1`, no switch/exhausted behavior occurs).

- [ ] **Step 3: Wire `ensureCandidateFits()` into `src/chat.ts`**

Add the import at the top of `src/chat.ts` (after the existing `estimateContextTokens` import):

```typescript
import { ensureCandidateFits } from "./context-guard.ts";
```

Change the candidate/provider selection from `const` to `let` (find these two lines and change `const` to `let`):

```typescript
  let selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
```

and:

```typescript
  let complete = deps.completeByProvider[selected.vendor];
```

Replace the `for` loop body (from `for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {` through its closing `}`) with:

```typescript
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", Object.values(TOOL_DEFS), messages);
    const capacity = await ensureCandidateFits(selected, candidates, currentEstimate, deps.decide);

    if (capacity.status === "exhausted") {
      if (lastNonEmptyContent) {
        return {
          selectedCandidateId: selected.id,
          reply: `${lastNonEmptyContent}\n\n[context window exhausted — response may be incomplete]`,
          toolsUsed,
        };
      }
      throw new Error("MADE returned no eligible candidate");
    }

    if (capacity.status === "switched") {
      selected = capacity.candidate;
      const nextComplete = deps.completeByProvider[selected.vendor];
      if (!nextComplete) {
        throw new Error(`no provider client registered for vendor ${selected.vendor}`);
      }
      complete = nextComplete;
    }

    const result = await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyContent = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { selectedCandidateId: selected.id, reply: result.content ?? "", toolsUsed };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      const executor = deps.toolExecutors[call.function.name];
      let toolResult: string;
      if (!executor) {
        toolResult = `tool ${call.function.name} is not available`;
      } else {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          toolResult = await executor(args);
          toolsUsed.push(call.function.name);
        } catch (err) {
          toolResult = `${call.function.name} failed: ${(err as Error).message}`;
        }
      }
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }
```

Everything after the loop (the `lastNonEmptyContent`-based fallback for the iteration-cap case, and the final throw) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: PASS, including both new tests and every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: re-check context capacity before every chat.ts tool-loop iteration"
```

---

### Task 3: Wire `context-guard` into `src/agent-turn.ts`

**Files:**
- Modify: `src/agent-turn.ts` (add import; `const selected`/`const complete` become `let`; add a `lastNonEmptyText` tracker; loop body gains a capacity check before each `complete()` call)
- Modify: `tests/agent-turn.test.ts` (two new tests)

**Interfaces:**
- Consumes: `ensureCandidateFits()` from `src/context-guard.ts` (Task 1).

- [ ] **Step 1: Write the failing tests**

The exact token-estimate values below were computed by actually running `estimateContextTokens()` against these exact message shapes. Add these two tests to `tests/agent-turn.test.ts`, after the existing `"handleAgentTurn() does not add a duplicate tool def..."` test:

```typescript
test("handleAgentTurn() switches to a different candidate mid-loop when the estimate exceeds the current candidate's window", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1300,
  };
  const bigDeepseek = {
    id: "deepseek-v4-flash", vendor: "deepseek", kind: "model" as const,
    cost_per_1k_tokens: 0.001, scores: {}, context_window_tokens: 1_000_000,
  };
  const candidates = [smallOllama, bigDeepseek];

  let decideCalls = 0;
  const deps: AgentTurnDeps = {
    availableCandidates: () => candidates,
    decide: async () => {
      decideCalls += 1;
      if (decideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: "deepseek-v4-flash" };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
        ],
      }),
      deepseek: async (_model, messages) => {
        const toolMsg = messages.find((m) => m.role === "tool");
        return { content: `answered by deepseek using: ${toolMsg?.content}`, toolCalls: [] };
      },
    },
    serverToolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  // iteration 0 estimate for baseRequest's exact shape is 1156 (fits 1300, no switch yet);
  // after the first server-tool round-trip, iteration 1's estimate is 1458 (exceeds 1300, triggers the switch).
  assert.equal(decideCalls, 2);
  assert.deepEqual(result, { type: "text", text: `answered by deepseek using: ${"x".repeat(1000)}` });
});

test("handleAgentTurn() returns the last non-empty text with a note when MADE finds no candidate that fits mid-loop", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1300,
  };
  const candidates = [smallOllama];

  let decideCalls = 0;
  const deps: AgentTurnDeps = {
    availableCandidates: () => candidates,
    decide: async () => {
      decideCalls += 1;
      if (decideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: null };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial answer",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
        ],
      }),
    },
    serverToolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, {
    type: "text",
    text: "partial answer\n\n[context window exhausted — response may be incomplete]",
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: FAIL — both new tests fail because `handleAgentTurn()` never re-checks capacity mid-loop yet.

- [ ] **Step 3: Wire `ensureCandidateFits()` into `src/agent-turn.ts`**

Add the import at the top of `src/agent-turn.ts` (after the existing `estimateContextTokens` import):

```typescript
import { ensureCandidateFits } from "./context-guard.ts";
```

Change the candidate/provider selection from `const` to `let`:

```typescript
  let selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
```

and:

```typescript
  let complete = deps.completeByProvider[selected.vendor];
```

Replace the `for` loop (from `for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {` through its closing `}`, and add a `lastNonEmptyText` tracker declared right before it) with:

```typescript
  let lastNonEmptyText: string | null = null;

  for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", tools, messages);
    const capacity = await ensureCandidateFits(selected, candidates, currentEstimate, deps.decide);

    if (capacity.status === "exhausted") {
      if (lastNonEmptyText) {
        return { type: "text", text: `${lastNonEmptyText}\n\n[context window exhausted — response may be incomplete]` };
      }
      throw new Error("MADE returned no eligible candidate");
    }

    if (capacity.status === "switched") {
      selected = capacity.candidate;
      const nextComplete = deps.completeByProvider[selected.vendor];
      if (!nextComplete) {
        throw new Error(`no provider client registered for vendor ${selected.vendor}`);
      }
      complete = nextComplete;
    }

    const result = await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyText = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { type: "text", text: result.content ?? "" };
    }

    const hasClientCall = result.toolCalls.some((c) => !SERVER_TOOL_NAMES.has(c.function.name));
    if (hasClientCall) {
      return {
        type: "tool_calls",
        calls: result.toolCalls.map((c) => ({
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments) as Record<string, unknown>,
        })),
        text: result.content || undefined,
      };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const executor = deps.serverToolExecutors[call.function.name];
      let toolResult: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        toolResult = executor ? await executor(args) : `tool ${call.function.name} is not available`;
      } catch (err) {
        toolResult = `${call.function.name} failed: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }
```

The final line after the loop (`throw new Error("agent-turn tool loop exceeded maximum iterations");`) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: PASS, including both new tests and every pre-existing test in the file.

- [ ] **Step 5: Run the full ai-workspace test suite**

Run: `npm test`
Expected: all tests PASS (61 total: 51 pre-existing + 6 new from Task 1's `context-guard.test.ts` + 2 new in `tests/chat.test.ts` from Task 2 + 2 new in `tests/agent-turn.test.ts` from this task).

- [ ] **Step 6: Commit**

```bash
git add src/agent-turn.ts tests/agent-turn.test.ts
git commit -m "feat: re-check context capacity before every agent-turn.ts tool-loop iteration"
```
