# Inline Web-Search Citations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show ChatGPT-style inline citation chips (`[N]` → clickable favicon chip → source-card popover) for `web_search` results, in both the root project's chat (`localhost:3000/`) and GenOffice's document AI panel (`/document`) — and, as part of the same change, fix GenOffice's `web_search` tool so it actually reaches SearXNG instead of failing with `"not available in the web build"`.

**Architecture:** `mcp-searxng` is asked for `response_format: "json"` so search results come back structured (title/url/snippet/date) instead of pre-formatted text. Both `src/chat.ts` and `src/agent-turn.ts` format that structured data into a numbered, citable tool-result string (running counter across all `web_search` calls in one turn) and emit the raw structured list to the client over a new `"sources"` stream event. `ChatApp.tsx` and GenOffice's `AiPanel.tsx` both turn `[N]` markers in the rendered markdown into inline chips backed by that same structured list. GenOffice's `desktop-stub.ts` — the thing currently hard-failing — is pointed at a new `POST /api/web-search` endpoint on the root server instead of Electron IPC.

**Tech Stack:** TypeScript, Node's built-in `node:test`, `mcp-searxng` (already a dependency), `marked` + `dompurify` (already dependencies of the root client), GenOffice's existing dependency-free `@genoffice/ui` `Markdown` component (no new dependencies anywhere in this plan).

## Global Constraints

- No new npm dependencies, in either the root project or `genoffice/`.
- `image_search` is untouched — it keeps failing in the web build; only `web_search` is fixed.
- Citations are never persisted (matches the project's existing no-DB-layer state). Reloaded/historic chat entries render `[N]` as plain text, not chips — this is expected, not a bug.
- Each `[N]` marker renders as its own independent chip. Adjacent `[1][2]` render as two small chips side by side — there is no merged "+1" badge and no carousel/arrow navigation, in either UI (confirmed with the user; this is a deliberate scope-down from the reference screenshot).
- A citation number with no matching source (hallucinated `[7]` against 3 real results) renders as plain text, never a broken chip.
- `mcp-searxng`'s `searxng_web_search` tool accepts `num_results` (integer, 1–20) and `response_format` (`"text"` default, `"json"` for structured output) as call arguments — confirmed by reading `node_modules/mcp-searxng/dist/types.js` and `dist/index.js` in this repo. `response_format: "json"` returns `JSON.stringify({...data, results: [...]})` where each result has `title`, `content`, `url`, and (often absent) `publishedDate`; a top-level `answers: string[]` array holds SearXNG's "direct answer" when present.

---

### Task 1: Structured SearXNG results + citation formatter

**Files:**
- Modify: `src/mcp/searxng-client.ts`
- Modify: `tests/mcp/searxng-client.test.ts`
- Create: `src/web-search-format.ts`
- Create: `tests/web-search-format.test.ts`

**Interfaces:**
- Produces: `WebSearchResult { title: string; url: string; snippet: string; publishedDate?: string }`, `WebSearchResponse { results: WebSearchResult[]; answer?: string }`, both exported from `src/mcp/searxng-client.ts`.
- Produces: `callWebSearch(query: string, maxResults?: number, connect?: () => Promise<McpToolConnection>): Promise<WebSearchResponse>` (signature change — `maxResults` is a new second parameter; the `connect` override moves to third position).
- Produces: `formatWebSearchResults(response: WebSearchResponse, offset: number): string` from `src/web-search-format.ts`, used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests for `callWebSearch()`**

Replace the full contents of `tests/mcp/searxng-client.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { callWebSearch } from "../../src/mcp/searxng-client.ts";

const SAMPLE_JSON = JSON.stringify({
  results: [
    { title: "First Result", url: "https://example.com/a", content: "Snippet A", publishedDate: "2024-01-01" },
    { title: "Second Result", url: "https://example.com/b", content: "Snippet B" },
  ],
  answers: ["The direct answer"],
});

test("callWebSearch() calls searxng_web_search with query + json response_format, parses structured results, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return SAMPLE_JSON;
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callWebSearch("weather in Jakarta", undefined, fakeConnect);

  assert.equal(capturedName, "searxng_web_search");
  assert.deepEqual(capturedArgs, { query: "weather in Jakarta", response_format: "json" });
  assert.deepEqual(result, {
    results: [
      { title: "First Result", url: "https://example.com/a", snippet: "Snippet A", publishedDate: "2024-01-01" },
      { title: "Second Result", url: "https://example.com/b", snippet: "Snippet B" },
    ],
    answer: "The direct answer",
  });
  assert.equal(closed, true);
});

test("callWebSearch() passes num_results when maxResults is given", async () => {
  let capturedArgs: unknown = null;
  const fakeConnect = async () => ({
    callTool: async (_name: string, args: Record<string, unknown>) => {
      capturedArgs = args;
      return SAMPLE_JSON;
    },
    close: async () => {},
  });

  await callWebSearch("query", 3, fakeConnect);

  assert.deepEqual(capturedArgs, { query: "query", response_format: "json", num_results: 3 });
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

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /boom/);
  assert.equal(closed, true);
});

test("callWebSearch() throws when the tool returns non-JSON text", async () => {
  const fakeConnect = async () => ({
    callTool: async () => "not json at all",
    close: async () => {},
  });

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /searxng returned non-JSON response/);
});

test("callWebSearch() throws when the parsed JSON has no results array", async () => {
  const fakeConnect = async () => ({
    callTool: async () => JSON.stringify({ answers: [] }),
    close: async () => {},
  });

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /searxng response missing results array/);
});

test("callWebSearch() omits the answer field when there are no answers", async () => {
  const fakeConnect = async () => ({
    callTool: async () => JSON.stringify({ results: [] }),
    close: async () => {},
  });

  const result = await callWebSearch("x", undefined, fakeConnect);

  assert.deepEqual(result, { results: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="callWebSearch"` (or `node --import tsx --test tests/mcp/searxng-client.test.ts`)
Expected: FAIL — `callWebSearch` still has the old `(query, connect)` signature and returns a raw string, so both the call-argument assertions and the `deepEqual` structured-result assertions fail.

- [ ] **Step 3: Implement structured `callWebSearch()`**

Replace the full contents of `src/mcp/searxng-client.ts` with:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  answer?: string;
}

async function defaultConnect(): Promise<McpToolConnection> {
  const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["mcp-searxng"],
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

interface RawSearxngResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
}

interface RawSearxngResponse {
  results?: unknown;
  answers?: unknown;
}

function parseSearxngJson(raw: string): WebSearchResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`searxng returned non-JSON response: ${raw.slice(0, 200)}`);
  }
  const data = parsed as RawSearxngResponse;
  if (!Array.isArray(data.results)) {
    throw new Error("searxng response missing results array");
  }
  const results: WebSearchResult[] = (data.results as RawSearxngResult[]).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
    ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
  }));
  const answers = Array.isArray(data.answers) ? (data.answers as unknown[]).map(String) : [];
  return {
    results,
    ...(answers.length > 0 ? { answer: answers.join(" ") } : {}),
  };
}

// ponytail: spawns a fresh mcp-searxng subprocess per call — simplest thing
// that works for low-frequency chat tool calls. Upgrade to a persistent
// pooled connection if subprocess startup latency becomes measurable.
export async function callWebSearch(
  query: string,
  maxResults?: number,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<WebSearchResponse> {
  const connection = await connect();
  try {
    const raw = await connection.callTool("searxng_web_search", {
      query,
      response_format: "json",
      ...(maxResults !== undefined ? { num_results: maxResults } : {}),
    });
    return parseSearxngJson(raw);
  } finally {
    await connection.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/mcp/searxng-client.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Write the failing test for `formatWebSearchResults()`**

Create `tests/web-search-format.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWebSearchResults } from "../src/web-search-format.ts";

test("formatWebSearchResults() numbers results starting at offset + 1", () => {
  const text = formatWebSearchResults(
    {
      results: [
        { title: "First", url: "https://a.example", snippet: "snippet a" },
        { title: "Second", url: "https://b.example", snippet: "snippet b", publishedDate: "2024-01-01" },
      ],
    },
    0
  );

  assert.equal(
    text,
    "[1] First\n    snippet a\n    https://a.example\n\n[2] Second — 2024-01-01\n    snippet b\n    https://b.example"
  );
});

test("formatWebSearchResults() continues numbering from a non-zero offset", () => {
  const text = formatWebSearchResults(
    { results: [{ title: "Third", url: "https://c.example", snippet: "snippet c" }] },
    2
  );

  assert.match(text, /^\[3\] Third/);
});

test("formatWebSearchResults() prepends the direct answer when present", () => {
  const text = formatWebSearchResults(
    { results: [{ title: "Only", url: "https://a.example", snippet: "s" }], answer: "42" },
    0
  );

  assert.ok(text.startsWith("Direct answer: 42\n\n[1] Only"));
});

test("formatWebSearchResults() returns a placeholder when there are no results", () => {
  const text = formatWebSearchResults({ results: [] }, 0);

  assert.equal(text, "(no results)");
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --import tsx --test tests/web-search-format.test.ts`
Expected: FAIL — `src/web-search-format.ts` does not exist yet.

- [ ] **Step 7: Implement `formatWebSearchResults()`**

Create `src/web-search-format.ts`:

```ts
import type { WebSearchResponse } from "./mcp/searxng-client.ts";

export function formatWebSearchResults(response: WebSearchResponse, offset: number): string {
  const lines: string[] = [];
  if (response.answer) {
    lines.push(`Direct answer: ${response.answer}`);
  }
  response.results.forEach((r, i) => {
    const n = offset + i + 1;
    const dateSuffix = r.publishedDate ? ` — ${r.publishedDate}` : "";
    lines.push(`[${n}] ${r.title}${dateSuffix}\n    ${r.snippet}\n    ${r.url}`);
  });
  return lines.join("\n\n") || "(no results)";
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --import tsx --test tests/web-search-format.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add src/mcp/searxng-client.ts src/web-search-format.ts tests/mcp/searxng-client.test.ts tests/web-search-format.test.ts
git commit -m "feat: structured SearXNG results + numbered citation formatter"
```

---

### Task 2: `src/chat.ts` — citation instruction, numbered results, `onSources`

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `WebSearchResponse`, `WebSearchResult` from `src/mcp/searxng-client.ts` (Task 1); `formatWebSearchResults` from `src/web-search-format.ts` (Task 1).
- Produces: `ChatDeps.webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>` (new required field, replaces the `web_search` entry that used to live in `ChatDeps.toolExecutors`). `ChatStreamCallbacks.onSources?: (results: WebSearchResult[]) => void` (new optional field).

- [ ] **Step 1: Add the citation instruction to the tool description**

In `src/tools.ts`, change the `web_search` entry's `description`:

```ts
export const TOOL_DEFS: Record<string, ToolDef> = {
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. Results are numbered; when you state a fact drawn from a result, cite it immediately after the sentence using its number in brackets, e.g. [1] or [1][2] for multiple sources.",
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

(Only the `web_search` description string changed; `scrape` is unchanged.)

- [ ] **Step 2: Rewrite `tests/chat.test.ts`'s `web_search`-related tests to use `webSearchExecutor`**

`chat.test.ts` currently configures the mock web search behavior via `toolExecutors.web_search`. That entry moves to a new required `webSearchExecutor` field on every test's `deps`. Apply these changes to the existing file:

1. Add `webSearchExecutor: async () => { throw new Error("should not be called"); },` to the shared `baseDeps` object (near the top of the file, alongside `availableCandidates`/`availableToolCandidates`) — most tests never call it, so a throwing stub is the safe default; individual tests override it.

2. In `"handleChat() executes a requested tool call and feeds the result back to the model"`: replace
   ```ts
   toolExecutors: {
     web_search: async (args) => `search results for ${args.query}`,
   },
   ```
   with (dropping the `web_search` key from `toolExecutors` entirely — `toolExecutors: {}`):
   ```ts
   toolExecutors: {},
   webSearchExecutor: async (query) => ({
     results: [{ title: "Jakarta Weather", url: "https://example.com/jakarta", snippet: `search results for ${query}` }],
   }),
   ```
   and update the final assertion from
   ```ts
   assert.equal(result.reply, "final reply using: search results for jakarta weather");
   ```
   to
   ```ts
   assert.equal(
     result.reply,
     "final reply using: [1] Jakarta Weather\n    search results for jakarta weather\n    https://example.com/jakarta"
   );
   ```

3. In `"handleChat() feeds an error string back to the model when a tool executor throws"`: replace
   ```ts
   toolExecutors: {
     web_search: async () => {
       throw new Error("subprocess failed to spawn");
     },
   },
   ```
   with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => {
     throw new Error("subprocess failed to spawn");
   },
   ```
   The assertion (`assert.match(result.reply, /handled: web_search failed: subprocess failed to spawn/)`) stays unchanged — the error text format is preserved.

4. In `"handleChat() throws when MADE selects no candidate"`, `"...throws when MADE requires human approval"`, and `"...throws when MADE requires human approval for tool_selection"`: each currently passes `toolExecutors: {}` inline (not via `baseDeps` spread) — add `webSearchExecutor: async () => { throw new Error("should not be called"); },` alongside each.

5. In `"handleChat() switches to a different candidate mid-loop..."`: replace
   ```ts
   toolExecutors: {
     web_search: async () => "x".repeat(1000),
   },
   ```
   with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
   ```
   and update the comment above the assertions from
   ```ts
   // iteration 0 estimate for this exact message/tool shape is 1115 (fits 1200, no switch yet);
   // after the first tool round-trip, iteration 1's estimate is 1417 (exceeds 1200, triggers the switch).
   ```
   to
   ```ts
   // iteration 0 estimate for this exact message/tool shape is 1159 (fits 1200, no switch yet);
   // after the first tool round-trip, iteration 1's estimate is 1465 (exceeds 1200, triggers the switch).
   ```
   (The numbers changed because the tool description grew and the tool-result text is now the numbered citation format instead of a raw string; the switch behavior itself — asserted via `modelDecideCalls`/`selectedCandidateId`/reply prefix, not the raw numbers — is unaffected. These exact values were computed by simulating `estimateContextTokens` against this task's actual new code.)

6. In `"handleChat() returns the last non-empty content with a note when MADE finds no candidate that fits mid-loop"`: replace
   ```ts
   toolExecutors: {
     web_search: async () => "x".repeat(1000),
   },
   ```
   with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
   ```
   (No assertions reference exact token numbers in this test — unchanged otherwise.)

7. In `"handleChat() truncates tool results longer than 8000 chars..."` and `"...does not alter tool results at or under 8000 chars"`: replace
   ```ts
   toolExecutors: {
     web_search: async () => longResult,
   },
   ```
   (and the `shortResult` equivalent) with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: longResult }] }),
   ```
   (respectively `shortResult`). The formatted tool text becomes `[1] \n    ${longResult}\n    ` (title/url empty) instead of `longResult` verbatim — update the surrounding assertions:
   ```ts
   assert.equal(capturedToolContent.length, 8000 + "...[truncated, 9000 chars total]".length);
   assert.ok(capturedToolContent.startsWith("x".repeat(8000)));
   assert.ok(capturedToolContent.endsWith("...[truncated, 9000 chars total]"));
   ```
   becomes (the formatted text is `"[1] \n    " + longResult + "\n    "`, which is `9 + 9000 + 5 = 9014` chars before truncation):
   ```ts
   const formatted = `[1] \n    ${longResult}\n    `;
   assert.equal(capturedToolContent.length, 8000 + `...[truncated, ${formatted.length} chars total]`.length);
   assert.ok(capturedToolContent.startsWith(formatted.slice(0, 8000)));
   assert.ok(capturedToolContent.endsWith(`...[truncated, ${formatted.length} chars total]`));
   ```
   and for the short-result test:
   ```ts
   assert.equal(capturedToolContent, shortResult);
   ```
   becomes
   ```ts
   assert.equal(capturedToolContent, `[1] \n    ${shortResult}\n    `);
   ```
   Note `shortResult` (8000 chars) plus the `"[1] \n    "` / `"\n    "` wrapper now totals more than 8000 chars, so it WILL be truncated — move this test's `shortResult` to `"y".repeat(7980)` so the wrapped total (`9 + 7980 + 5 = 7994`) stays at or under 8000 and the "not altered" assertion is still meaningful; update the `assert.ok`/length reasoning accordingly:
   ```ts
   const shortResult = "y".repeat(7980);
   ```

8. In `"handleChat() returns the last non-empty content with a note when the tool loop hits the iteration cap"` and `"...still throws when the tool loop hits the iteration cap with no content ever produced"`: replace
   ```ts
   toolExecutors: {
     web_search: async () => "result",
   },
   ```
   with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "R", url: "https://x.example", snippet: "result" }] }),
   ```
   (No assertions reference the tool-result text directly in either test — unchanged otherwise.)

9. In `"handleChat() does not split a surrogate pair when truncating a tool result"`: replace
   ```ts
   toolExecutors: {
     web_search: async () => longResult,
   },
   ```
   with
   ```ts
   toolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: longResult }] }),
   ```
   and update the surrogate-pair boundary assertions the same way as step 7 — the formatted text is `` `[1] \n    ${longResult}\n    ` ``, so the emoji's position shifts by the 9-character `"[1] \n    "` prefix. Replace:
   ```ts
   const markerIndex = capturedToolContent.indexOf("...[truncated");
   const truncatedPortion = capturedToolContent.slice(0, markerIndex);

   assert.equal(truncatedPortion, "x".repeat(7999));
   assert.equal(truncatedPortion.length, 7999);
   assert.ok(capturedToolContent.endsWith(`...[truncated, ${longResult.length} chars total]`));
   ```
   with:
   ```ts
   const formatted = `[1] \n    ${longResult}\n    `;
   const markerIndex = capturedToolContent.indexOf("...[truncated");
   const truncatedPortion = capturedToolContent.slice(0, markerIndex);

   assert.equal(truncatedPortion, formatted.slice(0, 8000));
   assert.equal(truncatedPortion.length, 8000);
   assert.ok(capturedToolContent.endsWith(`...[truncated, ${formatted.length} chars total]`));
   ```
   (The emoji is no longer guaranteed to land exactly at the truncation boundary once shifted by the 9-char prefix — this test's original intent, "don't split a surrogate pair," is preserved by `truncateToolResult`'s own boundary-detection logic regardless of where the emoji falls, so asserting the exact sliced prefix is sufficient; the surrogate-pair-safety behavior itself is still exercised because `formatted` still contains the surrogate pair inside the truncated region.)

10. In `"handleChat() calls onToolResult after executing a tool when streaming"`: replace
    ```ts
    toolExecutors: { web_search: async () => "search result" },
    ```
    with
    ```ts
    toolExecutors: {},
    webSearchExecutor: async () => ({ results: [{ title: "R", url: "https://x.example", snippet: "search result" }] }),
    ```
    and update:
    ```ts
    assert.deepEqual(toolResults, [{ index: 0, name: "web_search", result: "search result" }]);
    ```
    to:
    ```ts
    assert.deepEqual(toolResults, [
      { index: 0, name: "web_search", result: "[1] R\n    search result\n    https://x.example" },
    ]);
    ```

- [ ] **Step 3: Add a new test asserting `onSources` fires with the accumulated list**

Add to `tests/chat.test.ts`:

```ts
test("handleChat() calls onSources with the accumulated results after each web_search call", async () => {
  let callCount = 0;
  const sourcesSeen: unknown[] = [];
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
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"a"}' } }],
          };
        }
        if (callCount === 2) {
          return {
            content: "",
            toolCalls: [{ id: "call_2", type: "function", function: { name: "web_search", arguments: '{"query":"b"}' } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    },
    toolExecutors: {},
    webSearchExecutor: async (query) => ({ results: [{ title: query, url: `https://${query}.example`, snippet: "s" }] }),
  };

  await handleChat(
    [{ role: "user", content: "search twice" }],
    deps,
    { onDelta: () => {}, onToolCallDelta: () => {}, onToolResult: () => {}, onSources: (results) => sourcesSeen.push(results) }
  );

  assert.deepEqual(sourcesSeen, [
    [{ title: "a", url: "https://a.example", snippet: "s" }],
    [{ title: "a", url: "https://a.example", snippet: "s" }, { title: "b", url: "https://b.example", snippet: "s" }],
  ]);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: FAIL — `ChatDeps` has no `webSearchExecutor` field yet (type error) and `onSources` doesn't exist on `ChatStreamCallbacks`.

- [ ] **Step 5: Implement the `chat.ts` changes**

In `src/chat.ts`:

1. Change the import line:
   ```ts
   import { callWebSearch } from "./mcp/searxng-client.ts";
   ```
   to:
   ```ts
   import { callWebSearch, type WebSearchResponse, type WebSearchResult } from "./mcp/searxng-client.ts";
   import { formatWebSearchResults } from "./web-search-format.ts";
   ```

2. Add `onSources` to `ChatStreamCallbacks`:
   ```ts
   export interface ChatStreamCallbacks {
     onDelta: (text: string) => void;
     onToolCallDelta: (delta: ToolCallDelta) => void;
     onToolResult: (index: number, name: string, result: string) => void;
     onSources?: (results: WebSearchResult[]) => void;
     signal?: AbortSignal;
   }
   ```

3. Change `ChatDeps` and `defaultDeps`:
   ```ts
   export interface ChatDeps {
     decide: (request: DecideRequest) => Promise<DecideResponse>;
     availableCandidates: () => CandidateIn[];
     availableToolCandidates: () => CandidateIn[];
     completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
     completeStreamByProvider?: Record<string, StreamCompleteFn>;
     toolExecutors: Record<string, ToolExecutor>;
     webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>;
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
       scrape: (args) => callScrape(String(args.url)),
     },
     webSearchExecutor: (query, maxResults) => callWebSearch(query, maxResults),
   };
   ```

4. Replace the tool-execution loop body (the `for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) { ... }` loop's tool-calling section, currently the `messages.push({ role: "assistant", ... })` line through the closing of the `for (const [index, call] of result.toolCalls.entries())` loop) with:
   ```ts
     messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

     for (const [index, call] of result.toolCalls.entries()) {
       let toolResult: string;
       if (call.function.name === "web_search") {
         try {
           const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
           const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
           const response = await deps.webSearchExecutor(String(args.query ?? ""), maxResults);
           toolResult = formatWebSearchResults(response, citationOffset);
           citationOffset += response.results.length;
           allSources.push(...response.results);
           streamCallbacks?.onSources?.(allSources.slice());
           toolsUsed.push("web_search");
         } catch (err) {
           toolResult = `web_search failed: ${(err as Error).message}`;
         }
       } else {
         const executor = deps.toolExecutors[call.function.name];
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
       }
       streamCallbacks?.onToolResult(index, call.function.name, toolResult);
       messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
     }
   }
   ```

5. Just above the `for (let i = 0; i < MAX_TOOL_ITERATIONS; i++)` loop, alongside the existing `const toolsUsed: string[] = []; let lastNonEmptyContent: string | null = null;` line, add:
   ```ts
   let citationOffset = 0;
   const allSources: WebSearchResult[] = [];
   ```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test tests/chat.test.ts`
Expected: PASS (all tests, including the new `onSources` test)

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/chat.ts tests/chat.test.ts
git commit -m "feat: numbered web_search citations + onSources callback in chat.ts"
```

---

### Task 3: `src/agent-turn.ts` — same treatment as `chat.ts`

**Files:**
- Modify: `src/agent-turn.ts`
- Modify: `tests/agent-turn.test.ts`

**Interfaces:**
- Consumes: same as Task 2, plus `formatWebSearchResults`, `WebSearchResponse`, `WebSearchResult` from Task 1.
- Produces: `AgentTurnDeps.webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>` (new required field, replaces the `web_search` entry in `AgentTurnDeps.serverToolExecutors`). `AgentTurnStreamCallbacks.onSources?: (results: WebSearchResult[]) => void`.

- [ ] **Step 1: Rewrite `tests/agent-turn.test.ts`'s `web_search`-related tests to use `webSearchExecutor`**

Apply these changes to the existing file:

1. In `"handleAgentTurn() executes web_search/scrape internally and loops without surfacing them"`: replace
   ```ts
   serverToolExecutors: {
     web_search: async (args) => `results for ${args.query}`,
   },
   ```
   with
   ```ts
   serverToolExecutors: {},
   webSearchExecutor: async (query) => ({ results: [{ title: "R", url: "https://x.example", snippet: `results for ${query}` }] }),
   ```
   and update:
   ```ts
   assert.deepEqual(result, { type: "text", text: "answer using: results for weather" });
   ```
   to:
   ```ts
   assert.deepEqual(result, {
     type: "text",
     text: "answer using: [1] R\n    results for weather\n    https://x.example",
   });
   ```

2. In `"handleAgentTurn() switches to a different candidate mid-loop..."`: replace
   ```ts
   serverToolExecutors: {
     web_search: async () => "x".repeat(1000),
   },
   ```
   with
   ```ts
   serverToolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
   ```
   update the assertion:
   ```ts
   assert.deepEqual(result, { type: "text", text: `answered by deepseek using: ${"x".repeat(1000)}` });
   ```
   to:
   ```ts
   assert.deepEqual(result, {
     type: "text",
     text: `answered by deepseek using: [1] \n    ${"x".repeat(1000)}\n    `,
   });
   ```
   and update the comment above from
   ```ts
   // iteration 0 estimate for baseRequest's exact shape is 1156 (fits 1300, no switch yet);
   // after the first server-tool round-trip, iteration 1's estimate is 1458 (exceeds 1300, triggers the switch).
   ```
   to
   ```ts
   // iteration 0 estimate for baseRequest's exact shape is 1200 (fits 1300, no switch yet);
   // after the first server-tool round-trip, iteration 1's estimate is 1509 (exceeds 1300, triggers the switch).
   ```
   (Recomputed the same way as Task 2's equivalent test — the tool description grew and the tool-result text format changed; the threshold `1300` still fits iteration 0 and is exceeded at iteration 1, so the switch behavior is unaffected.)

3. In `"handleAgentTurn() returns the last non-empty text with a note when MADE finds no candidate that fits mid-loop"`: replace
   ```ts
   serverToolExecutors: {
     web_search: async () => "x".repeat(1000),
   },
   ```
   with
   ```ts
   serverToolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
   ```
   (No exact-number assertions in this test — unchanged otherwise.)

4. In `"handleAgentTurn() throws once the internal server-tool loop exceeds its iteration cap"`: replace
   ```ts
   serverToolExecutors: {
     web_search: async () => "result",
   },
   ```
   with
   ```ts
   serverToolExecutors: {},
   webSearchExecutor: async () => ({ results: [{ title: "R", url: "https://x.example", snippet: "result" }] }),
   ```

5. In `"handleAgentTurn() calls onToolResult after executing a server tool when streaming"`: replace
   ```ts
   serverToolExecutors: { web_search: async (args) => `results for ${args.query}` },
   ```
   with
   ```ts
   serverToolExecutors: {},
   webSearchExecutor: async (query) => ({ results: [{ title: "R", url: "https://x.example", snippet: `results for ${query}` }] }),
   ```
   and update:
   ```ts
   assert.deepEqual(toolResults, [{ index: 0, name: "web_search", result: "results for x" }]);
   ```
   to:
   ```ts
   assert.deepEqual(toolResults, [
     { index: 0, name: "web_search", result: "[1] R\n    results for x\n    https://x.example" },
   ]);
   ```

6. The remaining tests in the file (`"returns final text when the model calls no tools"`, `"hands an unrecognized (document) tool call back unexecuted"`, `"does not add a duplicate tool def..."`, `"throws when MADE selects no candidate"`, `"throws when MADE requires human approval"`, `"calls completeStreamByProvider instead of completeByProvider..."`, `"falls back to non-streaming completeByProvider..."`) never configure `serverToolExecutors.web_search` or call `webSearchExecutor` — no changes needed, since `webSearchExecutor` will be added as a required field only where `AgentTurnDeps` is fully constructed. Check each: `baseDeps` (the shared `Pick<AgentTurnDeps, "decide" | "availableCandidates">` object) does NOT need `webSearchExecutor` added to it, because every test spreads `...baseDeps` into a full `AgentTurnDeps` object literal that also sets `completeByProvider`/`serverToolExecutors` — add `webSearchExecutor: async () => { throw new Error("should not be called"); },` to each of these object literals individually (7 tests: the ones listed at the start of this sentence).

- [ ] **Step 2: Add a new test asserting `onSources` fires with the accumulated list**

Add to `tests/agent-turn.test.ts`:

```ts
test("handleAgentTurn() calls onSources with the accumulated results after each web_search call", async () => {
  let callCount = 0;
  const sourcesSeen: unknown[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"a"}' } }],
          };
        }
        if (callCount === 2) {
          return {
            content: "",
            toolCalls: [{ id: "call_2", type: "function" as const, function: { name: "web_search", arguments: '{"query":"b"}' } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async (query) => ({ results: [{ title: query, url: `https://${query}.example`, snippet: "s" }] }),
  };

  await handleAgentTurn(baseRequest, deps, {
    onDelta: () => {},
    onToolCallDelta: () => {},
    onToolResult: () => {},
    onSources: (results) => sourcesSeen.push(results),
  });

  assert.deepEqual(sourcesSeen, [
    [{ title: "a", url: "https://a.example", snippet: "s" }],
    [{ title: "a", url: "https://a.example", snippet: "s" }, { title: "b", url: "https://b.example", snippet: "s" }],
  ]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: FAIL — `AgentTurnDeps` has no `webSearchExecutor` field yet.

- [ ] **Step 4: Implement the `agent-turn.ts` changes**

In `src/agent-turn.ts`:

1. Change the import line:
   ```ts
   import { callWebSearch } from "./mcp/searxng-client.ts";
   ```
   to:
   ```ts
   import { callWebSearch, type WebSearchResponse, type WebSearchResult } from "./mcp/searxng-client.ts";
   import { formatWebSearchResults } from "./web-search-format.ts";
   ```

2. Add `onSources` to `AgentTurnStreamCallbacks`:
   ```ts
   export interface AgentTurnStreamCallbacks {
     onDelta: (text: string) => void;
     onToolCallDelta: (delta: ToolCallDelta) => void;
     onToolResult: (index: number, name: string, result: string) => void;
     onSources?: (results: WebSearchResult[]) => void;
     signal?: AbortSignal;
   }
   ```

3. Change `AgentTurnDeps` and `defaultDeps`:
   ```ts
   export interface AgentTurnDeps {
     decide: (request: DecideRequest) => Promise<DecideResponse>;
     availableCandidates: () => CandidateIn[];
     completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
     completeStreamByProvider?: Record<string, StreamCompleteFn>;
     serverToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>>;
     webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>;
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
       scrape: (args) => callScrape(String(args.url)),
     },
     webSearchExecutor: (query, maxResults) => callWebSearch(query, maxResults),
   };
   ```

4. Just above the `for (let i = 0; i < MAX_TURN_ITERATIONS; i++)` loop, alongside the existing `let lastNonEmptyText: string | null = null;` line, add:
   ```ts
   let citationOffset = 0;
   const allSources: WebSearchResult[] = [];
   ```

5. Replace the server-tool-execution block (currently, after the `hasClientCall` early-return, the `messages.push({ role: "assistant", ... })` line through the closing of the `for (const [index, call] of result.toolCalls.entries())` loop) with:
   ```ts
     messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
     for (const [index, call] of result.toolCalls.entries()) {
       let toolResult: string;
       if (call.function.name === "web_search") {
         try {
           const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
           const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
           const response = await deps.webSearchExecutor(String(args.query ?? ""), maxResults);
           toolResult = formatWebSearchResults(response, citationOffset);
           citationOffset += response.results.length;
           allSources.push(...response.results);
           streamCallbacks?.onSources?.(allSources.slice());
         } catch (err) {
           toolResult = `web_search failed: ${(err as Error).message}`;
         }
       } else {
         const executor = deps.serverToolExecutors[call.function.name];
         try {
           const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
           toolResult = executor ? await executor(args) : `tool ${call.function.name} is not available`;
         } catch (err) {
           toolResult = `${call.function.name} failed: ${(err as Error).message}`;
         }
       }
       streamCallbacks?.onToolResult(index, call.function.name, toolResult);
       messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
     }
   }
   ```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: PASS (all tests, including the new `onSources` test)

- [ ] **Step 6: Commit**

```bash
git add src/agent-turn.ts tests/agent-turn.test.ts
git commit -m "feat: numbered web_search citations + onSources callback in agent-turn.ts"
```

---

### Task 4: `src/server.ts` — `sources` WS event + `POST /api/web-search`

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes: `ChatDeps.webSearchExecutor`/`onSources` (Task 2), `AgentTurnDeps.webSearchExecutor`/`onSources` (Task 3), `WebSearchResponse` (Task 1).
- Produces: WS event `{ type: "sources", turnId, seq, results: WebSearchResult[] }`; HTTP route `POST /api/web-search`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/server.test.ts` (after the existing `"WS: chat turn streams delta events then a done event"` test):

```ts
test("WS: chat turn emits a sources event when the handler's streamCallbacks.onSources fires", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onSources?.([{ title: "T", url: "https://x.example", snippet: "s" }]);
    streamCallbacks?.onDelta("done");
    return { selectedCandidateId: "x", reply: "done", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}/ws`);
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

  const sourcesEvent = events.find((e) => e.type === "sources");
  assert.ok(sourcesEvent);
  assert.deepEqual(sourcesEvent.results, [{ title: "T", url: "https://x.example", snippet: "s" }]);
});

test("POST /api/web-search returns structured results as JSON", async () => {
  const server = createServer(
    async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }),
    undefined,
    async (query: string, maxResults?: number) => ({
      results: [{ title: `result for ${query}`, url: "https://x.example", snippet: `max ${maxResults ?? "default"}` }],
    })
  );
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "jakarta weather", maxResults: 3 }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    results: [{ title: "result for jakarta weather", url: "https://x.example", snippet: "max 3" }],
  });
  server.close();
});

test("POST /api/web-search with missing query returns 400", async () => {
  const server = createServer(async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  server.close();
});

test("POST /api/web-search returns 500 with the error message when the search executor throws", async () => {
  const server = createServer(
    async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }),
    undefined,
    async () => {
      throw new Error("searxng unreachable");
    }
  );
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "x" }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "searxng unreachable");
  server.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/server.test.ts`
Expected: FAIL — `createServer()` doesn't accept a third `webSearchExecutor` argument yet, and `/api/web-search`/the `sources` WS event don't exist.

- [ ] **Step 3: Implement the `server.ts` changes**

In `src/server.ts`:

1. Change the import line:
   ```ts
   import { handleChat } from "./chat.ts";
   import { handleAgentTurn } from "./agent-turn.ts";
   import type { AgentTurnRequest } from "./agent-turn.ts";
   import type { ChatMessage } from "./types.ts";
   ```
   to:
   ```ts
   import { handleChat } from "./chat.ts";
   import { handleAgentTurn } from "./agent-turn.ts";
   import type { AgentTurnRequest } from "./agent-turn.ts";
   import type { ChatMessage } from "./types.ts";
   import { callWebSearch, type WebSearchResponse } from "./mcp/searxng-client.ts";
   ```

2. In `startTurn()`, extend the `streamCallbacks` object literal to add `onSources`:
   ```ts
   const streamCallbacks = {
     onDelta: (text: string) => emit(turnId, { type: "delta", text }),
     onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) =>
       emit(turnId, { type: "tool_call_delta", ...delta }),
     onToolResult: (index: number, name: string, result: string) =>
       emit(turnId, { type: "tool_result", index, name, result }),
     onSources: (results: unknown) => emit(turnId, { type: "sources", results }),
     signal: controller.signal,
   };
   ```

3. Change `createServer()`'s signature and the two internal handler references to accept and use a third dependency, `webSearchExecutorFn`, defaulting to `callWebSearch`:
   ```ts
   export function createServer(
     handleChatFn: typeof handleChat = handleChat,
     handleAgentTurnFn: typeof handleAgentTurn = handleAgentTurn,
     webSearchExecutorFn: (query: string, maxResults?: number) => Promise<WebSearchResponse> = callWebSearch
   ): http.Server {
     const server = http.createServer(async (req, res) => {
       try {
   ```
   (the rest of the existing `http.createServer` callback body is unchanged up through the `/api/agent-turn` block's closing `return;` and `if (req.method === "GET")` block)

4. Immediately after the existing `/api/agent-turn` block (i.e., right after its closing `}\n\n      if (req.method === "GET") {` — insert the new block BEFORE the `GET` block), add:
   ```ts
       if (req.method === "POST" && req.url === "/api/web-search") {
         const chunks: Buffer[] = [];
         for await (const chunk of req) chunks.push(chunk as Buffer);
         const raw = Buffer.concat(chunks).toString("utf8");

         let body: { query?: unknown; maxResults?: unknown };
         try {
           body = JSON.parse(raw);
         } catch {
           res.writeHead(400, { "content-type": "application/json" });
           res.end(JSON.stringify({ error: "invalid JSON body" }));
           return;
         }

         if (typeof body.query !== "string" || body.query.trim() === "") {
           res.writeHead(400, { "content-type": "application/json" });
           res.end(JSON.stringify({ error: "query field is required" }));
           return;
         }

         try {
           const maxResults = typeof body.maxResults === "number" ? body.maxResults : undefined;
           const result = await webSearchExecutorFn(body.query, maxResults);
           res.writeHead(200, { "content-type": "application/json" });
           res.end(JSON.stringify(result));
         } catch (err) {
           res.writeHead(500, { "content-type": "application/json" });
           res.end(JSON.stringify({ error: (err as Error).message }));
         }
         return;
       }

   ```

5. Pass `webSearchExecutorFn` down to `attachWebSocketServer`'s calls — actually, `attachWebSocketServer` doesn't need it (web_search there is already reached via `handleChatFn`/`handleAgentTurnFn`'s own `deps.webSearchExecutor`, not through `createServer`'s parameter — this endpoint is purely for GenOffice's `desktop-stub.ts` HTTP call, not the WS path). No further wiring needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/server.test.ts`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests across the project)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: sources WS event + POST /api/web-search endpoint"
```

---

### Task 5: `client/src/chat/ChatApp.tsx` — citation chips + source popover

**Files:**
- Modify: `client/src/chat/ChatApp.tsx`

**Interfaces:**
- Consumes: the `"sources"` WS event from Task 4 (`{ type: "sources", turnId, seq, results: WebSearchResult[] }`).

No automated tests for this file, per this project's established pattern (client UI is manually verified, not unit tested) — same as every other task in `docs/superpowers/plans/2026-08-11-streaming-chat.md` that touched this file.

- [ ] **Step 1: Add the `WebSearchResult` type and extend `ChatMessage`**

At the top of `client/src/chat/ChatApp.tsx`, after the existing `ChatMessage` interface, add:

```tsx
interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}
```

and change the existing `ChatMessage` interface from:

```tsx
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
```

to:

```tsx
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: WebSearchResult[];
}
```

- [ ] **Step 2: Replace the `Markdown` component with a citation-aware version**

Replace:

```tsx
function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
```

with:

```tsx
function faviconUrl(pageUrl: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(pageUrl).hostname}`;
  } catch {
    return "";
  }
}

function withCitationChips(text: string, sources?: WebSearchResult[]): string {
  if (!sources || sources.length === 0) return text;
  return text.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const source = sources[Number(numStr) - 1];
    if (!source) return match;
    const favicon = faviconUrl(source.url);
    const img = favicon ? `<img src="${favicon}" alt="" class="cite-fav"/>` : "";
    return `<sup class="cite" data-cite="${numStr}">${img}</sup>`;
  });
}

function Markdown({ text, sources }: { text: string; sources?: WebSearchResult[] }) {
  const html = DOMPurify.sanitize(marked.parse(withCitationChips(text, sources), { async: false }) as string, {
    ADD_ATTR: ["data-cite"],
  });
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
```

- [ ] **Step 3: Add a `SourceCard` popover component**

Add, right after the `Markdown` component:

```tsx
function SourceCard({ source, x, y, onClose }: { source: WebSearchResult; x: number; y: number; onClose: () => void }) {
  let hostname = "";
  try {
    hostname = new URL(source.url).hostname;
  } catch {
    /* leave hostname blank if the URL doesn't parse */
  }
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
      <div
        style={{
          position: "fixed",
          left: x,
          top: y,
          zIndex: 11,
          background: "#222",
          color: "#fff",
          borderRadius: 8,
          padding: 12,
          maxWidth: 280,
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{hostname}</div>
        <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none" }}>
          {source.title}
        </a>
        {source.publishedDate && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{source.publishedDate}</div>}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Add `sourcesRef` and a `popover` state, reset sources on `turn_started`**

In the `ChatApp` function body, alongside the existing refs (`const draftRef = useRef(""); const turnIdRef = ...`), add:

```tsx
const sourcesRef = useRef<WebSearchResult[]>([]);
const [popover, setPopover] = useState<{ source: WebSearchResult; x: number; y: number } | null>(null);
```

In `handleWsMessage`, the `turn_started` branch currently is:

```tsx
if (msg.type === "turn_started") {
  setTurnId(msg.turnId ?? null);
  setAwaitingFirstToken(true);
  lastSeqRef.current = -1;
  return;
}
```

change it to:

```tsx
if (msg.type === "turn_started") {
  setTurnId(msg.turnId ?? null);
  setAwaitingFirstToken(true);
  lastSeqRef.current = -1;
  sourcesRef.current = [];
  return;
}
```

- [ ] **Step 5: Handle the `"sources"` message and attach the final list to the assistant message**

Update the `msg` type annotation at the top of `handleWsMessage` from:

```tsx
const msg = JSON.parse(raw) as { type: string; seq?: number; turnId?: string; text?: string; error?: string };
```

to:

```tsx
const msg = JSON.parse(raw) as {
  type: string;
  seq?: number;
  turnId?: string;
  text?: string;
  error?: string;
  results?: WebSearchResult[];
};
```

Add a new branch (after the existing `"tool_call_delta" || "tool_result"` branch, before `"done"`):

```tsx
} else if (msg.type === "sources") {
  sourcesRef.current = msg.results ?? [];
} else if (msg.type === "done") {
```

(this merges into the existing `if (msg.type === "delta") { ... } else if (...) { ... } else if (msg.type === "done") { ... }` chain — insert the new `else if` branch between `tool_call_delta`/`tool_result` and `done`.)

Update the `"done"` branch (already fixed for the stale-ref bug in a prior change) from:

```tsx
} else if (msg.type === "done") {
  const finalText = draftRef.current;
  draftRef.current = "";
  setMessages((prev) => [...prev, { role: "assistant", content: finalText }]);
  setAssistantDraft("");
  setTurnId(null);
  setAwaitingFirstToken(false);
```

to:

```tsx
} else if (msg.type === "done") {
  const finalText = draftRef.current;
  const finalSources = sourcesRef.current;
  draftRef.current = "";
  setMessages((prev) => [...prev, { role: "assistant", content: finalText, sources: finalSources }]);
  setAssistantDraft("");
  setTurnId(null);
  setAwaitingFirstToken(false);
```

- [ ] **Step 6: Add the click handler and wire it into the message list + `Markdown` calls**

Add, alongside the other function declarations in `ChatApp` (e.g. near `stop`/`regenerate`):

```tsx
function handleCitationClick(e: React.MouseEvent, sources?: WebSearchResult[]) {
  const target = (e.target as HTMLElement).closest("[data-cite]");
  if (!target || !sources) return;
  const n = Number(target.getAttribute("data-cite"));
  const source = sources[n - 1];
  if (!source) return;
  const rect = target.getBoundingClientRect();
  setPopover({ source, x: rect.left, y: rect.bottom + 4 });
}
```

Change the message-list rendering from:

```tsx
{messages.map((m, i) => (
  <div key={i} style={{ marginBottom: 8 }}>
    <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>
    {m.role === "assistant" ? <Markdown text={m.content} /> : <div>{m.content}</div>}
  </div>
))}
```

to:

```tsx
{messages.map((m, i) => (
  <div
    key={i}
    style={{ marginBottom: 8 }}
    onClick={m.role === "assistant" ? (e) => handleCitationClick(e, m.sources) : undefined}
  >
    <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>
    {m.role === "assistant" ? <Markdown text={m.content} sources={m.sources} /> : <div>{m.content}</div>}
  </div>
))}
```

and, at the end of the component's returned JSX (right before the closing `</div>` of the outermost wrapper), add:

```tsx
{popover && <SourceCard source={popover.source} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add client/src/chat/ChatApp.tsx
git commit -m "feat: inline web-search citation chips + source popover in ChatApp.tsx"
```

---

### Task 6: GenOffice — `desktop-stub.ts` calls the real search endpoint

**Files:**
- Modify: `genoffice/apps/docs/src/renderer/desktop-stub.ts`

**Interfaces:**
- Consumes: `POST /api/web-search` from Task 4.

This is the fix for the `"not available in the web build"` bug. No changes to `tools.ts`'s `executeAsyncTool` in this task — it already consumes `r.results`/`r.answer` in the exact shape this returns (`tools.ts:296-313`, unchanged until Task 7).

- [ ] **Step 1: Replace the `webSearch` stub**

In `genoffice/apps/docs/src/renderer/desktop-stub.ts`, change:

```ts
webSearch: async () => ({ results: [], method: "error", error: NOT_AVAILABLE }),
```

to:

```ts
webSearch: async (query, maxResults) => {
  try {
    const res = await fetch("/api/web-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, maxResults }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { results: [], method: "error", error: body.error ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { results: Array<{ title: string; url: string; snippet: string }>; answer?: string };
    return { results: data.results, answer: data.answer, method: "searxng" };
  } catch (err) {
    return { results: [], method: "error", error: (err as Error).message };
  }
},
```

(`imageSearch` is unchanged — it still returns the `NOT_AVAILABLE` stub, per this plan's Global Constraints.)

- [ ] **Step 2: Type-check**

Run (from `genoffice/`): `npx tsc --noEmit -p apps/docs/tsconfig.json` (or the project's existing typecheck script if one is configured — check `genoffice/package.json`'s scripts for the exact command this repo uses before running an ad hoc one)
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add genoffice/apps/docs/src/renderer/desktop-stub.ts
git commit -m "fix: GenOffice web_search calls the root server's SearXNG endpoint instead of failing in the web build"
```

---

### Task 7: GenOffice — numbered citations + structured display data in `tools.ts`

**Files:**
- Modify: `genoffice/packages/agent-core/src/types.ts`
- Modify: `genoffice/apps/docs/src/renderer/ai/tools.ts`

**Interfaces:**
- Produces: `ToolDisplay.items` gains optional `snippet`/`publishedDate` fields (additive, backward compatible with the slides app's existing usage). Local `ToolExecution` (docs app) gains `display?: ToolDisplay`.

- [ ] **Step 1: Extend `ToolDisplay.items`**

In `genoffice/packages/agent-core/src/types.ts`, change:

```ts
export interface ToolDisplay {
  kind: 'images' | 'links' | 'text'
  /** entry list for images / links modes */
  items?: Array<{ url: string; title?: string; thumb?: string }>
  /** extra text for text mode */
  text?: string
}
```

to:

```ts
export interface ToolDisplay {
  kind: 'images' | 'links' | 'text'
  /** entry list for images / links modes */
  items?: Array<{ url: string; title?: string; thumb?: string; snippet?: string; publishedDate?: string }>
  /** extra text for text mode */
  text?: string
}
```

- [ ] **Step 2: Add the citation instruction to `web_search`'s tool description**

In `genoffice/apps/docs/src/renderer/ai/tools.ts`, change the `web_search` entry in `AGENT_TOOLS`:

```ts
  {
    name: 'web_search',
    description:
      'Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets.',
    inputSchema: {
```

to:

```ts
  {
    name: 'web_search',
    description:
      'Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets. Results are numbered; when you state a fact drawn from a result, cite it immediately after the sentence using its number in brackets, e.g. [1] or [1][2] for multiple sources.',
    inputSchema: {
```

- [ ] **Step 3: Add `display?: ToolDisplay` to the local `ToolExecution` interface**

Change the import line:

```ts
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { ChartDisplay, NewChart } from '@genoffice/docx-engine'
import type { AgentToolCall, AgentToolDef } from '../../shared/ipc'
```

to:

```ts
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { ChartDisplay, NewChart } from '@genoffice/docx-engine'
import type { ToolDisplay } from '@genoffice/agent-core'
import type { AgentToolCall, AgentToolDef } from '../../shared/ipc'
```

Change the local `ToolExecution` interface:

```ts
export interface ToolExecution {
  /** result text fed back to the model */
  output: string
  isError?: boolean
  /** true when the tool changed the document */
  mutated: boolean
  /** short human-readable label for the chat activity chip */
  summary: string
}
```

to:

```ts
export interface ToolExecution {
  /** result text fed back to the model */
  output: string
  isError?: boolean
  /** true when the tool changed the document */
  mutated: boolean
  /** short human-readable label for the chat activity chip */
  summary: string
  /** UI-only source list for the web_search tool; never sent back to the model */
  display?: ToolDisplay
}
```

- [ ] **Step 4: Add the running citation counter and populate `display` in `executeAsyncTool`'s `web_search` case**

Add, near the top of the file after the `READ_MAX_CHARS` constant:

```ts
/** Running citation number across every web_search call in this module's lifetime (page/session scoped — simplest correct behavior, avoids threading turn-boundary state through the shared AgentSkill interface) */
let webSearchCitationOffset = 0
```

Change the `web_search` case in `executeAsyncTool` from:

```ts
    case 'web_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiSumWebSearch'), 'query must not be empty')
      const r = await window.desktop.webSearch(query, Number(call.input.maxResults) || 6)
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === 'error') {
        return fail(
          t('aiSumWebSearch'),
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      const lines: string[] = []
      if (r.answer) lines.push(`Direct answer: ${r.answer}\n`)
      r.results.forEach((it, i) =>
        lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`),
      )
      return {
        output: lines.join('\n') || '(no results)',
        mutated: false,
        summary: t('aiSumWebSearchDone', { query, count: r.results.length }),
      }
    }
```

to:

```ts
    case 'web_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiSumWebSearch'), 'query must not be empty')
      const r = await window.desktop.webSearch(query, Number(call.input.maxResults) || 6)
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === 'error') {
        return fail(
          t('aiSumWebSearch'),
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      const offset = webSearchCitationOffset
      webSearchCitationOffset += r.results.length
      const lines: string[] = []
      if (r.answer) lines.push(`Direct answer: ${r.answer}\n`)
      r.results.forEach((it, i) =>
        lines.push(`[${offset + i + 1}] ${it.title}\n   ${it.url}\n   ${it.snippet}`),
      )
      return {
        output: lines.join('\n') || '(no results)',
        mutated: false,
        summary: t('aiSumWebSearchDone', { query, count: r.results.length }),
        display: {
          kind: 'links',
          items: r.results.map((it) => ({ url: it.url, title: it.title, snippet: it.snippet })),
        },
      }
    }
```

- [ ] **Step 5: Type-check**

Run (from `genoffice/`): the project's configured typecheck command for the `docs` app and `agent-core` package (check `genoffice/package.json` / `genoffice/apps/docs/package.json` scripts for the exact invocation used elsewhere in this repo, e.g. `npm run typecheck --workspace=apps/docs` or similar — match whatever the existing scripts use rather than guessing a new command).
Expected: no errors

- [ ] **Step 6: Run the existing GenOffice test suite for this area**

Run (from `genoffice/`): the project's test command scoped to `apps/docs` and `packages/agent-core` (check existing `package.json` scripts, e.g. `npm test --workspace=apps/docs`). This task adds no new automated tests (the changed code is UI-tool-execution glue that already had no dedicated unit tests before this change, consistent with the rest of `tools.ts`'s untested `executeAsyncTool` branches) — this step only confirms nothing existing broke.
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add genoffice/packages/agent-core/src/types.ts genoffice/apps/docs/src/renderer/ai/tools.ts
git commit -m "feat: numbered web_search citations + display data in GenOffice docs tools"
```

---

### Task 8: GenOffice — citation chips in `Markdown` + wiring in `AiPanel.tsx`

**Files:**
- Modify: `genoffice/packages/ui/src/Markdown.tsx`
- Modify: `genoffice/apps/docs/src/renderer/ai/AiPanel.tsx`

**Interfaces:**
- Consumes: `ToolExecution.display` (Task 7).
- Produces: `Markdown` gains an optional `citations` prop (backward compatible — the slides app's existing `<Markdown text={...} />` call sites are unaffected since the prop is optional).

No automated tests for this task — both files are React UI with no existing test coverage in this area (`Markdown.tsx` has no test file; `AiPanel.tsx`'s streaming/chip rendering is manually verified, consistent with how the root project's `ChatApp.tsx` work was handled in Task 5 and in the prior streaming-chat plan).

- [ ] **Step 1: Add citation-chip rendering to `Markdown.tsx`**

In `genoffice/packages/ui/src/Markdown.tsx`, add near the top (after the `INLINE_RE` constant):

```tsx
export interface MarkdownCitation {
  title: string
  url: string
  snippet?: string
  publishedDate?: string
}

function faviconUrl(pageUrl: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(pageUrl).hostname}`
  } catch {
    return ''
  }
}

function CitationChip({ citation }: { citation: MarkdownCitation }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  let hostname = ''
  try {
    hostname = new URL(citation.url).hostname
  } catch {
    /* leave hostname blank if the URL doesn't parse */
  }
  const favicon = faviconUrl(citation.url)
  return (
    <span className="ai-cite-wrap">
      <sup
        className="ai-cite"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {favicon && <img src={favicon} alt="" className="ai-cite-fav" />}
      </sup>
      {open && (
        <>
          <span className="ai-cite-overlay" onClick={() => setOpen(false)} />
          <span className="ai-cite-card">
            <span className="ai-cite-source">{hostname}</span>
            <a href={citation.url} target="_blank" rel="noopener noreferrer" className="ai-cite-title">
              {citation.title}
            </a>
            {citation.publishedDate && <span className="ai-cite-date">{citation.publishedDate}</span>}
          </span>
        </>
      )}
    </span>
  )
}
```

Change the `import` line at the top of the file from:

```tsx
import { Fragment, type ReactNode } from 'react'
```

to:

```tsx
import { Fragment, useState, type ReactNode } from 'react'
```

Change `renderInline`'s signature and body from:

```tsx
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const tok = m[0] ?? ''
    if (tok.startsWith('`')) out.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    last = i + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
```

to:

```tsx
const INLINE_WITH_CITE_RE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|\[\d+\])/g

function renderInline(text: string, citations?: MarkdownCitation[]): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  const re = citations && citations.length > 0 ? INLINE_WITH_CITE_RE : INLINE_RE
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const tok = m[0] ?? ''
    if (tok.startsWith('`')) out.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('*')) out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    else {
      const n = Number(tok.slice(1, -1))
      const citation = citations?.[n - 1]
      out.push(citation ? <CitationChip key={key++} citation={citation} /> : tok)
    }
    last = i + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
```

Change every call site of `renderInline(...)` within the file's `parseBlocks`-consuming render code — `renderInline(b.text)`, `renderInline(it)` (twice, in the `ul`/`ol` branch), and `renderInline(ln)` — to pass `citations` through. Change the `Markdown` component itself from:

```tsx
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="ai-md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') {
          return (
            <p key={i} className="ai-md-h">
              {renderInline(b.text)}
            </p>
          )
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)
          return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
        }
        return (
          <p key={i}>
            {b.lines.map((ln, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
```

to:

```tsx
export function Markdown({ text, citations }: { text: string; citations?: MarkdownCitation[] }): React.JSX.Element {
  return (
    <div className="ai-md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') {
          return (
            <p key={i} className="ai-md-h">
              {renderInline(b.text, citations)}
            </p>
          )
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const items = b.items.map((it, j) => <li key={j}>{renderInline(it, citations)}</li>)
          return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
        }
        return (
          <p key={i}>
            {b.lines.map((ln, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln, citations)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Add minimal CSS for the new chip/card/overlay classes**

Check `genoffice/packages/ui/src` for the stylesheet that already styles `.ai-md` (search for `.ai-md` in `.css` files under `packages/ui/src` and `apps/docs/src`) and add, following that file's existing conventions for chat-bubble styling and this repo's mandatory theming rules (`genoffice/CLAUDE.md`: chrome colors must use `var(--surface)`/`var(--text)`/etc. from `packages/ui/src/tokens.css`, never raw hex, except on token-definition lines):

```css
.ai-cite-wrap {
  position: relative;
  display: inline-block;
}
.ai-cite {
  display: inline-flex;
  cursor: pointer;
  vertical-align: super;
  margin: 0 1px;
}
.ai-cite-fav {
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
.ai-cite-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
}
.ai-cite-card {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 11;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--hover);
  border-radius: 8px;
  padding: 10px;
  min-width: 200px;
  max-width: 280px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.ai-cite-source {
  font-size: 11px;
  opacity: 0.7;
}
.ai-cite-title {
  font-weight: 600;
  color: var(--text);
  text-decoration: none;
}
.ai-cite-date {
  font-size: 11px;
  opacity: 0.6;
}
```

Append this block to whichever existing stylesheet already contains `.ai-md` rules (do not create a new CSS file — follow the existing co-location pattern for this component's styles).

- [ ] **Step 3: Wire citations into `ChatEntry` and accumulate them in `onToolExecuted`**

In `genoffice/apps/docs/src/renderer/ai/AiPanel.tsx`, add the import for the citation type:

```tsx
import { Markdown, type MarkdownCitation } from '@genoffice/ui'
```

(check the existing import line — `import { Markdown } from '@genoffice/ui'` — and extend it to also import `type MarkdownCitation`, matching this file's existing import style for `@genoffice/ui`.)

Change the `ChatEntry` interface from:

```ts
interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  error?: string
  streaming?: boolean
  turnLimit?: boolean
  /** the run failed and this user message was rolled back out of the model context */
  undelivered?: boolean
  /** the run failed because Genspark is signed out — render an inline sign-in button */
  loginRequired?: boolean
  /** tool executions performed during this assistant turn */
  tools?: ToolActivity[]
}
```

to:

```ts
interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  error?: string
  streaming?: boolean
  turnLimit?: boolean
  /** the run failed and this user message was rolled back out of the model context */
  undelivered?: boolean
  /** the run failed because Genspark is signed out — render an inline sign-in button */
  loginRequired?: boolean
  /** tool executions performed during this assistant turn */
  tools?: ToolActivity[]
  /** web_search sources accumulated during this assistant turn, for inline [N] citation chips */
  citations?: MarkdownCitation[]
}
```

In the `onToolExecuted` handler, right after the existing `patchLastAssistant((last) => { ... tools update ... })` call (the block that swaps out the running placeholder), add:

```tsx
          if (call.name === 'web_search' && execution.display?.kind === 'links' && execution.display.items) {
            const newCitations: MarkdownCitation[] = execution.display.items.map((item) => ({
              title: item.title ?? '',
              url: item.url,
              snippet: item.snippet,
              publishedDate: item.publishedDate,
            }))
            patchLastAssistant((last) => ({ citations: [...(last.citations ?? []), ...newCitations] }))
          }
```

- [ ] **Step 4: Pass `citations` to the `<Markdown>` call sites**

Change:

```tsx
{entry.text && <Markdown text={entry.text} />}
```

to:

```tsx
{entry.text && <Markdown text={entry.text} citations={entry.citations} />}
```

and change:

```tsx
<Markdown text={entry.text} />
```

to:

```tsx
<Markdown text={entry.text} citations={entry.citations} />
```

(these are `AiPanel.tsx:875` and `AiPanel.tsx:939` respectively — the first inside the `historicChat.map` block, the second inside the live `chat.map` block.)

- [ ] **Step 5: Type-check**

Run (from `genoffice/`): the project's configured typecheck command for `apps/docs` and `packages/ui` (match the existing scripts, as in Task 7 Step 5).
Expected: no errors

- [ ] **Step 6: Run the existing GenOffice test suite for this area**

Run (from `genoffice/`): the project's test command scoped to `apps/docs` and `packages/ui`.
Expected: PASS (no new tests added; confirms nothing existing broke)

- [ ] **Step 7: Commit**

```bash
git add genoffice/packages/ui/src/Markdown.tsx genoffice/apps/docs/src/renderer/ai/AiPanel.tsx
git commit -m "feat: inline web-search citation chips in GenOffice's AI panel"
```

---

## Manual verification (recommended before/soon after merge)

No automated tests cover the two UI tasks (5 and 8). Before relying on this in production:

1. Run the dev stack (`npm run dev` + `npm run dev:client`, or `docker compose up --build app`), open `/`.
2. Ask a question that requires a web search (e.g. "what's the latest news about X"). Confirm: the reply streams normally, `[1]`/`[2]` markers (if the model cites) render as small clickable favicon chips, and clicking one opens a dark source card with hostname/title/(date). Confirm a citation number with no matching source (rare, but possible if the model miscounts) renders as plain `[N]` text, not a broken chip.
3. Open `/document`, ask the AI panel to research something requiring `web_search`. Confirm the search actually returns real results (previously it always failed with `"not available in the web build"`) and that citations render the same way, using GenOffice's own chip/card styling.
4. Confirm `image_search` in the AI panel still fails the same way it did before this plan (unchanged, by design).
