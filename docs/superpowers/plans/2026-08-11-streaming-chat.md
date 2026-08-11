# Streaming, Resumable, History-Aware Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both chat surfaces (`/api/chat` and GenOffice's AI panel) stream every turn (including tool-calling steps) over a persistent, resumable WebSocket connection, give `/api/chat` real multi-turn history with token-budget trimming, and add stop/typing-indicator/markdown/regenerate UX.

**Architecture:** A `ws`-based WebSocket layer on top of the existing `http.Server` in `src/server.ts`, fed by new `completeStream()` functions on both provider clients (SSE parsing, forwarding content and tool-call deltas live) and threaded through `handleChat()`/`handleAgentTurn()` via an optional `streamCallbacks` parameter. Server buffers every emitted event per `turnId` so a reconnecting client can resume. `/api/chat` gains a `messages: ChatMessage[]` history parameter (matching `handleAgentTurn()`'s existing shape) trimmed by a new mechanical `trimHistory()` before every model call.

**Tech Stack:** Node.js 22, TypeScript (`node --test`), `tsx`, `ws` (new dependency), `marked` + `dompurify` (new client dependencies), React 19.

## Global Constraints

- Streaming covers every loop iteration (tool-calling steps included), not just the final answer.
- A single provider response is either all-content or all-tool-calls, never mixed mid-stream — accepted assumption, not re-verified per API call.
- History trimming (`trimHistory()`) is mechanical (drop oldest whole messages), never LLM-based summarization.
- `HISTORY_BUDGET_TOKENS = 6000`.
- The existing non-streaming HTTP routes (`/api/chat`, `/api/agent-turn`) stay as a fallback; `handleChat`/`handleAgentTurn` behave identically to today when `streamCallbacks` is omitted.
- No database, no cross-reload persistence — history lives in browser state and a server-side per-turn buffer only.
- `context-guard`'s `ensureCandidateFits()` mid-loop check is unchanged by this plan — only the completion call inside each iteration becomes streaming.

---

### Task 1: `src/history-budget.ts`

**Files:**
- Create: `src/history-budget.ts`
- Create: `tests/history-budget.test.ts`

**Interfaces:**
- Produces: `trimHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[]` — Task 4 imports and calls this.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-budget.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimHistory } from "../src/history-budget.ts";
import { estimateContextTokens } from "../src/token-estimate.ts";
import type { ChatMessage } from "../src/types.ts";

test("trimHistory() returns history unchanged when it fits the budget", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const result = trimHistory(messages, 100_000);
  assert.deepEqual(result, messages);
});

test("trimHistory() drops the oldest whole messages until the remainder fits", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "x".repeat(4000) },
    { role: "assistant", content: "y".repeat(4000) },
    { role: "user", content: "recent question" },
  ];
  const budget = estimateContextTokens("", [], [messages[2]]) + 10;
  const result = trimHistory(messages, budget);

  assert.deepEqual(result, [messages[2]]);
});

test("trimHistory() keeps a single already-over-budget message rather than returning nothing", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(50_000) }];
  const result = trimHistory(messages, 10);
  assert.deepEqual(result, messages);
});

test("trimHistory() keeps the most recent messages when trimming, not the oldest", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "x".repeat(3000) },
    { role: "user", content: "second" },
    { role: "assistant", content: "y".repeat(3000) },
    { role: "user", content: "third, most recent" },
  ];
  const budget = estimateContextTokens("", [], messages.slice(-1)) + 10;
  const result = trimHistory(messages, budget);

  assert.deepEqual(result, [messages[4]]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/history-budget.test.ts`
Expected: FAIL with a module-not-found error (`src/history-budget.ts` doesn't exist yet).

- [ ] **Step 3: Write `src/history-budget.ts`**

```typescript
import { estimateContextTokens } from "./token-estimate.ts";
import type { ChatMessage } from "./types.ts";

export function trimHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  let start = 0;
  while (start < messages.length - 1) {
    const candidate = messages.slice(start);
    if (estimateContextTokens("", [], candidate) <= budgetTokens) {
      return candidate;
    }
    start += 1;
  }
  return messages.slice(start);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/history-budget.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/history-budget.ts tests/history-budget.test.ts
git commit -m "feat: add trimHistory() mechanical conversation-history budget trimmer"
```

---

### Task 2: `completeStream()` in `src/providers/ollama-client.ts`

**Files:**
- Modify: `src/providers/ollama-client.ts`
- Modify: `tests/providers/ollama-client.test.ts` (new tests only; existing tests for `complete()` untouched)

**Interfaces:**
- Produces: `completeStream(model, messages, tools, callbacks, signal?, baseUrl?, fetchImpl?): Promise<CompletionResult>` where `callbacks: { onDelta: (text: string) => void; onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void }` — Task 4 and Task 5 both import and call this (via `deps.completeStreamByProvider`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/providers/ollama-client.test.ts`:

```typescript
import { completeStream } from "../../src/providers/ollama-client.ts";

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("completeStream() forwards content deltas via onDelta as they arrive", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const deltas: string[] = [];
  const result = await completeStream(
    "gemma4:12b",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => { throw new Error("should not be called"); } },
    undefined,
    "http://ollama.test",
    fakeFetch
  );

  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(result, { content: "Hello", toolCalls: [] });
});

test("completeStream() reconstructs tool calls from delta fragments and calls onToolCallDelta per fragment", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: "" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const toolDeltas: { index: number; id?: string; name?: string; argsFragment?: string }[] = [];
  const result = await completeStream(
    "gemma4:12b",
    [{ role: "user", content: "search" }],
    [],
    { onDelta: () => { throw new Error("should not be called"); }, onToolCallDelta: (d) => toolDeltas.push(d) },
    undefined,
    "http://ollama.test",
    fakeFetch
  );

  assert.equal(toolDeltas.length, 3);
  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }],
  });
});

test("completeStream() rejects with AbortError when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const fakeFetch: typeof fetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return sseResponse([]);
  };

  await assert.rejects(
    () =>
      completeStream(
        "gemma4:12b",
        [{ role: "user", content: "hi" }],
        [],
        { onDelta: () => {}, onToolCallDelta: () => {} },
        controller.signal,
        "http://ollama.test",
        fakeFetch
      ),
    { name: "AbortError" }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/providers/ollama-client.test.ts`
Expected: FAIL — `completeStream` is not exported yet.

- [ ] **Step 3: Write `completeStream()` in `src/providers/ollama-client.ts`**

Add this export to the file, after the existing `complete()` function (do not modify `complete()`):

```typescript
export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
}

export async function completeStream(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error("Ollama API returned a streaming response with no body");
  }

  let content = "";
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;

      const parsed = JSON.parse(payload) as {
        choices: { delta: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      };
      const delta = parsed.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        callbacks.onDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
          callbacks.onToolCallDelta({ index: tc.index, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments });
        }
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } }));

  return { content, toolCalls };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/providers/ollama-client.test.ts`
Expected: PASS, including the 3 new tests and all pre-existing `complete()` tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/ollama-client.ts tests/providers/ollama-client.test.ts
git commit -m "feat: add completeStream() SSE streaming to the Ollama provider client"
```

---

### Task 3: `completeStream()` in `src/providers/deepseek-client.ts`

**Files:**
- Modify: `src/providers/deepseek-client.ts`
- Modify: `tests/providers/deepseek-client.test.ts` (new tests only)

**Interfaces:**
- Produces: `completeStream(model, messages, tools, callbacks, signal?, apiKey?, baseUrl?, fetchImpl?): Promise<CompletionResult>` — same `StreamCallbacks` shape as Task 2 (DeepSeek's client defines its own identical local copy of the interface, matching the existing pattern where `complete()` is duplicated per provider rather than shared).

- [ ] **Step 1: Write the failing tests**

Add to `tests/providers/deepseek-client.test.ts` (mirroring Task 2's ollama tests, adapted for the API-key parameter). First, read the existing file to match its current `sseResponse`-equivalent setup style if one already exists; if not, add this local helper at the top of the test file alongside the existing imports:

```typescript
import { completeStream } from "../../src/providers/deepseek-client.ts";

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("completeStream() forwards content deltas via onDelta as they arrive", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const deltas: string[] = [];
  const result = await completeStream(
    "deepseek-v4-flash",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => { throw new Error("should not be called"); } },
    undefined,
    "sk-test",
    "http://deepseek.test",
    fakeFetch
  );

  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(result, { content: "Hello", toolCalls: [] });
});

test("completeStream() reconstructs tool calls from delta fragments", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: "" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const result = await completeStream(
    "deepseek-v4-flash",
    [{ role: "user", content: "search" }],
    [],
    { onDelta: () => { throw new Error("should not be called"); }, onToolCallDelta: () => {} },
    undefined,
    "sk-test",
    "http://deepseek.test",
    fakeFetch
  );

  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"q":1}' } }],
  });
});

test("completeStream() throws when DEEPSEEK_API_KEY is not set and no apiKey argument given", async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(
      () =>
        completeStream(
          "deepseek-v4-flash",
          [{ role: "user", content: "hi" }],
          [],
          { onDelta: () => {}, onToolCallDelta: () => {} }
        ),
      /DEEPSEEK_API_KEY not set/
    );
  } finally {
    if (originalKey !== undefined) process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/providers/deepseek-client.test.ts`
Expected: FAIL — `completeStream` is not exported yet.

- [ ] **Step 3: Write `completeStream()` in `src/providers/deepseek-client.ts`**

Add this export after the existing `complete()` function (do not modify `complete()`). It reuses the exact same SSE-parsing body as `ollama-client.ts`'s `completeStream()` (Task 2) — this duplication mirrors the existing `complete()` duplication pattern between the two provider files, kept consistent rather than introducing a shared streaming-parser module:

```typescript
export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
}

export async function completeStream(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error("DeepSeek API returned a streaming response with no body");
  }

  let content = "";
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;

      const parsed = JSON.parse(payload) as {
        choices: { delta: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      };
      const delta = parsed.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        callbacks.onDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
          callbacks.onToolCallDelta({ index: tc.index, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments });
        }
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } }));

  return { content, toolCalls };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/providers/deepseek-client.test.ts`
Expected: PASS, including the 3 new tests and all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/deepseek-client.ts tests/providers/deepseek-client.test.ts
git commit -m "feat: add completeStream() SSE streaming to the DeepSeek provider client"
```

---

### Task 4: `src/chat.ts` — history-aware signature + `trimHistory` + `streamCallbacks`

**Files:**
- Modify: `src/chat.ts` (whole-file rewrite — see Step 3)
- Modify: `tests/chat.test.ts` (mechanical transform of all 13 existing `handleChat(...)` calls, plus 3 new tests)

**Interfaces:**
- Consumes: `trimHistory()` (Task 1), `completeStream()` from both provider clients (Tasks 2–3).
- Produces: `handleChat(history: ChatMessage[], deps?: ChatDeps, streamCallbacks?: ChatStreamCallbacks): Promise<{selectedCandidateId, reply, toolsUsed}>` — Task 5 (`server.ts`) calls this with the new array-based first argument, optionally passing `streamCallbacks`. `ChatStreamCallbacks = { onDelta: (text: string) => void; onToolCallDelta: (delta: {index, id?, name?, argsFragment?}) => void; onToolResult: (index: number, name: string, result: string) => void; signal?: AbortSignal }`.

- [ ] **Step 1: Write the failing tests**

First, apply this mechanical transform to **every** existing `handleChat(...)` call in `tests/chat.test.ts` (there are 13 `test(...)` blocks in the file, each with exactly one call): a bare string first argument becomes a one-element array wrapping it in a user message. Nothing else in any test changes. Two examples:

Before:
```typescript
const result = await handleChat("hello there", deps);
```
After:
```typescript
const result = await handleChat([{ role: "user", content: "hello there" }], deps);
```

Before (inside `assert.rejects`):
```typescript
handleChat("hello", {
```
After:
```typescript
handleChat([{ role: "user", content: "hello" }], {
```

Apply this same wrapping to every other call (`"what's the weather in jakarta?"`, `"search something"`, `"search something huge"`, `"loop forever"` ×2, `"search something with emoji at the truncation boundary"`, etc.) — each becomes `[{ role: "user", content: "<same string>" }]`. Every mock inside `completeByProvider` that reads `messages[0].content` needs no change — that still resolves to the same string either way.

Then add these 3 new tests at the end of the file:

```typescript
test("handleChat() calls completeStreamByProvider instead of completeByProvider when streamCallbacks is provided", async () => {
  const deltas: string[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : noToolsDecision()),
    completeByProvider: {
      "ollama-local": async () => {
        throw new Error("should not be called");
      },
    },
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages, _tools, callbacks) => {
        callbacks.onDelta("streamed reply");
        return { content: "streamed reply", toolCalls: [] };
      },
    },
    toolExecutors: {},
  };

  const result = await handleChat(
    [{ role: "user", content: "hello" }],
    deps,
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => {}, onToolResult: () => {} }
  );

  assert.deepEqual(deltas, ["streamed reply"]);
  assert.equal(result.reply, "streamed reply");
});

test("handleChat() calls onToolResult after executing a tool when streaming", async () => {
  let callCount = 0;
  const toolResults: { index: number; name: string; result: string }[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision()),
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    },
    toolExecutors: { web_search: async () => "search result" },
  };

  await handleChat(
    [{ role: "user", content: "search something" }],
    deps,
    { onDelta: () => {}, onToolCallDelta: () => {}, onToolResult: (index, name, result) => toolResults.push({ index, name, result }) }
  );

  assert.deepEqual(toolResults, [{ index: 0, name: "web_search", result: "search result" }]);
});

test("handleChat() trims history that exceeds HISTORY_BUDGET_TOKENS before calling decide()", async () => {
  const longHistory = [
    { role: "user" as const, content: "x".repeat(30_000) },
    { role: "assistant" as const, content: "y".repeat(30_000) },
    { role: "user" as const, content: "most recent" },
  ];
  let seenMessages: typeof longHistory = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : noToolsDecision()),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        seenMessages = messages as typeof longHistory;
        return { content: "ok", toolCalls: [] };
      },
    },
    toolExecutors: {},
  };

  await handleChat(longHistory, deps);

  assert.ok(seenMessages.length < longHistory.length);
  assert.equal(seenMessages[seenMessages.length - 1].content, "most recent");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: FAIL — `handleChat` still expects a bare string, `ChatDeps` has no `completeStreamByProvider` field, `HISTORY_BUDGET_TOKENS` trimming doesn't exist.

- [ ] **Step 3: Rewrite `src/chat.ts`**

Replace the entire file:

```typescript
import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates, availableToolCandidates as defaultAvailableToolCandidates } from "./candidates.ts";
import { complete as ollamaComplete, completeStream as ollamaCompleteStream } from "./providers/ollama-client.ts";
import { complete as deepseekComplete, completeStream as deepseekCompleteStream } from "./providers/deepseek-client.ts";
import { callWebSearch } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import { estimateContextTokens } from "./token-estimate.ts";
import { ensureCandidateFits } from "./context-guard.ts";
import { trimHistory } from "./history-budget.ts";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 8000;
const HISTORY_BUDGET_TOKENS = 6000;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export type ToolCallDelta = { index: number; id?: string; name?: string; argsFragment?: string };

export type StreamCompleteFn = (
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  callbacks: { onDelta: (text: string) => void; onToolCallDelta: (delta: ToolCallDelta) => void },
  signal?: AbortSignal
) => Promise<CompletionResult>;

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: ToolCallDelta) => void;
  onToolResult: (index: number, name: string, result: string) => void;
  signal?: AbortSignal;
}

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  availableToolCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  completeStreamByProvider?: Record<string, StreamCompleteFn>;
  toolExecutors: Record<string, ToolExecutor>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  availableToolCandidates: defaultAvailableToolCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
  completeStreamByProvider: {
    "ollama-local": ollamaCompleteStream,
    deepseek: deepseekCompleteStream,
  },
  toolExecutors: {
    web_search: (args) => callWebSearch(String(args.query)),
    scrape: (args) => callScrape(String(args.url)),
  },
};

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

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  let cut = MAX_TOOL_RESULT_CHARS;
  const code = result.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return `${result.slice(0, cut)}...[truncated, ${result.length} chars total]`;
}

export async function handleChat(
  history: ChatMessage[],
  deps: ChatDeps = defaultDeps,
  streamCallbacks?: ChatStreamCallbacks
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const candidates = deps.availableCandidates();
  const messages = trimHistory(history, HISTORY_BUDGET_TOKENS);

  const modelDecision = await deps.decide(decideRequest("model_selection", candidates, messages));

  if (!modelDecision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }
  if (modelDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  let selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${modelDecision.selected_candidate_id}`);
  }

  let complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }
  let completeStreamFn = deps.completeStreamByProvider?.[selected.vendor];
  if (streamCallbacks && !completeStreamFn) {
    throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
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

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", Object.values(TOOL_DEFS), messages);
    const capacity = await ensureCandidateFits(
      selected,
      candidates,
      currentEstimate,
      decideRequest("model_selection", candidates, messages),
      deps.decide
    );

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
      const nextCompleteStream = deps.completeStreamByProvider?.[selected.vendor];
      if (streamCallbacks && !nextCompleteStream) {
        throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
      }
      completeStreamFn = nextCompleteStream;
    }

    const result = streamCallbacks
      ? await completeStreamFn!(
          selected.id,
          messages,
          tools,
          { onDelta: streamCallbacks.onDelta, onToolCallDelta: streamCallbacks.onToolCallDelta },
          streamCallbacks.signal
        )
      : await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyContent = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { selectedCandidateId: selected.id, reply: result.content ?? "", toolsUsed };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const [index, call] of result.toolCalls.entries()) {
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
      streamCallbacks?.onToolResult(index, call.function.name, toolResult);
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }

  if (lastNonEmptyContent) {
    return {
      selectedCandidateId: selected.id,
      reply: `${lastNonEmptyContent}\n\n[tool loop limit reached — response may be incomplete]`,
      toolsUsed,
    };
  }

  throw new Error("tool-calling loop exceeded maximum iterations");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: PASS, all 16 tests (13 pre-existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: give handleChat() a message-history parameter and streaming callbacks"
```

---

### Task 5: `src/server.ts` HTTP route + `createServer()` signature update

**Files:**
- Modify: `src/server.ts:1-10` (imports), `src/server.ts:37-100` (`createServer()`'s `/api/chat` and `/api/agent-turn` handlers)
- Modify: `tests/server.test.ts` (update the 3 existing `/api/chat` tests)

**Interfaces:**
- Consumes: `handleChat(history: ChatMessage[], ...)` (Task 4).
- Produces: `createServer(handleChatFn?: typeof handleChat, handleAgentTurnFn?: typeof handleAgentTurn): http.Server` — Task 7 (WS layer) is added inside this same function.

- [ ] **Step 1: Write the failing tests**

Replace the first three tests in `tests/server.test.ts` (`"POST /api/chat returns the handler's result as JSON"`, `"POST /api/chat with missing message returns 400"`, `"POST /api/chat returns 500 with the error message when the handler throws"`) with:

```typescript
import type { ChatMessage } from "../src/types.ts";

test("POST /api/chat returns the handler's result as JSON", async () => {
  const server = createServer(async (messages: ChatMessage[]) => ({
    selectedCandidateId: "gemma4:12b",
    reply: `echo: ${messages[0].content}`,
    toolsUsed: [],
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { selectedCandidateId: "gemma4:12b", reply: "echo: hi", toolsUsed: [] });
  server.close();
});

test("POST /api/chat with missing messages returns 400", async () => {
  const server = createServer(async (messages: ChatMessage[]) => ({
    selectedCandidateId: "x",
    reply: String(messages.length),
    toolsUsed: [],
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  server.close();
});

test("POST /api/chat returns 500 with the error message when the handler throws", async () => {
  const server = createServer(async () => {
    throw new Error("MADE returned no eligible candidate");
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "MADE returned no eligible candidate");
  server.close();
});
```

Leave the `"POST /api/agent-turn..."`-equivalent behavior and `"GET / serves the index page"` test untouched (there is no existing `/api/agent-turn` test in this file today — none needs adding here; Task 7 adds WS-level tests instead).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/server.test.ts`
Expected: FAIL — the route still reads `.message` (a string), not `.messages` (an array).

- [ ] **Step 3: Update `src/server.ts`**

Add `ChatMessage` to the type-only import at the top of the file (currently `import type { AgentTurnRequest } from "./agent-turn.ts";` on line 7) — change that line to also import from `./types.ts`:

```typescript
import type { AgentTurnRequest } from "./agent-turn.ts";
import type { ChatMessage } from "./types.ts";
```

Replace the `/api/chat` block inside `createServer()` (currently lines 40-69) with:

```typescript
      if (req.method === "POST" && req.url === "/api/chat") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let messages: unknown;
        try {
          messages = JSON.parse(raw).messages;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "messages field is required" }));
          return;
        }

        try {
          const result = await handleChatFn(messages as ChatMessage[]);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }
```

Change the `/api/agent-turn` block's completion call (currently `const result = await handleAgentTurn(body);` inside that block) to use an injectable function instead of the hardcoded import, and change `createServer`'s own signature to accept it. The full updated function signature and the one changed line inside the agent-turn block:

```typescript
export function createServer(
  handleChatFn: typeof handleChat = handleChat,
  handleAgentTurnFn: typeof handleAgentTurn = handleAgentTurn
): http.Server {
```

and, inside the existing `/api/agent-turn` block, change:
```typescript
          const result = await handleAgentTurn(body);
```
to:
```typescript
          const result = await handleAgentTurnFn(body);
```

Everything else in the file (the `GET` static-file handling, `serveStatic`, the bottom bootstrap block) is unchanged in this task — Task 7 modifies the bootstrap block and adds the WebSocket layer inside `createServer()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/server.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full ai-workspace test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: update /api/chat route for message-history requests, make /api/agent-turn's handler injectable"
```

---

### Task 6: `src/agent-turn.ts` — streaming callbacks

**Files:**
- Modify: `src/agent-turn.ts` (whole-file rewrite — see Step 3)
- Modify: `tests/agent-turn.test.ts` (3 new tests; no existing test changes needed — `handleAgentTurn(request, deps)`'s signature keeps `request`/`deps` as-is, only gains an optional 3rd parameter)

**Interfaces:**
- Consumes: `completeStream()` from both provider clients (Tasks 2–3).
- Produces: `handleAgentTurn(request, deps?, streamCallbacks?)` where `streamCallbacks` has the same shape as `chat.ts`'s `ChatStreamCallbacks` (Task 4) — Task 7 (WS layer) calls this with the array-based `request` unchanged and an optional `streamCallbacks`.

- [ ] **Step 1: Write the failing tests**

Add these 3 tests to the end of `tests/agent-turn.test.ts`:

```typescript
test("handleAgentTurn() calls completeStreamByProvider instead of completeByProvider when streamCallbacks is provided", async () => {
  const deltas: string[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => {
        throw new Error("should not be called");
      },
    },
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages, _tools, callbacks) => {
        callbacks.onDelta("streamed reply");
        return { content: "streamed reply", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
  };

  const result = await handleAgentTurn(baseRequest, deps, {
    onDelta: (t) => deltas.push(t),
    onToolCallDelta: () => {},
    onToolResult: () => {},
  });

  assert.deepEqual(deltas, ["streamed reply"]);
  assert.deepEqual(result, { type: "text", text: "streamed reply" });
});

test("handleAgentTurn() calls onToolResult after executing a server tool when streaming", async () => {
  let callCount = 0;
  const toolResults: { index: number; name: string; result: string }[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
            ],
          };
        }
        return { content: "answer", toolCalls: [] };
      },
    },
    serverToolExecutors: { web_search: async (args) => `results for ${args.query}` },
  };

  await handleAgentTurn(baseRequest, deps, {
    onDelta: () => {},
    onToolCallDelta: () => {},
    onToolResult: (index, name, result) => toolResults.push({ index, name, result }),
  });

  assert.deepEqual(toolResults, [{ index: 0, name: "web_search", result: "results for x" }]);
});

test("handleAgentTurn() falls back to non-streaming completeByProvider when streamCallbacks is omitted", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({ content: "non-streamed", toolCalls: [] }),
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, { type: "text", text: "non-streamed" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: FAIL — `AgentTurnDeps` has no `completeStreamByProvider` field, `handleAgentTurn` doesn't accept a 3rd argument.

- [ ] **Step 3: Rewrite `src/agent-turn.ts`**

Replace the entire file:

```typescript
import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates } from "./candidates.ts";
import { complete as ollamaComplete, completeStream as ollamaCompleteStream } from "./providers/ollama-client.ts";
import { complete as deepseekComplete, completeStream as deepseekCompleteStream } from "./providers/deepseek-client.ts";
import { callWebSearch } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import { estimateContextTokens } from "./token-estimate.ts";
import { ensureCandidateFits } from "./context-guard.ts";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TURN_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 8000;
const SERVER_TOOL_NAMES = new Set(["web_search", "scrape"]);

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; results: AgentToolResult[] };

export interface AgentTurnRequest {
  system: string;
  messages: AgentMessage[];
  tools: AgentToolDef[];
}

export type AgentTurnResult =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: AgentToolCall[]; text?: string };

export type ToolCallDelta = { index: number; id?: string; name?: string; argsFragment?: string };

export type StreamCompleteFn = (
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  callbacks: { onDelta: (text: string) => void; onToolCallDelta: (delta: ToolCallDelta) => void },
  signal?: AbortSignal
) => Promise<CompletionResult>;

export interface AgentTurnStreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: ToolCallDelta) => void;
  onToolResult: (index: number, name: string, result: string) => void;
  signal?: AbortSignal;
}

export interface AgentTurnDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  completeStreamByProvider?: Record<string, StreamCompleteFn>;
  serverToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>>;
}

const defaultDeps: AgentTurnDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
  completeStreamByProvider: {
    "ollama-local": ollamaCompleteStream,
    deepseek: deepseekCompleteStream,
  },
  serverToolExecutors: {
    web_search: (args) => callWebSearch(String(args.query)),
    scrape: (args) => callScrape(String(args.url)),
  },
};

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  let cut = MAX_TOOL_RESULT_CHARS;
  const code = result.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return `${result.slice(0, cut)}...[truncated, ${result.length} chars total]`;
}

function toChatMessages(system: string, messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", content: r.output, tool_call_id: r.id, name: r.name });
      }
    }
  }
  return out;
}

function mergeTools(clientTools: AgentToolDef[]): ToolDef[] {
  const names = new Set(clientTools.map((t) => t.name));
  const merged: ToolDef[] = clientTools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  for (const name of SERVER_TOOL_NAMES) {
    if (!names.has(name) && TOOL_DEFS[name]) {
      merged.push(TOOL_DEFS[name]);
    }
  }
  return merged;
}

function decideRequest(candidates: CandidateIn[], tools: ToolDef[], messages: ChatMessage[]): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimateContextTokens("", tools, messages),
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  };
}

export async function handleAgentTurn(
  request: AgentTurnRequest,
  deps: AgentTurnDeps = defaultDeps,
  streamCallbacks?: AgentTurnStreamCallbacks
): Promise<AgentTurnResult> {
  const candidates = deps.availableCandidates();
  const tools = mergeTools(request.tools);
  const messages = toChatMessages(request.system, request.messages);
  const modelDecision = await deps.decide(decideRequest(candidates, tools, messages));

  if (!modelDecision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }
  if (modelDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  let selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${modelDecision.selected_candidate_id}`);
  }

  let complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }
  let completeStreamFn = deps.completeStreamByProvider?.[selected.vendor];
  if (streamCallbacks && !completeStreamFn) {
    throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
  }

  let lastNonEmptyText: string | null = null;

  for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", tools, messages);
    const capacity = await ensureCandidateFits(
      selected,
      candidates,
      currentEstimate,
      decideRequest(candidates, tools, messages),
      deps.decide
    );

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
      const nextCompleteStream = deps.completeStreamByProvider?.[selected.vendor];
      if (streamCallbacks && !nextCompleteStream) {
        throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
      }
      completeStreamFn = nextCompleteStream;
    }

    const result = streamCallbacks
      ? await completeStreamFn!(
          selected.id,
          messages,
          tools,
          { onDelta: streamCallbacks.onDelta, onToolCallDelta: streamCallbacks.onToolCallDelta },
          streamCallbacks.signal
        )
      : await complete(selected.id, messages, tools);

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
    for (const [index, call] of result.toolCalls.entries()) {
      const executor = deps.serverToolExecutors[call.function.name];
      let toolResult: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        toolResult = executor ? await executor(args) : `tool ${call.function.name} is not available`;
      } catch (err) {
        toolResult = `${call.function.name} failed: ${(err as Error).message}`;
      }
      streamCallbacks?.onToolResult(index, call.function.name, toolResult);
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }

  throw new Error("agent-turn tool loop exceeded maximum iterations");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: PASS, all 10 tests (7 pre-existing + 3 new).

- [ ] **Step 5: Run the full ai-workspace test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-turn.ts tests/agent-turn.test.ts
git commit -m "feat: add streaming callbacks to handleAgentTurn()"
```

---

### Task 7: `src/server.ts` — WebSocket layer (turn lifecycle, resume, stop)

**Files:**
- Modify: `package.json` (add `ws` dependency)
- Modify: `src/server.ts` (whole-file rewrite — see Step 3)
- Modify: `tests/server.test.ts` (3 new WS tests)

**Interfaces:**
- Consumes: `handleChat(history, deps?, streamCallbacks?)` (Task 4), `handleAgentTurn(request, deps?, streamCallbacks?)` (Task 6).
- Produces: `createServer()` now also accepts and answers WebSocket connections on the same HTTP server/port. WS protocol: client sends `{type:"chat", messages}` / `{type:"agent-turn", system, messages, tools}` / `{type:"resume", turnId, lastSeq}` / `{type:"stop", turnId}`; server sends `{type:"turn_started", turnId}`, then `{type:"delta"|"tool_call_delta"|"tool_result"|"error", turnId, seq, ...}`, and finally either `{type:"done", turnId, seq, result: {selectedCandidateId, reply, toolsUsed} | {type:"text", text} | {type:"tool_calls", calls, text?}}` or `{type:"done", turnId, seq, stopped:true}`. The successful-completion result is nested under a `result` key (not spread flat) — `AgentTurnResult` has its own `type` field (`"text"`/`"tool_calls"`) which would collide with and silently overwrite the outer `type:"done"` if spread directly. Task 8 (`ChatApp.tsx`) and Task 9 (GenOffice `transport.ts`) are the clients of this protocol.

- [ ] **Step 1: Add the `ws` dependency**

```bash
npm install ws
```

Verify `package.json`'s `dependencies` now includes `"ws"`.

- [ ] **Step 2: Write the failing tests**

Add these 3 tests to the end of `tests/server.test.ts`. They use Node's built-in global `WebSocket` client (available in Node 22+, no import needed):

```typescript
test("WS: chat turn streams delta events then a done event", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("hel");
    streamCallbacks?.onDelta("lo");
    return { selectedCandidateId: "x", reply: "hello", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}`);
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }));
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      events.push(msg);
      if (msg.type === "done") resolve();
    });
    ws.addEventListener("error", reject);
  });
  ws.close();
  server.close();

  const types = events.filter((e) => e.type !== "turn_started").map((e) => e.type);
  assert.deepEqual(types, ["delta", "delta", "done"]);
});

test("WS: resume replays buffered events after reconnecting with a new socket", async () => {
  let releaseSecondDelta: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseSecondDelta = resolve;
  });

  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("first");
    await gate;
    streamCallbacks?.onDelta("second");
    return { selectedCandidateId: "x", reply: "first second", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws1 = new WebSocket(`ws://localhost:${port}`);
  let turnId = "";
  let lastSeq = -1;
  await new Promise<void>((resolve) => {
    ws1.addEventListener("open", () =>
      ws1.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }))
    );
    ws1.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      if (msg.type === "turn_started") turnId = msg.turnId;
      if (msg.type === "delta") {
        lastSeq = msg.seq;
        resolve();
      }
    });
  });
  ws1.close();
  releaseSecondDelta();

  const ws2 = new WebSocket(`ws://localhost:${port}`);
  const resumedEvents: any[] = [];
  await new Promise<void>((resolve) => {
    ws2.addEventListener("open", () => ws2.send(JSON.stringify({ type: "resume", turnId, lastSeq })));
    ws2.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      resumedEvents.push(msg);
      if (msg.type === "done") resolve();
    });
  });
  ws2.close();
  server.close();

  assert.deepEqual(resumedEvents.map((e) => e.type), ["delta", "done"]);
  assert.equal(resumedEvents[0].text, "second");
});

test("WS: stop aborts an in-flight turn and the done event reports stopped:true", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("partial");
    await new Promise((_resolve, reject) => {
      streamCallbacks?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    return { selectedCandidateId: "x", reply: "unreachable", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}`);
  const events: any[] = [];
  let turnId = "";
  await new Promise<void>((resolve) => {
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }))
    );
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      events.push(msg);
      if (msg.type === "turn_started") turnId = msg.turnId;
      if (msg.type === "delta") ws.send(JSON.stringify({ type: "stop", turnId }));
      if (msg.type === "done") resolve();
    });
  });
  ws.close();
  server.close();

  const done = events.find((e) => e.type === "done");
  assert.equal(done.stopped, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/server.test.ts`
Expected: FAIL — connecting a `WebSocket` to the plain HTTP server has nothing to upgrade the connection.

- [ ] **Step 4: Rewrite `src/server.ts`**

Replace the entire file:

```typescript
import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { handleChat } from "./chat.ts";
import { handleAgentTurn } from "./agent-turn.ts";
import type { AgentTurnRequest } from "./agent-turn.ts";
import type { ChatMessage } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST_DIR = path.join(__dirname, "..", "client", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveStatic(res: http.ServerResponse, relativePath: string): Promise<boolean> {
  const filePath = path.join(CLIENT_DIST_DIR, relativePath);
  if (filePath !== CLIENT_DIST_DIR && !filePath.startsWith(CLIENT_DIST_DIR + path.sep)) {
    return false;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const MAX_BUFFERED_EVENTS = 500;
const TURN_EVICT_MS = 60_000;

interface BufferedEvent {
  seq: number;
  message: Record<string, unknown>;
}

interface TurnState {
  buffer: BufferedEvent[];
  status: "running" | "done" | "error";
  controller: AbortController;
  socket: WebSocket | null;
}

const turns = new Map<string, TurnState>();

function emit(turnId: string, message: Record<string, unknown>): void {
  const turn = turns.get(turnId);
  if (!turn) return;
  const seq = turn.buffer.length > 0 ? turn.buffer[turn.buffer.length - 1].seq + 1 : 0;
  const full = { ...message, turnId, seq };
  turn.buffer.push({ seq, message: full });
  if (turn.buffer.length > MAX_BUFFERED_EVENTS) {
    turn.buffer.shift();
  }
  if (turn.socket && turn.socket.readyState === turn.socket.OPEN) {
    turn.socket.send(JSON.stringify(full));
  }
}

type IncomingWsMessage =
  | ({ type: "chat" } & { messages: ChatMessage[] })
  | ({ type: "agent-turn" } & AgentTurnRequest)
  | { type: "resume"; turnId: string; lastSeq: number }
  | { type: "stop"; turnId: string };

function startTurn(
  socket: WebSocket,
  msg: { type: "chat"; messages: ChatMessage[] } | ({ type: "agent-turn" } & AgentTurnRequest),
  handleChatFn: typeof handleChat,
  handleAgentTurnFn: typeof handleAgentTurn
): void {
  const turnId = crypto.randomUUID();
  const controller = new AbortController();
  turns.set(turnId, { buffer: [], status: "running", controller, socket });
  socket.send(JSON.stringify({ type: "turn_started", turnId }));

  const streamCallbacks = {
    onDelta: (text: string) => emit(turnId, { type: "delta", text }),
    onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) =>
      emit(turnId, { type: "tool_call_delta", ...delta }),
    onToolResult: (index: number, name: string, result: string) =>
      emit(turnId, { type: "tool_result", index, name, result }),
    signal: controller.signal,
  };

  const run =
    msg.type === "chat"
      ? handleChatFn(msg.messages, undefined, streamCallbacks)
      : handleAgentTurnFn(msg, undefined, streamCallbacks);

  run
    .then((result) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "done";
      emit(turnId, { type: "done", result });
    })
    .catch((err: Error) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "error";
      if (err.name === "AbortError") {
        emit(turnId, { type: "done", stopped: true });
      } else {
        emit(turnId, { type: "error", error: err.message });
      }
    })
    .finally(() => {
      setTimeout(() => turns.delete(turnId), TURN_EVICT_MS);
    });
}

function attachWebSocketServer(
  server: http.Server,
  handleChatFn: typeof handleChat,
  handleAgentTurnFn: typeof handleAgentTurn
): void {
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      let msg: IncomingWsMessage;
      try {
        msg = JSON.parse(raw.toString()) as IncomingWsMessage;
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid JSON message" }));
        return;
      }

      if (msg.type === "chat" || msg.type === "agent-turn") {
        startTurn(socket, msg, handleChatFn, handleAgentTurnFn);
      } else if (msg.type === "resume") {
        const turn = turns.get(msg.turnId);
        if (!turn) {
          socket.send(JSON.stringify({ type: "error", error: "turn not found, please retry" }));
          return;
        }
        turn.socket = socket;
        for (const event of turn.buffer) {
          if (event.seq > msg.lastSeq) socket.send(JSON.stringify(event.message));
        }
      } else if (msg.type === "stop") {
        turns.get(msg.turnId)?.controller.abort();
      } else {
        socket.send(JSON.stringify({ type: "error", error: `unknown message type ${(msg as { type: string }).type}` }));
      }
    });
  });
}

export function createServer(
  handleChatFn: typeof handleChat = handleChat,
  handleAgentTurnFn: typeof handleAgentTurn = handleAgentTurn
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/chat") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let messages: unknown;
        try {
          messages = JSON.parse(raw).messages;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "messages field is required" }));
          return;
        }

        try {
          const result = await handleChatFn(messages as ChatMessage[]);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/agent-turn") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let body: AgentTurnRequest;
        try {
          body = JSON.parse(raw) as AgentTurnRequest;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (typeof body.system !== "string" || !Array.isArray(body.messages) || !Array.isArray(body.tools)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "system, messages, and tools fields are required" }));
          return;
        }

        try {
          const result = await handleAgentTurnFn(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "GET") {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const urlPath = pathname === "/" ? "/chat.html" : pathname === "/document" ? "/document.html" : pathname;
        if (await serveStatic(res, urlPath)) {
          return;
        }
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  attachWebSocketServer(server, handleChatFn, handleAgentTurnFn);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/server.test.ts`
Expected: PASS, all tests including the 3 new WS tests.

- [ ] **Step 6: Run the full ai-workspace test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/server.ts tests/server.test.ts
git commit -m "feat: add WebSocket streaming layer with resume and stop support"
```

---

### Task 8: `client/src/chat/ChatApp.tsx` — WS client, history, markdown, stop/typing/regenerate

**Files:**
- Modify: `package.json` (add `marked`, `dompurify` dependencies)
- Modify: `client/src/chat/ChatApp.tsx` (whole-file rewrite)

**Interfaces:**
- Consumes: the WS protocol from Task 7 (`{type:"chat", messages}` request; `turn_started`/`delta`/`tool_call_delta`/`tool_result`/`done`/`error` responses).

No automated tests for this task (per the design spec, client UI is verified manually) — this task's only "test" is the manual verification in Step 3.

- [ ] **Step 1: Add dependencies**

```bash
npm install marked dompurify
```

Verify `package.json`'s `dependencies` now includes `"marked"` and `"dompurify"`.

- [ ] **Step 2: Rewrite `client/src/chat/ChatApp.tsx`**

Replace the entire file:

```typescript
import { useEffect, useRef, useState, type FormEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;

export function ChatApp() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [awaitingFirstToken, setAwaitingFirstToken] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const draftRef = useRef("");
  const turnIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(-1);
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    turnIdRef.current = turnId;
  }, [turnId]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    const ws = new WebSocket(`ws://${location.host}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnectionLost(false);
      if (turnIdRef.current) {
        ws.send(JSON.stringify({ type: "resume", turnId: turnIdRef.current, lastSeq: lastSeqRef.current }));
      }
    };

    ws.onmessage = (event) => handleWsMessage(String(event.data));

    ws.onclose = () => {
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionLost(true);
        return;
      }
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptsRef.current;
      reconnectAttemptsRef.current += 1;
      setTimeout(connect, delay);
    };
  }

  function handleWsMessage(raw: string) {
    const msg = JSON.parse(raw) as { type: string; seq?: number; turnId?: string; text?: string; error?: string };

    if (msg.type === "turn_started") {
      setTurnId(msg.turnId ?? null);
      setAwaitingFirstToken(true);
      return;
    }

    if (typeof msg.seq === "number") {
      lastSeqRef.current = msg.seq;
    }

    if (msg.type === "delta") {
      draftRef.current += msg.text ?? "";
      setAssistantDraft(draftRef.current);
      setAwaitingFirstToken(false);
    } else if (msg.type === "tool_call_delta" || msg.type === "tool_result") {
      setAwaitingFirstToken(false);
    } else if (msg.type === "done") {
      setMessages((prev) => [...prev, { role: "assistant", content: draftRef.current }]);
      draftRef.current = "";
      setAssistantDraft("");
      setTurnId(null);
      setAwaitingFirstToken(false);
    } else if (msg.type === "error") {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg.error}` }]);
      draftRef.current = "";
      setAssistantDraft("");
      setTurnId(null);
      setAwaitingFirstToken(false);
    }
  }

  function sendTurn(msgs: ChatMessage[]) {
    wsRef.current?.send(JSON.stringify({ type: "chat", messages: msgs }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    const next = [...messages, { role: "user" as const, content: message }];
    setMessages(next);
    setMessage("");
    sendTurn(next);
  }

  function stop() {
    if (turnId) {
      wsRef.current?.send(JSON.stringify({ type: "stop", turnId }));
    }
  }

  function regenerate() {
    const lastIndex = messages.length - 1;
    if (lastIndex < 0 || messages[lastIndex].role !== "assistant") return;
    const truncated = messages.slice(0, lastIndex);
    setMessages(truncated);
    sendTurn(truncated);
  }

  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1].role === "assistant";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>
      <h1>AI Workspace — Chat</h1>
      {connectionLost && <div style={{ color: "#b00", marginBottom: 8 }}>Connection lost. Reload the page to reconnect.</div>}
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, minHeight: 200, marginBottom: 12 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>
            {m.role === "assistant" ? <Markdown text={m.content} /> : <div>{m.content}</div>}
          </div>
        ))}
        {turnId && (
          <div style={{ marginBottom: 8 }}>
            <strong>Assistant:</strong>
            {awaitingFirstToken ? <div>typing…</div> : <Markdown text={assistantDraft} />}
          </div>
        )}
      </div>
      {lastIsAssistant && !turnId && (
        <button type="button" onClick={regenerate} style={{ marginBottom: 8 }}>
          Regenerate
        </button>
      )}
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message..."
          autoComplete="off"
          required
          style={{ flex: 1, padding: 8 }}
        />
        {turnId ? (
          <button type="button" onClick={stop} style={{ padding: "8px 16px" }}>
            Stop
          </button>
        ) : (
          <button type="submit" style={{ padding: "8px 16px" }}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Manual verification**

Run `npm run dev` (server) and `npm run dev:client` (Vite), open the chat page in a browser, and verify:
1. Sending a message shows the user's text immediately, then the assistant's reply appears token-by-token (not all at once).
2. A "typing…" indicator shows before the first token arrives.
3. While a reply is streaming, the "Send" button is replaced by "Stop"; clicking it ends the reply early and the button reverts to "Send".
4. Markdown in a reply (ask the model to reply with a code block or a list) renders as formatted HTML, not raw `**`/`` ``` `` characters.
5. After a reply finishes, a "Regenerate" button appears; clicking it replaces the last reply with a new one.
6. Send a second message and confirm the model's context includes the first exchange (multi-turn history works).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json client/src/chat/ChatApp.tsx
git commit -m "feat: rewrite ChatApp.tsx for WebSocket streaming, history, markdown, and stop/regenerate"
```

---

### Task 9: GenOffice `transport.ts` — `createMadeTransport()` over WebSocket

**Files:**
- Modify: `genoffice/apps/docs/src/renderer/ai/transport.ts` (replace only `createMadeTransport()`; `createElectronTransport()` and its imports are untouched)

**Interfaces:**
- Consumes: the WS protocol from Task 7. `AgentTransport`, `AgentStreamCallbacks`, `AgentStreamHandle` from `@genoffice/agent-core` (existing, unchanged — `onToolCall(call)` expects a fully-parsed call, not deltas; the optional `onPhase?(phase)` with `AgentPhaseKind` including `"tool-input"` is the existing hook this task uses to surface tool-call-in-progress without needing a new client-facing raw-delta API).

No automated tests for this task (per the design spec, GenOffice UI is verified manually, and this repo has no existing test harness for `genoffice/`'s renderer code) — Step 2 is manual verification.

- [ ] **Step 1: Replace `createMadeTransport()` in `transport.ts`**

Replace only the `createMadeTransport` function (leave the `createElectronTransport` function and the top imports exactly as they are):

```typescript
/** Transport that streams the backend's WebSocket endpoint (MADE-connected model turn). */
export function createMadeTransport(): AgentTransport {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;

  function ensureSocket(): WebSocket {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socket;
    }
    const next = new WebSocket(`ws://${location.host}`);
    next.addEventListener('open', () => {
      reconnectAttempts = 0;
    });
    next.addEventListener('close', () => {
      if (reconnectAttempts >= 5) return;
      const delay = 500 * 2 ** reconnectAttempts;
      reconnectAttempts += 1;
      setTimeout(ensureSocket, delay);
    });
    socket = next;
    return next;
  }

  return {
    stream(request, callbacks) {
      const ws = ensureSocket();
      let turnId: string | null = null;
      let done = false;
      let inToolInputPhase = false;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        ws.removeEventListener('message', handleMessage);
        fn();
      };

      function handleMessage(event: MessageEvent) {
        const msg = JSON.parse(String(event.data));

        if (msg.type === 'turn_started') {
          turnId = msg.turnId;
          return;
        }
        if (turnId && msg.turnId && msg.turnId !== turnId) return;

        if (msg.type === 'delta') {
          callbacks.onDelta(msg.text);
        } else if (msg.type === 'tool_call_delta') {
          if (!inToolInputPhase) {
            inToolInputPhase = true;
            callbacks.onPhase?.({ kind: 'tool-input' });
          }
        } else if (msg.type === 'tool_result') {
          inToolInputPhase = false;
        } else if (msg.type === 'done') {
          if (msg.stopped) {
            finish(() => callbacks.onDone());
            return;
          }
          const result = msg.result as { type: 'text'; text: string } | { type: 'tool_calls'; calls: Parameters<typeof callbacks.onToolCall>[0][]; text?: string };
          if (result.type === 'text') {
            finish(() => callbacks.onDone());
          } else if (result.type === 'tool_calls') {
            for (const call of result.calls) callbacks.onToolCall(call);
            finish(() => callbacks.onDone());
          } else {
            finish(() => callbacks.onError('unexpected result shape in done event'));
          }
        } else if (msg.type === 'error') {
          finish(() => callbacks.onError(msg.error ?? 'unknown streaming error'));
        }
      }

      ws.addEventListener('message', handleMessage);

      const send = () =>
        ws.send(JSON.stringify({ type: 'agent-turn', system: request.system, messages: request.messages, tools: request.tools }));
      if (ws.readyState === WebSocket.OPEN) {
        send();
      } else {
        ws.addEventListener('open', send, { once: true });
      }

      return {
        cancel: () => {
          if (turnId) ws.send(JSON.stringify({ type: 'stop', turnId }));
          finish(() => callbacks.onDone());
        },
      };
    },
  };
}
```

Note: `callbacks.onDelta(text)` for a `"text"`-type result is intentionally not called again inside the `done` handling — every content token was already delivered live via `delta` events as they streamed in (§3 of the design spec), so `done` only needs to signal completion, not repeat the text.

- [ ] **Step 2: Manual verification**

Run the dev stack (`npm run dev` and `npm run dev:client`), open `/document`, and verify:
1. Asking the AI panel a plain question streams the reply token-by-token in the panel.
2. Asking a question that triggers `web_search`/`scrape` shows a "tool-input" activity indicator (GenOffice's existing phase-driven status line, already wired to `AgentPhaseKind`) while the tool call is being constructed, then the reply streams normally afterward.
3. Asking the AI panel to edit the document (a request that produces a document tool call, e.g. `insert_content`) still works exactly as before — the tool call is handed back to the client unexecuted, same as the pre-streaming behavior.
4. Clicking GenOffice's existing cancel/stop control mid-reply stops the stream.
5. Disconnecting the network briefly (e.g. toggle devtools "offline") mid-reply and reconnecting resumes rather than restarting the reply from scratch.

- [ ] **Step 3: Commit**

```bash
git add genoffice/apps/docs/src/renderer/ai/transport.ts
git commit -m "feat: stream GenOffice's AI panel over the new WebSocket transport"
```
