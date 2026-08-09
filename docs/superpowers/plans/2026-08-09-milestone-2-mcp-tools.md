# Milestone 2: MCP Tools (SearXNG + Scrapling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat model can call `web_search` (SearXNG) and `scrape` (Scrapling) tools when MADE allows it for the task, and the whole stack (app + SearXNG + Scrapling + MADE) starts with `docker compose up` instead of three manually-started processes.

**Architecture:** Provider clients (`ollama-client.ts`, `deepseek-client.ts`) upgrade from a single-prompt interface to a multi-turn `messages[]` + `tools[]` interface, returning `{ content, toolCalls }`. Two new MCP client modules (`src/mcp/searxng-client.ts`, `src/mcp/scrapling-client.ts`) wrap the official `@modelcontextprotocol/sdk` — one over stdio (spawns `mcp-searxng` as a child process), one over Streamable HTTP (calls the `scrapling` container). `chat.ts` gains a bounded tool-calling loop: ask MADE which tools are allowed, call the model with those tools, execute any `tool_calls` via the MCP clients, feed results back, repeat until the model stops calling tools. A `docker-compose.yaml` wires `app` + `searxng` + `scrapling` + `made` (new `Dockerfile` added to the sibling `MODE` repo) into one command; Ollama stays external on the host.

**Tech Stack:** Node.js 22+, TypeScript, `tsx`, native `fetch`/`http`, `@modelcontextprotocol/sdk` (new runtime dependency — the only one), Docker + Docker Compose, `searxng/searxng` image, `scrapling[ai]` (Python, pip).

## Global Constraints

- One runtime dependency added this milestone: `@modelcontextprotocol/sdk` — implementing MCP's stdio/HTTP JSON-RPC framing by hand would be reinventing a spec-compliance-heavy protocol, not "a few lines"; the official SDK is the correct tool here. No other new runtime dependencies.
- One file per LLM provider client, one file per MCP tool client — do not build a generalized "MCP manager" abstraction for two tools.
- MADE and Ollama are still reached over HTTP only — this project never imports code from either.
- All async I/O (MADE calls, provider calls, MCP tool calls) must be dependency-injected into the functions that use them, matching the existing pattern in `chat.ts` (`ChatDeps`) — tests never spawn real subprocesses or make real network calls.
- Tool-loop iterations are capped (max 5 round-trips) to prevent an unbounded loop if a model keeps requesting tools.
- Tool execution failures (MCP subprocess won't spawn, HTTP timeout, etc.) become an error string fed back to the model as the tool result — never an unhandled exception that 500s the whole chat request.

---

### Task 1: Shared types + tool definitions

**Files:**
- Modify: `src/types.ts`
- Create: `src/tools.ts`
- Test: `tests/tools.test.ts`

**Interfaces:**
- Produces: `ChatMessage`, `ToolCall`, `ToolDef`, `CompletionResult` types (`src/types.ts`); `TOOL_DEFS: Record<string, ToolDef>` (`src/tools.ts`)

- [ ] **Step 1: Add the new shared types**

Append to `src/types.ts`:

```typescript
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
}
```

- [ ] **Step 2: Write the failing test for tool definitions**

`tests/tools.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFS } from "../src/tools.ts";

test("TOOL_DEFS has an entry for web_search and scrape with matching function names", () => {
  assert.equal(TOOL_DEFS.web_search.function.name, "web_search");
  assert.equal(TOOL_DEFS.scrape.function.name, "scrape");
});

test("TOOL_DEFS entries declare their required parameters", () => {
  assert.deepEqual(TOOL_DEFS.web_search.function.parameters.required, ["query"]);
  assert.deepEqual(TOOL_DEFS.scrape.function.parameters.required, ["url"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/tools.ts` does not exist.

- [ ] **Step 4: Implement the tool definitions**

`src/tools.ts`:

```typescript
import type { ToolDef } from "./types.ts";

export const TOOL_DEFS: Record<string, ToolDef> = {
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  scrape: {
    type: "function",
    function: {
      name: "scrape",
      description: "Fetch and extract the full readable content of a web page",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: `tests/tools.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/tools.ts tests/tools.test.ts
git commit -m "feat: add chat message/tool types and tool definitions"
```

---

### Task 2: Upgrade provider clients to messages + tools interface

**Files:**
- Modify: `src/providers/ollama-client.ts`
- Modify: `src/providers/deepseek-client.ts`
- Modify: `tests/providers/ollama-client.test.ts`
- Modify: `tests/providers/deepseek-client.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ToolDef`, `CompletionResult` (Task 1, `src/types.ts`)
- Produces: `complete(model: string, messages: ChatMessage[], tools?: ToolDef[], baseUrl?: string, fetchImpl?: typeof fetch): Promise<CompletionResult>` in both provider files — this replaces the Milestone 1 `complete(model, prompt, ...)` signature.

- [ ] **Step 1: Rewrite the Ollama client test for the new interface**

Replace the contents of `tests/providers/ollama-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/ollama-client.ts";
import type { ChatMessage } from "../../src/types.ts";

test("complete() posts messages (and tools, if given) to {baseUrl}/v1/chat/completions", async () => {
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from gemma", tool_calls: undefined } }] }),
      { status: 200 }
    );
  };

  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await complete("gemma4:12b", messages, [], "http://ollama.test", fakeFetch);

  assert.deepEqual(capturedBody, { model: "gemma4:12b", messages });
  assert.deepEqual(result, { content: "hello from gemma", toolCalls: [] });
});

test("complete() includes tools in the request body and surfaces tool_calls in the result", async () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } };
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "", tool_calls: [toolCall] } }] }),
      { status: 200 }
    );
  };

  const tools = [{ type: "function" as const, function: { name: "web_search", description: "d", parameters: {} } }];
  const result = await complete("gemma4:12b", [{ role: "user", content: "hi" }], tools, "http://ollama.test", fakeFetch);

  assert.deepEqual(capturedBody.tools, tools);
  assert.deepEqual(result, { content: "", toolCalls: [toolCall] });
});

test("complete() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(
    () => complete("gemma4:12b", [{ role: "user", content: "hi" }], [], "http://ollama.test", fakeFetch),
    /Ollama API returned 500/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — existing `complete()` signature takes a `prompt` string, so `capturedBody` won't match and tool-related assertions fail.

- [ ] **Step 3: Rewrite the Ollama client implementation**

Replace `src/providers/ollama-client.ts`:

```typescript
import type { ChatMessage, ToolDef, CompletionResult } from "../types.ts";

export async function complete(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  const body: Record<string, unknown> = { model, messages };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
  }

  const parsed = (await response.json()) as {
    choices: { message: { content: string | null; tool_calls?: CompletionResult["toolCalls"] } }[];
  };
  const message = parsed.choices[0].message;
  return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `tests/providers/ollama-client.test.ts` PASS.

- [ ] **Step 5: Rewrite the DeepSeek client test for the new interface**

Replace `tests/providers/deepseek-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/deepseek-client.ts";
import type { ChatMessage } from "../../src/types.ts";

test("complete() sends Bearer auth and posts messages to {baseUrl}/v1/chat/completions", async () => {
  let capturedHeaders: HeadersInit | undefined;
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from deepseek" } }] }),
      { status: 200 }
    );
  };

  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await complete("deepseek-v4-flash", messages, [], "sk-test", "http://deepseek.test", fakeFetch);

  assert.equal((capturedHeaders as Record<string, string>)["authorization"], "Bearer sk-test");
  assert.deepEqual(capturedBody, { model: "deepseek-v4-flash", messages });
  assert.deepEqual(result, { content: "hello from deepseek", toolCalls: [] });
});

test("complete() throws if no API key is provided", async () => {
  await assert.rejects(
    () => complete("deepseek-v4-flash", [{ role: "user", content: "hi" }], [], "", "http://deepseek.test", fetch),
    /DEEPSEEK_API_KEY not set/
  );
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — signature mismatch, same as Ollama client.

- [ ] **Step 7: Rewrite the DeepSeek client implementation**

Replace `src/providers/deepseek-client.ts`:

```typescript
import type { ChatMessage, ToolDef, CompletionResult } from "../types.ts";

export async function complete(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const body: Record<string, unknown> = { model, messages };
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
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }

  const parsed = (await response.json()) as {
    choices: { message: { content: string | null; tool_calls?: CompletionResult["toolCalls"] } }[];
  };
  const message = parsed.choices[0].message;
  return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test`
Expected: `tests/providers/deepseek-client.test.ts` PASS. Note `tests/chat.test.ts` will now FAIL (it still uses the old `completeByProvider` shape) — that's expected, Task 5 fixes it.

- [ ] **Step 9: Commit**

```bash
git add src/providers/ollama-client.ts src/providers/deepseek-client.ts tests/providers/
git commit -m "feat: upgrade provider clients to messages+tools interface"
```

---

### Task 3: `@modelcontextprotocol/sdk` + SearXNG MCP client (stdio)

**Files:**
- Modify: `package.json`
- Create: `src/mcp/searxng-client.ts`
- Test: `tests/mcp/searxng-client.test.ts`

**Interfaces:**
- Produces: `callWebSearch(query: string, connect?: () => Promise<McpToolConnection>): Promise<string>` and `McpToolConnection` interface (`src/mcp/searxng-client.ts`)

- [ ] **Step 1: Add the MCP SDK dependency**

Run: `npm install @modelcontextprotocol/sdk`
Expected: `package.json` gains a `dependencies` block with `@modelcontextprotocol/sdk`; this is the project's first runtime dependency (see Global Constraints).

- [ ] **Step 2: Write the failing test**

`tests/mcp/searxng-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { callWebSearch } from "../../src/mcp/searxng-client.ts";

test("callWebSearch() connects, calls the web_search tool with the query, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return "search results text";
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callWebSearch("weather in Jakarta", fakeConnect);

  assert.equal(capturedName, "web_search");
  assert.deepEqual(capturedArgs, { query: "weather in Jakarta" });
  assert.equal(result, "search results text");
  assert.equal(closed, true);
});

test("callWebSearch() closes the connection even if the tool call throws", async () => {
  let closed = false;
  const fakeConnect = async () => ({
    callTool: async () => {
      throw new Error("boom");
    },
    close: async () => {
      closed = true;
    },
  });

  await assert.rejects(() => callWebSearch("x", fakeConnect), /boom/);
  assert.equal(closed, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/mcp/searxng-client.ts` does not exist.

- [ ] **Step 4: Implement the SearXNG MCP client**

`src/mcp/searxng-client.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

async function defaultConnect(): Promise<McpToolConnection> {
  const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-searxng"],
    env: { ...process.env, SEARXNG_URL: searxngUrl },
  });
  const client = new Client({ name: "ai-workspace", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content;
      if (Array.isArray(content)) {
        return content.map((c: { text?: string }) => c.text ?? "").join("\n");
      }
      return String(content ?? "");
    },
    close: () => client.close(),
  };
}

// ponytail: spawns a fresh mcp-searxng subprocess per call — simplest thing
// that works for low-frequency chat tool calls. Upgrade to a persistent
// pooled connection if subprocess startup latency becomes measurable.
export async function callWebSearch(
  query: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  const connection = await connect();
  try {
    return await connection.callTool("web_search", { query });
  } finally {
    await connection.close();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: `tests/mcp/searxng-client.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/mcp/searxng-client.ts tests/mcp/searxng-client.test.ts
git commit -m "feat: add SearXNG MCP client over stdio"
```

---

### Task 4: Scrapling MCP client (Streamable HTTP)

**Files:**
- Create: `src/mcp/scrapling-client.ts`
- Test: `tests/mcp/scrapling-client.test.ts`

**Interfaces:**
- Consumes: `McpToolConnection` (Task 3, `src/mcp/searxng-client.ts`)
- Produces: `callScrape(url: string, connect?: () => Promise<McpToolConnection>): Promise<string>` (`src/mcp/scrapling-client.ts`)

- [ ] **Step 1: Write the failing test**

`tests/mcp/scrapling-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { callScrape } from "../../src/mcp/scrapling-client.ts";

test("callScrape() connects, calls the fetch tool with the url, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return "page content";
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callScrape("https://example.com", fakeConnect);

  assert.equal(capturedName, "fetch");
  assert.deepEqual(capturedArgs, { url: "https://example.com" });
  assert.equal(result, "page content");
  assert.equal(closed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/mcp/scrapling-client.ts` does not exist.

- [ ] **Step 3: Implement the Scrapling MCP client**

`src/mcp/scrapling-client.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolConnection } from "./searxng-client.ts";

async function defaultConnect(): Promise<McpToolConnection> {
  const scraplingUrl = process.env.SCRAPLING_URL ?? "http://scrapling:8000/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(scraplingUrl));
  const client = new Client({ name: "ai-workspace", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content;
      if (Array.isArray(content)) {
        return content.map((c: { text?: string }) => c.text ?? "").join("\n");
      }
      return String(content ?? "");
    },
    close: () => client.close(),
  };
}

// Uses Scrapling's browser-rendered "fetch" tool (full page, not the raw
// "get" tool) since our web_search tool already covers plain HTTP lookups.
export async function callScrape(
  url: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  const connection = await connect();
  try {
    return await connection.callTool("fetch", { url });
  } finally {
    await connection.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `tests/mcp/scrapling-client.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/scrapling-client.ts tests/mcp/scrapling-client.test.ts
git commit -m "feat: add Scrapling MCP client over Streamable HTTP"
```

---

### Task 5: Tool candidates for MADE tool_selection

**Files:**
- Modify: `src/candidates.ts`
- Modify: `tests/candidates.test.ts`

**Interfaces:**
- Consumes: `CandidateIn` (`src/types.ts`)
- Produces: `availableToolCandidates(): CandidateIn[]` (`src/candidates.ts`)

- [ ] **Step 1: Write the failing test**

Append to `tests/candidates.test.ts`:

```typescript
import { availableToolCandidates } from "../src/candidates.ts";

test("availableToolCandidates() returns web_search and scrape as tool-kind candidates", () => {
  const candidates = availableToolCandidates();
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

  assert.equal(byId.web_search.kind, "tool");
  assert.equal(byId.scrape.kind, "tool");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `availableToolCandidates` is not exported.

- [ ] **Step 3: Implement tool candidates**

Append to `src/candidates.ts`:

```typescript
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

export function availableToolCandidates(): CandidateIn[] {
  return [WEB_SEARCH_CANDIDATE, SCRAPE_CANDIDATE];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `tests/candidates.test.ts` PASS (all cases, including Milestone 1's).

- [ ] **Step 5: Commit**

```bash
git add src/candidates.ts tests/candidates.test.ts
git commit -m "feat: add web_search and scrape as MADE tool candidates"
```

---

### Task 6: Chat orchestration tool-calling loop

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFS` (Task 1, `src/tools.ts`), `availableToolCandidates` (Task 5, `src/candidates.ts`), `callWebSearch` (Task 3), `callScrape` (Task 4), upgraded `complete()` (Task 2), `ChatMessage`/`ToolCall`/`CompletionResult` (Task 1)
- Produces: `handleChat(message: string, deps?: ChatDeps): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }>` — same thrown-error contract as Milestone 1, plus a new `Error("tool-calling loop exceeded maximum iterations")` case.

- [ ] **Step 1: Rewrite the chat orchestration test**

Replace `tests/chat.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChat } from "../src/chat.ts";
import type { ChatDeps } from "../src/chat.ts";
import type { DecideResponse } from "../src/types.ts";

const modelDecision: DecideResponse = {
  decision_id: "d1",
  selected_candidate_id: "gemma4-12b",
  requires_human_approval: false,
  ranking: [],
  excluded: [],
  technique_used: "topsis",
  policy_version: "1",
};

function noToolsDecision(): DecideResponse {
  return {
    decision_id: "d2",
    selected_candidate_id: null,
    requires_human_approval: false,
    ranking: [],
    excluded: [
      { id: "web_search", reason: "denied" },
      { id: "scrape", reason: "denied" },
    ],
    technique_used: "topsis",
    policy_version: "1",
  };
}

function allowAllToolsDecision(): DecideResponse {
  return {
    decision_id: "d2",
    selected_candidate_id: "web_search",
    requires_human_approval: false,
    ranking: [
      { id: "web_search", score: 0.8 },
      { id: "scrape", score: 0.6 },
    ],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };
}

const baseDeps = {
  availableCandidates: () => [
    { id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
  availableToolCandidates: () => [
    { id: "web_search", vendor: "mcp-searxng", kind: "tool" as const, cost_per_1k_tokens: 0, scores: {} },
    { id: "scrape", vendor: "scrapling", kind: "tool" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
};

test("handleChat() skips tool wiring entirely when MADE allows no tools", async () => {
  const decideCalls: string[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => {
      decideCalls.push(request.decision_kind);
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
  assert.equal(result.selectedCandidateId, "gemma4-12b");
  assert.equal(result.reply, "echo: hello there");
  assert.deepEqual(result.toolsUsed, []);
});

test("handleChat() executes a requested tool call and feeds the result back to the model", async () => {
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"jakarta weather"}' } },
            ],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `final reply using: ${toolMessage?.content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async (args) => `search results for ${args.query}`,
    },
  };

  const result = await handleChat("what's the weather in jakarta?", deps);

  assert.equal(callCount, 2);
  assert.equal(result.reply, "final reply using: search results for jakarta weather");
  assert.deepEqual(result.toolsUsed, ["web_search"]);
});

test("handleChat() feeds an error string back to the model when a tool executor throws", async () => {
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `handled: ${toolMessage?.content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => {
        throw new Error("subprocess failed to spawn");
      },
    },
  };

  const result = await handleChat("search something", deps);

  assert.match(result.reply, /handled: web_search failed: subprocess failed to spawn/);
  assert.deepEqual(result.toolsUsed, []);
});

test("handleChat() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleChat("hello", {
        ...baseDeps,
        decide: async (request) =>
          request.decision_kind === "model_selection"
            ? {
                decision_id: "d1",
                selected_candidate_id: null,
                requires_human_approval: false,
                ranking: [],
                excluded: [{ id: "gemma4-12b", reason: "denied" }],
                technique_used: "topsis",
                policy_version: "1",
              }
            : noToolsDecision(),
        completeByProvider: {},
        toolExecutors: {},
      }),
    /MADE returned no eligible candidate/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — current `handleChat` doesn't call `tool_selection`, doesn't accept `availableToolCandidates`/`toolExecutors`, and the provider function signature in `defaultDeps` no longer matches.

- [ ] **Step 3: Rewrite chat orchestration**

Replace `src/chat.ts`:

```typescript
import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates, availableToolCandidates as defaultAvailableToolCandidates } from "./candidates.ts";
import { complete as ollamaComplete } from "./providers/ollama-client.ts";
import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import { callWebSearch } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TOOL_ITERATIONS = 5;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  availableToolCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
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
  toolExecutors: {
    web_search: (args) => callWebSearch(String(args.query)),
    scrape: (args) => callScrape(String(args.url)),
  },
};

function decideRequest(decisionKind: DecideRequest["decision_kind"], candidates: CandidateIn[]): DecideRequest {
  return {
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: decisionKind,
    candidates,
    policy_set: "default",
  };
}

export async function handleChat(
  message: string,
  deps: ChatDeps = defaultDeps
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const candidates = deps.availableCandidates();

  const modelDecision = await deps.decide(decideRequest("model_selection", candidates));

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
  const toolDecision = await deps.decide(decideRequest("tool_selection", toolCandidates));
  const allowedToolIds = new Set(toolDecision.ranking.map((r) => r.id));
  const tools: ToolDef[] = toolCandidates
    .filter((c) => allowedToolIds.has(c.id))
    .map((c) => TOOL_DEFS[c.id])
    .filter((t): t is ToolDef => Boolean(t));

  const messages: ChatMessage[] = [{ role: "user", content: message }];
  const toolsUsed: string[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await complete(selected.id, messages, tools);

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
      messages.push({ role: "tool", content: toolResult, tool_call_id: call.id, name: call.function.name });
    }
  }

  throw new Error("tool-calling loop exceeded maximum iterations");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests in `tests/chat.test.ts` PASS, and the full suite (all previous tests too) PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: add MADE-gated tool-calling loop to chat orchestration"
```

---

### Task 7: Dockerize the app, SearXNG, Scrapling, and MADE

**Files:**
- Create: `Dockerfile` (ai-workspace)
- Create: `.dockerignore`
- Create: `searxng/settings.yml`
- Create: `docker-compose.yaml`
- Modify: `.env.example`
- Create: `/home/naufa/workspace/MODE/Dockerfile` (sibling repo — see Global Constraints in the design spec: this only adds packaging, no logic changes)

**Interfaces:**
- Consumes: `src/server.ts`'s `PORT` env var (Milestone 1), `MADE_URL`/`SEARXNG_URL`/`SCRAPLING_URL` env vars read by `src/made-client.ts` and the new MCP clients (Tasks 3–4)
- Produces: a working `docker compose up` that starts `app`, `searxng`, `scrapling`, `made`

- [ ] **Step 1: Write the app Dockerfile**

`Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

`.dockerignore`:

```
node_modules
dist
.git
.env
```

- [ ] **Step 3: Write the SearXNG settings override**

`searxng/settings.yml` (SearXNG's default settings disable the JSON API; `mcp-searxng` needs it enabled):

```yaml
use_default_settings: true
server:
  secret_key: "ai-workspace-dev-secret-change-me"
search:
  formats:
    - html
    - json
```

- [ ] **Step 4: Write the MADE Dockerfile in the sibling repo**

`/home/naufa/workspace/MODE/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY core ./core
COPY api ./api
COPY storage ./storage
COPY policies ./policies
COPY config ./config
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 5: Write `docker-compose.yaml`**

`docker-compose.yaml`:

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      MADE_URL: http://made:8000
      SEARXNG_URL: http://searxng:8080
      SCRAPLING_URL: http://scrapling:8000/mcp
      OLLAMA_BASE_URL: http://host.docker.internal:11434
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      DEEPSEEK_BASE_URL: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - searxng
      - scrapling
      - made

  searxng:
    image: searxng/searxng:latest
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    ports:
      - "8080:8080"

  scrapling:
    image: python:3.12-slim
    command: sh -c "pip install --no-cache-dir 'scrapling[ai]' && scrapling mcp --http --host 0.0.0.0 --port 8000"
    ports:
      - "8000:8000"

  made:
    build: ../MODE
    ports:
      - "8001:8000"
```

- [ ] **Step 6: Add compose-related env vars to `.env.example`**

Append to `.env.example`:

```
SEARXNG_URL=http://searxng:8080
SCRAPLING_URL=http://scrapling:8000/mcp
```

- [ ] **Step 7: Validate the compose file parses**

Run: `docker compose config --quiet`
Expected: no output, exit code 0 (confirms YAML is valid and all `build`/`image` references resolve).

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore searxng/settings.yml docker-compose.yaml .env.example
git commit -m "feat: dockerize app, SearXNG, Scrapling, and MADE via docker-compose"
cd /home/naufa/workspace/MODE && git add Dockerfile && git commit -m "feat: add Dockerfile for containerized deployment"
```

---

### Task 8: Manual end-to-end verification against the running compose stack

No new files — proves the whole chain works for real, not just against mocks (same lesson Milestone 1 caught a real bug with).

- [ ] **Step 1: Bring the stack up**

In `/home/naufa/workspace/ai-workspace`:

Run: `docker compose up --build`
Expected: all four services (`app`, `searxng`, `scrapling`, `made`) start without crash-looping. `scrapling` will take longer on first start (installing `scrapling[ai]`).

- [ ] **Step 2: Confirm Ollama is reachable from inside the app container**

Ensure `ollama serve` is running on the host first (`curl http://localhost:11434/api/tags`).

Run: `docker compose exec app wget -qO- http://host.docker.internal:11434/api/tags`
Expected: JSON listing `gemma4:12b` — confirms the `extra_hosts` bridge works.

- [ ] **Step 3: Send a chat message that should NOT trigger a tool call**

Run: `curl -s -X POST http://localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Say hello in one sentence."}'`
Expected: JSON reply with `"toolsUsed":[]` and a real generated `reply`.

- [ ] **Step 4: Send a chat message that SHOULD trigger `web_search`**

Run: `curl -s -X POST http://localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Search the web for today'\''s top Hacker News story title."}'`
Expected: JSON reply with `"toolsUsed":["web_search"]` and a reply that references real search results (not a hallucinated guess) — confirms `mcp-searxng` successfully reached the `searxng` container and results made it back through the tool loop.

- [ ] **Step 5: Record the result**

If any step fails, fix the root cause (check `docker compose logs app`, `docker compose logs searxng`, `docker compose logs scrapling`) before considering Milestone 2 done — do not proceed to Milestone 3 on an integration that only works in mocks.
