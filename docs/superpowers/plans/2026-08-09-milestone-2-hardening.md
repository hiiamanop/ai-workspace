# Milestone 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address every item deferred at Milestone 2's final review (tool-result truncation, scrape URL validation, UI tool visibility, `.env.example` clarity, offline-safe `mcp-searxng` resolution, graceful tool-loop exhaustion) plus bind the app's own docker port to loopback like the other services.

**Architecture:** Pure hardening of existing Milestone-2 code — no new files except tests, no new architecture. Two logic changes land in `src/chat.ts` (the tool loop) and `src/mcp/scrapling-client.ts` (URL validation); the rest are small, mostly untestable-by-nature polish edits (HTML, env comments, a dependency pin, a docker port binding).

**Tech Stack:** Same as Milestone 2 — Node.js 22+, TypeScript, `tsx`, `node:test`, `@modelcontextprotocol/sdk`, Docker Compose.

## Global Constraints

- No new runtime dependencies except `mcp-searxng` itself (Task 3) — it was already an implicit runtime dependency (resolved via `npx -y` at every call), this only makes it explicit and pre-installed.
- Follow the existing dependency-injection pattern (`connect`/`deps` parameters with real defaults) — do not introduce global mutable state or module-level singletons.
- All new logic needs a covering `node:test` test using the existing fake-injection style (no real subprocess/network calls in unit tests).
- Full suite must stay green (`npm test`) and `npm run build` (tsc) must stay clean after every task.

---

### Task 1: Robustness fixes to the tool-calling loop (truncation + graceful exhaustion)

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

**Interfaces:**
- Produces: `truncateToolResult(result: string): string` (private helper, not exported) in `src/chat.ts`
- `handleChat`'s return type and thrown-error contract are unchanged in the general case; only the iteration-cap behavior changes (see below)

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat.test.ts`:

```typescript
test("handleChat() truncates tool results longer than 8000 chars before feeding them back to the model", async () => {
  const longResult = "x".repeat(9000);
  let capturedToolContent = "";
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
        capturedToolContent = toolMessage?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => longResult,
    },
  };

  await handleChat("search something huge", deps);

  assert.equal(capturedToolContent.length, 8000 + "...[truncated, 9000 chars total]".length);
  assert.ok(capturedToolContent.startsWith("x".repeat(8000)));
  assert.ok(capturedToolContent.endsWith("...[truncated, 9000 chars total]"));
});

test("handleChat() does not alter tool results at or under 8000 chars", async () => {
  const shortResult = "y".repeat(8000);
  let capturedToolContent = "";
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
        capturedToolContent = toolMessage?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => shortResult,
    },
  };

  await handleChat("search something", deps);

  assert.equal(capturedToolContent, shortResult);
});

test("handleChat() returns the last non-empty content with a note when the tool loop hits the iteration cap", async () => {
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial thought",
        toolCalls: [{ id: "call_x", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => "result",
    },
  };

  const result = await handleChat("loop forever", deps);

  assert.equal(result.reply, "partial thought\n\n[tool loop limit reached — response may be incomplete]");
});

test("handleChat() still throws when the tool loop hits the iteration cap with no content ever produced", async () => {
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_x", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => "result",
    },
  };

  await assert.rejects(() => handleChat("loop forever", deps), /tool-calling loop exceeded maximum iterations/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the 4 new tests FAIL — truncation isn't implemented and the iteration cap always throws.

- [ ] **Step 3: Implement the fixes**

Replace `src/chat.ts` in full:

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
const MAX_TOOL_RESULT_CHARS = 8000;

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

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}...[truncated, ${result.length} chars total]`;
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
  if (toolDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }
  const allowedToolIds = new Set(toolDecision.ranking.map((r) => r.id));
  const tools: ToolDef[] = toolCandidates
    .filter((c) => allowedToolIds.has(c.id))
    .map((c) => TOOL_DEFS[c.id])
    .filter((t): t is ToolDef => Boolean(t));

  const messages: ChatMessage[] = [{ role: "user", content: message }];
  const toolsUsed: string[] = [];
  let lastNonEmptyContent: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests in `tests/chat.test.ts` PASS (29/29: the 25 existing plus 4 new).

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: clean, no tsc errors.

- [ ] **Step 6: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "fix: truncate large tool results and degrade gracefully on tool-loop exhaustion"
```

---

### Task 2: Validate URLs before calling `scrape`

**Files:**
- Modify: `src/mcp/scrapling-client.ts`
- Modify: `tests/mcp/scrapling-client.test.ts`

**Interfaces:**
- Produces: no new exports — `callScrape`'s signature is unchanged, it now throws synchronously (before connecting) for a disallowed URL.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp/scrapling-client.test.ts`:

```typescript
test("callScrape() rejects non-http(s) schemes without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("ftp://example.com/file", fakeConnect), /unsupported scheme/);
  assert.equal(connected, false);
});

test("callScrape() rejects an invalid URL string without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("not a url", fakeConnect), /not a valid URL/);
  assert.equal(connected, false);
});

test("callScrape() rejects URLs targeting internal service hostnames without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://searxng:8080/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://made:8000/decide", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://localhost/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://host.docker.internal/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});

test("callScrape() rejects URLs targeting private IPv4 ranges without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://192.168.1.5/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://10.0.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://172.16.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://127.0.0.1/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the 4 new tests FAIL — no validation exists yet, so `callScrape` proceeds to call `fakeConnect` (making `connected` true) instead of throwing.

- [ ] **Step 3: Implement URL validation**

Replace `src/mcp/scrapling-client.ts` in full:

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

const BLOCKED_HOSTNAMES = new Set([
  "searxng",
  "scrapling",
  "made",
  "host.docker.internal",
  "localhost",
]);

function isPrivateIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function assertUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`scrape refused: "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`scrape refused: unsupported scheme "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateIPv4(hostname)) {
    throw new Error("scrape refused: URL targets an internal/private host");
  }
}

// Uses Scrapling's browser-rendered "fetch" tool (full page, not the raw
// "get" tool) since our web_search tool already covers plain HTTP lookups.
export async function callScrape(
  url: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  assertUrlAllowed(url);
  const connection = await connect();
  try {
    return await connection.callTool("fetch", { url });
  } finally {
    await connection.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests in `tests/mcp/scrapling-client.test.ts` PASS (5/5: 1 existing + 4 new).

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: clean, no tsc errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/scrapling-client.ts tests/mcp/scrapling-client.test.ts
git commit -m "fix: reject scrape URLs targeting internal/private hosts"
```

---

### Task 3: Pre-install `mcp-searxng`, avoid per-call registry resolution

**Files:**
- Modify: `package.json`
- Modify: `src/mcp/searxng-client.ts`

**Interfaces:**
- No signature changes — `callWebSearch`'s behavior is identical from the caller's perspective; only how the subprocess is resolved changes.

- [ ] **Step 1: Add `mcp-searxng` as a regular dependency**

Run: `npm install mcp-searxng`
Expected: `package.json`'s `dependencies` gains `"mcp-searxng"` (alongside the existing `@modelcontextprotocol/sdk`), and `package-lock.json` updates. `node_modules/mcp-searxng` now exists locally.

- [ ] **Step 2: Drop the `-y` auto-confirm flag**

In `src/mcp/searxng-client.ts`, change the `StdioClientTransport` args from:

```typescript
    args: ["-y", "mcp-searxng"],
```

to:

```typescript
    args: ["mcp-searxng"],
```

`-y` exists to auto-confirm installing a package `npx` can't find locally — now that `mcp-searxng` is a declared dependency, `npx` resolves it directly from `node_modules/.bin` with no registry round-trip and no confirmation prompt needed.

- [ ] **Step 3: Run the existing tests to confirm no regression**

Run: `npm test`
Expected: `tests/mcp/searxng-client.test.ts` still PASSES unchanged — its tests inject a fake `connect` and never exercise `defaultConnect`'s actual spawn args, so this change isn't visible to the unit tests. This is expected; Task 4's manual docker verification is what actually proves the new behavior.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: clean, no tsc errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/mcp/searxng-client.ts
git commit -m "fix: pre-install mcp-searxng to avoid a registry round-trip on every web_search call"
```

---

### Task 4: UI tool visibility, `.env.example` clarity, docker port binding, and final verification

**Files:**
- Modify: `public/index.html`
- Modify: `.env.example`
- Modify: `docker-compose.yaml`

**Interfaces:**
- No code interfaces — these are presentation/config changes verified manually, not by `node:test`.

- [ ] **Step 1: Show `toolsUsed` in the chat UI**

In `public/index.html`, replace this line inside the `form.addEventListener` handler:

```javascript
      log.textContent += `[${body.selectedCandidateId}] ${body.reply}\n\n`;
```

with:

```javascript
      let line = `[${body.selectedCandidateId}] ${body.reply}\n`;
      if (body.toolsUsed && body.toolsUsed.length > 0) {
        line += `[tools: ${body.toolsUsed.join(", ")}]\n`;
      }
      log.textContent += line + "\n";
```

- [ ] **Step 2: Clarify `.env.example`**

Replace `.env.example` in full:

```
# Docker (docker compose up) — active values below, this is the primary supported path
MADE_URL=http://made:8000
SEARXNG_URL=http://searxng:8080
SCRAPLING_URL=http://scrapling:8000/mcp
OLLAMA_BASE_URL=http://host.docker.internal:11434

# Bare `npm run dev` (no docker) — comment out the block above and uncomment this instead
# MADE_URL=http://localhost:8000
# SEARXNG_URL=http://localhost:8080
# SCRAPLING_URL=http://localhost:8000/mcp
# OLLAMA_BASE_URL=http://localhost:11434

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

- [ ] **Step 3: Bind the app's docker port to loopback**

In `docker-compose.yaml`, change the `app` service's port mapping from:

```yaml
    ports:
      - "3000:3000"
```

to:

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

- [ ] **Step 4: Commit the config changes**

```bash
git add public/index.html .env.example docker-compose.yaml
git commit -m "chore: show toolsUsed in UI, clarify .env.example, bind app port to loopback"
```

- [ ] **Step 5: Run the full test suite one more time**

Run: `npm test`
Expected: full suite PASSES (29/29, per Tasks 1-2's additions).

- [ ] **Step 6: Manual end-to-end verification against the running stack**

This proves Tasks 1-4 work together against real services, not just mocks — same practice as Milestone 2's own manual verification.

- [ ] **Step 6a: Start the stack**

Run (from the repo root): `cp .env.example .env` then `docker compose up --build -d`
Expected: all 4 services (`app`, `searxng`, `scrapling`, `made`) come up. Ensure `ollama serve` is running on the host first.

- [ ] **Step 6b: Confirm port 3000 is loopback-only**

Run: `docker compose port app 3000`
Expected: output shows `127.0.0.1:3000` (not `0.0.0.0:3000`).

- [ ] **Step 6c: Confirm the offline-safe `mcp-searxng` resolution**

Run: `docker compose exec app sh -c "SEARXNG_URL=http://searxng:8080 npx mcp-searxng 2>&1 & sleep 2; kill %1 2>/dev/null; wait"`
Expected: log line `"MCP SearXNG Server v... connected via STDIO"` appears quickly (no npm-registry fetch delay, since it resolves from `node_modules` directly).

- [ ] **Step 6d: Confirm truncation + graceful degradation don't break a normal request**

Run: `curl -s --max-time 90 -X POST http://127.0.0.1:3000/api/chat -H 'content-type: application/json' -d '{"message":"Use the web_search tool to search for \"OpenAI GPT-5 release\" and summarize the first result in one sentence."}'`
Expected: a normal JSON response with `toolsUsed: ["web_search"]` and a coherent `reply` — same as Milestone 2's own passing manual check, confirming truncation logic didn't break the common case (result well under 8000 chars).

- [ ] **Step 6e: Confirm scrape URL validation blocks an internal target**

Run: `docker compose exec app sh -c "node -e \"import('./dist/mcp/scrapling-client.js').then(m=>m.callScrape('http://searxng:8080/').then(()=>console.log('FAIL: should have thrown')).catch(e=>console.log('OK:', e.message)))\""`
Expected: `OK: scrape refused: URL targets an internal/private host`.

- [ ] **Step 6f: Open the browser UI and confirm tool visibility**

Open `http://127.0.0.1:3000`, send "Use the web_search tool to search for today's weather in Jakarta."
Expected: the reply includes a `[tools: web_search]` line beneath it.

- [ ] **Step 6g: Tear down**

Run: `docker compose down`

- [ ] **Step 7: Record the result**

If any step in 6a-6f fails, fix the root cause before considering this hardening pass done — do not leave a chain that only works in mocks.
