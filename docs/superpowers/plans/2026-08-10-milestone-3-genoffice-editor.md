# Milestone 3 Sub-Project 2: Replace Univer with GenOffice, connect its AI panel to MADE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Univer-based `/document` page with GenOffice's Tiptap-based docs editor (edited in place inside `genoffice/`, now a plain subdirectory of this monorepo — its own `.git` has already been removed), and connect its AI sidebar to MADE with a full tool-calling loop that can both edit the document and use `web_search`/`scrape`.

**Architecture:** `genoffice/apps/docs/src/renderer/index.html` becomes a third Vite entry point, built and served by the existing `ai-workspace` server exactly like `chat.html`. GenOffice's Electron IPC bridge (`window.desktop`, `window.projectApi`) is replaced by a stub module so the app runs in a plain browser tab. A new backend endpoint, `POST /api/agent-turn`, gives GenOffice's existing client-side agent loop (`agent-core`'s `AgentLoop`) a MADE-connected model, merging in the existing `web_search`/`scrape` server tools alongside GenOffice's own document-editing tools.

**Tech Stack:** GenOffice's own stack (React 19, Tiptap/ProseMirror, TypeScript) via its own `node_modules` — nothing new installed at the `ai-workspace` root. Backend: existing Node/TypeScript stack, reusing `made-client.ts`, the Ollama/DeepSeek provider clients, and the `src/mcp/*` clients.

## Global Constraints

- **`genoffice/apps/docs/src/renderer/ai/docs-skill.ts` and `tools.ts` are not modified.** Tool merging and routing (`web_search`/`scrape` vs. document tools) happens entirely in the new backend module.
- **`src/chat.ts`, `src/mcp/*`, `src/made-client.ts`, `src/candidates.ts`, `src/providers/*`, and `/api/chat`'s behavior are not modified.** The new `/api/agent-turn` endpoint is additive.
- **No real .docx file open/save in this pass.** The editor always starts with a new, blank document. `window.desktop`'s file-related methods resolve to safe "not available" results — they must not throw.
- **No token-level streaming.** `/api/agent-turn` returns one complete JSON response per model turn.
- **Univer is fully removed**: `@univerjs/presets`, `@univerjs/preset-docs-core` come out of `package.json`; `client/src/document/` and `client/document.html` are deleted.
- **No automated tests for the vendored GenOffice renderer code or the new `createMadeTransport()`** — verified manually. `src/agent-turn.ts` does get `node:test` coverage, matching `tests/chat.test.ts`'s style (dependency-injected `deps` object, no real network calls in tests).
- Tool-name routing rule (resolves an ambiguity the design spec didn't cover): if a model turn's tool calls include **any** name outside `{"web_search", "scrape"}`, the **entire turn's calls** (not just the non-server ones) are returned to the browser unexecuted — the server does not partially execute a mixed turn. Only a turn whose calls are **all** `web_search`/`scrape` is executed server-side and looped internally.

---

### Task 1: Remove Univer, wire GenOffice's docs editor into the build, stub out Electron

**Files:**
- Modify: `package.json` (remove `@univerjs/presets`, `@univerjs/preset-docs-core`; no additions — GenOffice resolves its own deps from `genoffice/node_modules`)
- Delete: `client/src/document/DocumentApp.tsx`, `client/src/document/main.tsx`, `client/document.html`
- Modify: `vite.config.ts` (document entry points at GenOffice's renderer, add `server.fs.allow`)
- Create: `genoffice/apps/docs/src/renderer/desktop-stub.ts`
- Modify: `genoffice/apps/docs/src/renderer/main.tsx` (import the stub before bootstrap)

**Interfaces:**
- Produces: a working `/document` page backed by GenOffice's renderer, reachable exactly like today (`src/server.ts`'s existing `/document` → `/document.html` routing and `serveStatic` are untouched — Vite just now builds `document.html`'s content from a different source tree).
- Consumes: nothing from later tasks. Task 2 and Task 3 build on top of this without changing anything this task produces.

- [ ] **Step 1: Install GenOffice's own dependencies**

GenOffice has never had `npm install` run in this checkout. Skip Electron's own binary download (~150MB, unneeded — we only use GenOffice as a Vite-bundled renderer, never launch Electron itself):

```bash
cd genoffice
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
cd ..
```

Expected: `genoffice/node_modules/@genoffice/`, `genoffice/node_modules/@tiptap/`, `genoffice/node_modules/react/` all exist afterward.

- [ ] **Step 2: Remove Univer from `package.json`**

Remove these two lines from `package.json`'s `dependencies`:
```json
"@univerjs/preset-docs-core": "^0.25.1",
"@univerjs/presets": "^0.25.1",
```

Run: `npm install` (repo root, to update `package-lock.json` and prune the now-unused packages from the root `node_modules`).

- [ ] **Step 3: Delete the old Univer document page**

```bash
git rm -r client/src/document client/document.html
```

- [ ] **Step 4: Point the `document` Vite entry at GenOffice's renderer**

Replace `vite.config.ts` in full:

```typescript
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
    fs: {
      allow: [
        resolve(__dirname, "client"),
        resolve(__dirname, "genoffice/apps/docs/src/renderer"),
        resolve(__dirname, "genoffice/node_modules"),
        resolve(__dirname, "genoffice/packages"),
      ],
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        chat: resolve(__dirname, "client/chat.html"),
        document: resolve(__dirname, "genoffice/apps/docs/src/renderer/index.html"),
      },
    },
  },
});
```

`server.fs.allow` is required because Vite's dev server otherwise refuses to serve files outside its configured `root` (`client/`) — GenOffice's renderer, its `node_modules`, and its workspace `packages/` all live outside that directory.

- [ ] **Step 5: Write the `window.desktop` / `window.projectApi` stub**

Create `genoffice/apps/docs/src/renderer/desktop-stub.ts`. This satisfies both global interfaces declared in `env.d.ts` (`DesktopApi` from `../shared/ipc`, `ProjectApi` from `@genoffice/project-store`) with safe, non-throwing defaults — file open/save/print/export report `{ ok: false }` or resolve empty/null; theme/language return fixed defaults; event-subscription methods return no-op unsubscribe functions and never fire; chat-history persistence (`ProjectApi`) keeps everything in memory for the current page load only (nothing survives a refresh, since there is no backend for it yet):

```typescript
import type { DesktopApi } from "../shared/ipc";
import type { ProjectApi, ProjectSummary } from "@genoffice/project-store";

const NOT_AVAILABLE = "not available in the web build";
const noop = (): (() => void) => () => {};

const desktop: DesktopApi = {
  getLanguage: async () => "en",
  onLanguageChanged: noop,
  getTheme: async () => "system",
  onThemeChanged: noop,
  openDocx: async () => null,
  openDocxPath: async () => null,
  consumePendingOpenDocx: async () => null,
  consumeNewBlankDoc: async () => true,
  onOpenDocx: noop,
  onRenamedDocx: noop,
  saveDocx: async () => ({ ok: false, error: NOT_AVAILABLE }),
  writeRecoveryCopy: async () => ({ ok: false }),
  onTeardown: noop,
  saveDocxAs: async () => ({ ok: false, error: NOT_AVAILABLE }),
  saveDocxNew: async () => ({ ok: false, error: NOT_AVAILABLE }),
  getRecentFiles: async () => [],
  pickImage: async () => null,
  getAiSettings: async () => ({
    provider: "custom",
    providers: {
      genspark: { apiKey: "", model: "" },
      anthropic: { apiKey: "", model: "" },
      gemini: { apiKey: "", model: "" },
      deepseek: { apiKey: "", model: "" },
      openai: { apiKey: "", model: "" },
      custom: { apiKey: "", model: "", baseUrl: "" },
    },
  }),
  setAiSettings: async () => {},
  print: async () => {
    window.print();
  },
  exportPdf: async () => ({ ok: false, error: NOT_AVAILABLE }),
  printPdfBuffer: async () => ({ ok: false }),
  saveMergedPdf: async () => ({ ok: false, error: NOT_AVAILABLE }),
  aiChat: async () => ({ ok: false, error: NOT_AVAILABLE }),
  aiStream: async () => {},
  aiStreamCancel: async () => {},
  aiGskStatus: async () => ({ loggedIn: false }),
  aiGskLogin: async () => {},
  webSearch: async () => ({ results: [], method: "error", error: NOT_AVAILABLE }),
  imageSearch: async () => ({ images: [], method: "error", error: NOT_AVAILABLE }),
  fetchImage: async () => null,
  pickAttachments: async () => null,
  addAttachmentPaths: async (paths) => ({ accepted: [], rejected: paths.map(() => NOT_AVAILABLE) }),
  addPastedImage: async () => ({ accepted: [], rejected: [NOT_AVAILABLE] }),
  readAttachment: async () => ({ ok: false, error: NOT_AVAILABLE }),
  readAttachmentImage: async () => ({ ok: false, error: NOT_AVAILABLE }),
  getPathForFile: () => "",
  openNewTab: async () => {},
  listDocsTabs: async () => [],
  focusDocsTab: async () => {},
  onAiStream: noop,
  onMenuCommand: noop,
  onCloseCheck: noop,
  reportCloseCheck: () => {},
  onCloseSaveRequest: noop,
  reportCloseSaveResult: () => {},
  reportViewMenuState: () => {},
};

function makeProjectSummary(id: string, name: string): ProjectSummary {
  const now = new Date().toISOString();
  return { id, name, createdAt: now, updatedAt: now, fileCount: 0, lastActiveAt: now, isDefault: id === "default" };
}

const projectApi: ProjectApi = {
  resolveChat: async ({ tempChatId }) => ({ projectId: "default", chatId: tempChatId ?? "session" }),
  appendChat: async () => {},
  loadChat: async () => [],
  rebindChat: async ({ newChatId, tempChatId }) => ({ projectId: "default", chatId: newChatId ?? tempChatId ?? "session" }),
  listProjects: async () => [makeProjectSummary("default", "Default")],
  createProject: async ({ name }) => makeProjectSummary("default", name),
  renameProject: async () => {},
  deleteProject: async () => {},
  moveFile: async () => {},
  getTimeline: async () => [],
};

window.desktop = desktop;
window.projectApi = projectApi;
```

- [ ] **Step 6: Import the stub before the app bootstraps**

In `genoffice/apps/docs/src/renderer/main.tsx`, add this as the very first import (before any other import — it must run before `bootstrap()` touches `window.desktop`):

```typescript
import "./desktop-stub";
```

- [ ] **Step 7: Verify the production build**

`vite dev`'s live server resolves entry URLs relative to `root: "client"` and needs its special `/@fs/` prefix for files outside that root (exactly what `server.fs.allow` permits access to) — rather than guess at that dev-server URL, verify against the production build directly, which uses `build.rollupOptions.input` unambiguously and is what `src/server.ts` actually serves in every environment (dev, `npm start`, and Docker):

```bash
npm run build
```

Expected: `client/dist/document.html` exists and its bundle includes GenOffice's renderer code (spot check: `grep -l "univer-container" client/dist/*.html` should find nothing — old placeholder is gone; `ls client/dist/assets/ | grep -i docs` or similar should show a GenOffice-sized bundle).

```bash
npm test
```

Expected: all existing backend tests still pass (this task touches no backend logic).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vite.config.ts client genoffice/apps/docs/src/renderer/desktop-stub.ts genoffice/apps/docs/src/renderer/main.tsx
git commit -m "feat: replace Univer with GenOffice's docs editor, stub Electron IPC bridge"
```

Note: this also stages the rest of `genoffice/` for the first time (it was detached from its own git history earlier in this session — plain files, not a submodule). Confirm with `git status` that `genoffice/` files beyond the two touched here are included as new additions, not shown as a nested repo.

---

### Task 2: `/api/agent-turn` backend endpoint

**Files:**
- Create: `src/agent-turn.ts`
- Test: `tests/agent-turn.test.ts`
- Modify: `src/server.ts` (add the route)

**Interfaces:**
- Consumes: `made-client.ts`'s `decide()`, `candidates.ts`'s `availableCandidates()`, the Ollama/DeepSeek `complete()` clients, `src/mcp/*`'s `callWebSearch`/`callScrape`, `src/tools.ts`'s `TOOL_DEFS` — all pre-existing, unchanged.
- Produces: `handleAgentTurn(request: AgentTurnRequest, deps?: AgentTurnDeps): Promise<AgentTurnResult>` from `src/agent-turn.ts`, and the `AgentTurnRequest`/`AgentTurnResult`/`AgentTurnDeps` types it exports. Task 3's `createMadeTransport()` (browser-side) sends the exact JSON shape `AgentTurnRequest` describes and expects the exact JSON shape `AgentTurnResult` describes back from `POST /api/agent-turn`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-turn.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgentTurn } from "../src/agent-turn.ts";
import type { AgentTurnDeps, AgentTurnRequest } from "../src/agent-turn.ts";
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

const baseDeps: Pick<AgentTurnDeps, "decide" | "availableCandidates"> = {
  decide: async () => modelDecision,
  availableCandidates: () => [
    { id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
};

const docTool = { name: "insert_content", description: "insert text", inputSchema: { type: "object" } };
const baseRequest: AgentTurnRequest = {
  system: "you are a helpful assistant",
  messages: [{ role: "user", text: "hello" }],
  tools: [docTool],
};

test("handleAgentTurn() returns final text when the model calls no tools", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
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

  assert.deepEqual(result, { type: "text", text: "hi there" });
});

test("handleAgentTurn() hands an unrecognized (document) tool call back unexecuted", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "insert_content", arguments: '{"text":"hi"}' } },
        ],
      }),
    },
    serverToolExecutors: {
      web_search: async () => {
        throw new Error("should not be called");
      },
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, {
    type: "tool_calls",
    calls: [{ id: "call_1", name: "insert_content", input: { text: "hi" } }],
    text: undefined,
  });
});

test("handleAgentTurn() executes web_search/scrape internally and loops without surfacing them", async () => {
  let callCount = 0;
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"weather"}' } },
            ],
          };
        }
        const toolMsg = messages.find((m) => m.role === "tool");
        return { content: `answer using: ${toolMsg?.content}`, toolCalls: [] };
      },
    },
    serverToolExecutors: {
      web_search: async (args) => `results for ${args.query}`,
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.equal(callCount, 2);
  assert.deepEqual(result, { type: "text", text: "answer using: results for weather" });
});

test("handleAgentTurn() does not add a duplicate tool def when the client already sent one with the same name", async () => {
  const clientWebSearch = { name: "web_search", description: "client-defined", inputSchema: { type: "object" } };
  const request: AgentTurnRequest = { ...baseRequest, tools: [docTool, clientWebSearch] };
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async (_model, _messages, tools) => {
        assert.equal(tools.filter((t) => t.function.name === "web_search").length, 1);
        return { content: "ok", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
  };

  await handleAgentTurn(request, deps);
});

test("handleAgentTurn() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleAgentTurn(baseRequest, {
        ...baseDeps,
        decide: async () => ({ ...modelDecision, selected_candidate_id: null }),
        completeByProvider: {},
        serverToolExecutors: {},
      }),
    /MADE returned no eligible candidate/
  );
});

test("handleAgentTurn() throws when MADE requires human approval", async () => {
  await assert.rejects(
    () =>
      handleAgentTurn(baseRequest, {
        ...baseDeps,
        decide: async () => ({ ...modelDecision, requires_human_approval: true }),
        completeByProvider: {},
        serverToolExecutors: {},
      }),
    /MADE requires human approval for this request/
  );
});

test("handleAgentTurn() throws once the internal server-tool loop exceeds its iteration cap", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_x", type: "function" as const, function: { name: "web_search", arguments: "{}" } }],
      }),
    },
    serverToolExecutors: {
      web_search: async () => "result",
    },
  };

  await assert.rejects(() => handleAgentTurn(baseRequest, deps), /agent-turn tool loop exceeded maximum iterations/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: FAIL — `Cannot find module '../src/agent-turn.ts'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `src/agent-turn.ts`**

```typescript
import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates } from "./candidates.ts";
import { complete as ollamaComplete } from "./providers/ollama-client.ts";
import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import { callWebSearch } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
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

export interface AgentTurnDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  serverToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>>;
}

const defaultDeps: AgentTurnDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
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

function decideRequest(candidates: CandidateIn[]): DecideRequest {
  return {
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  };
}

export async function handleAgentTurn(request: AgentTurnRequest, deps: AgentTurnDeps = defaultDeps): Promise<AgentTurnResult> {
  const candidates = deps.availableCandidates();
  const modelDecision = await deps.decide(decideRequest(candidates));

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

  const tools = mergeTools(request.tools);
  const messages = toChatMessages(request.system, request.messages);

  for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
    const result = await complete(selected.id, messages, tools);

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

  throw new Error("agent-turn tool loop exceeded maximum iterations");
}
```

Note: `truncateToolResult`/`MAX_TOOL_RESULT_CHARS` are deliberately duplicated from `src/chat.ts` rather than imported — this plan's Global Constraints forbid modifying `chat.ts` (even to add an `export`), and the function is ~10 lines.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/agent-turn.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Wire the route into `src/server.ts`**

Add the import at the top of `src/server.ts`:

```typescript
import { handleAgentTurn } from "./agent-turn.ts";
import type { AgentTurnRequest } from "./agent-turn.ts";
```

Add this route branch in `createServer`'s handler, right after the existing `POST /api/chat` block (before the `if (req.method === "GET")` block):

```typescript
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
          const result = await handleAgentTurn(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }
```

- [ ] **Step 6: Run the full backend test suite**

Run: `npm test`
Expected: all tests pass, including the new `agent-turn.test.ts` and every pre-existing test file (`chat.test.ts` untouched and still green — confirms `src/chat.ts` was not modified).

- [ ] **Step 7: Commit**

```bash
git add src/agent-turn.ts src/server.ts tests/agent-turn.test.ts
git commit -m "feat: add MADE-connected /api/agent-turn endpoint"
```

---

### Task 3: Connect GenOffice's AI panel to `/api/agent-turn`

**Files:**
- Modify: `genoffice/apps/docs/src/renderer/ai/transport.ts` (add `createMadeTransport`)
- Modify: `genoffice/apps/docs/src/renderer/ai/AiPanel.tsx` (use it)

**Interfaces:**
- Consumes: `POST /api/agent-turn` from Task 2, request/response shapes exactly as `AgentTurnRequest`/`AgentTurnResult` in `src/agent-turn.ts`.
- Produces: nothing further tasks depend on — this is the last functional piece.

- [ ] **Step 1: Add `createMadeTransport()`**

In `genoffice/apps/docs/src/renderer/ai/transport.ts`, add this function alongside the existing `createElectronTransport`:

```typescript
export function createMadeTransport(): AgentTransport {
  return {
    stream(request, callbacks) {
      let cancelled = false;

      (async () => {
        try {
          const res = await fetch("/api/agent-turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          });

          if (cancelled) return;

          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: `request failed: ${res.status}` }));
            callbacks.onError(body.error ?? `request failed: ${res.status}`);
            return;
          }

          const data = (await res.json()) as
            | { type: "text"; text: string }
            | { type: "tool_calls"; calls: Parameters<typeof callbacks.onToolCall>[0][]; text?: string };

          if (cancelled) return;

          if (data.type === "text") {
            if (data.text) callbacks.onDelta(data.text);
            callbacks.onDone();
          } else if (data.type === "tool_calls") {
            if (data.text) callbacks.onDelta(data.text);
            for (const call of data.calls) callbacks.onToolCall(call);
            callbacks.onDone();
          } else {
            callbacks.onError("unexpected response shape from /api/agent-turn");
          }
        } catch (err) {
          if (!cancelled) callbacks.onError((err as Error).message);
        }
      })();

      return { cancel: () => { cancelled = true; } };
    },
  };
}
```

- [ ] **Step 2: Use it in `AiPanel.tsx`**

Change the import at line 14 of `genoffice/apps/docs/src/renderer/ai/AiPanel.tsx`:

```typescript
import { createMadeTransport } from './transport'
```

Change line 467 (inside the `AgentLoop` construction) from:

```typescript
      transport: createElectronTransport(() => settingsRef.current),
```

to:

```typescript
      transport: createMadeTransport(),
```

- [ ] **Step 3: Verify the full stack manually**

Ensure MADE, at least one model backend (Ollama or DeepSeek), and SearXNG/Scrapling are reachable (same services `/api/chat` already depends on — no new infrastructure).

```bash
npm run build
npm start
```

Open `http://localhost:3000/document`. In the AI panel:
1. Ask it to search the web for something and summarize the answer — confirm a real `web_search` result comes back (check server logs or the MADE dashboard if available; the reply should reference real, current information, not a hallucinated one).
2. Ask it to insert or edit text in the document based on that — confirm the document actually changes on screen.

Both must work in the same conversation (one panel session), confirming the merged tool set (document tools + `web_search`/`scrape`) and the client/server routing split both work end-to-end.

- [ ] **Step 4: Commit**

```bash
git add genoffice/apps/docs/src/renderer/ai/transport.ts genoffice/apps/docs/src/renderer/ai/AiPanel.tsx
git commit -m "feat: connect GenOffice's AI panel to MADE via /api/agent-turn"
```

---

### Task 4: End-to-end production and Docker verification

No new files — proves the whole chain (GenOffice build → server static serving → `/api/agent-turn` → Docker image) works for real, matching this project's established practice.

- [ ] **Step 1: Full production build and test suite**

```bash
npm run build
npm test
```
Expected: clean build, all tests pass (including `agent-turn.test.ts`).

- [ ] **Step 2: Verify both pages and the new endpoint from the running server**

```bash
npm start
```

```bash
curl -s http://localhost:3000/ -o /dev/null -w "chat: %{http_code}\n"
curl -s http://localhost:3000/document -o /dev/null -w "document: %{http_code}\n"
```
Expected: both `200`.

Open `http://localhost:3000/` — confirm the chat page still works exactly as before. Open `http://localhost:3000/document` — confirm GenOffice's editor loads and the AI panel works (repeat Task 3 Step 3's manual check once more against the production build, not just dev mode).

- [ ] **Step 3: Update the Dockerfile to include `genoffice/`**

Modify `Dockerfile`: add a line copying `genoffice/` into the build context, and run its own `npm install` inside the image (mirroring Task 1 Step 1). Replace `Dockerfile` in full:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY client ./client
COPY genoffice ./genoffice
RUN cd genoffice && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 4: Verify the Docker image**

```bash
docker build -t ai-workspace-genoffice-test .
docker run --rm -d -p 3001:3000 --name ai-workspace-genoffice-test ai-workspace-genoffice-test
curl -s http://localhost:3001/ -o /dev/null -w "chat: %{http_code}\n"
curl -s http://localhost:3001/document -o /dev/null -w "document: %{http_code}\n"
docker stop ai-workspace-genoffice-test
```
Expected: both `200`. (The `/api/agent-turn` round-trip through MADE isn't practical to verify from inside this isolated container run unless MADE/Ollama/SearXNG are also reachable from it — the static-serving check here mirrors exactly what Milestone 3's first sub-project verified for `/document`; the full AI-panel round-trip was already confirmed against the host services in Task 3 Step 3.)

- [ ] **Step 5: Confirm Univer is fully gone**

```bash
grep -i "univer" package.json
```
Expected: no output.

- [ ] **Step 6: Record the result**

If any step fails, fix the root cause before considering this sub-project done.
