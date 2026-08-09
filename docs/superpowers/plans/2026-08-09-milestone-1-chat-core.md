# Milestone 1: Chat Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal chat web app where the user sends a message, the backend asks MADE (`POST /decide`) which model to use, then calls that model for real and returns the reply.

**Architecture:** Node/TypeScript HTTP server (no framework — native `node:http`) with three layers: a MADE HTTP client, per-provider LLM clients (Ollama, DeepSeek — one file per provider, never a generalized multi-provider client, matching the MADE project's own convention), and a chat orchestrator that wires them together. A single static HTML page is the UI.

**Tech Stack:** Node.js 22+, TypeScript, `tsx` (dev/test runner, zero build step needed for iteration), native `fetch`/`http` — no HTTP framework, no test framework beyond Node's built-in `node:test`.

## Global Constraints

- Zero runtime dependencies. DevDependencies limited to `typescript`, `tsx`, `@types/node`.
- One file per LLM provider client (`src/providers/<name>-client.ts`) — do not build a generalized multi-provider abstraction. This mirrors the MADE thesis project's explicit convention (`core/experiment/deepseek_client.py`, `core/experiment/ollama_client.py`).
- MADE runs as a separate service reached over HTTP at `MADE_URL` (default `http://localhost:8000`). This project never imports MADE code directly.
- All async I/O (MADE calls, provider calls) must be dependency-injected into the functions that use them, so tests never need to mock global `fetch` or spin up real servers.
- Ollama must be reachable for this milestone to be demoable end-to-end without spending money (DeepSeek is optional — if `DEEPSEEK_API_KEY` is unset, the DeepSeek candidate is simply excluded from the candidate list sent to MADE).

---

### Task 1: Project scaffold + shared types + MADE client

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/types.ts`
- Create: `src/made-client.ts`
- Test: `tests/made-client.test.ts`

**Interfaces:**
- Produces: `TaskIn`, `OrgIn`, `CandidateIn`, `DecideRequest`, `DecideResponse` types (`src/types.ts`); `decide(request: DecideRequest, madeUrl?: string): Promise<DecideResponse>` (`src/made-client.ts`)

- [ ] **Step 1: Scaffold the project**

Create `package.json`:

```json
{
  "name": "ai-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "node --import tsx --test tests/**/*.test.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `.gitignore`:

```
node_modules/
dist/
.env
```

Create `.env.example`:

```
MADE_URL=http://localhost:8000
OLLAMA_BASE_URL=http://localhost:11434
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 2: Write shared types**

`src/types.ts`:

```typescript
export interface TaskIn {
  type: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
}

export interface OrgIn {
  budget_remaining_usd: number;
  region: string;
}

export interface CandidateIn {
  id: string;
  vendor: string;
  kind: "model" | "tool";
  cost_per_1k_tokens: number;
  scores: Record<string, number>;
}

export interface DecideRequest {
  task: TaskIn;
  org: OrgIn;
  decision_kind: "model_selection" | "tool_selection" | "human_approval";
  candidates: CandidateIn[];
  policy_set: string;
}

export interface RankingEntryOut {
  id: string;
  score: number;
}

export interface ExcludedOut {
  id: string;
  reason: string;
}

export interface DecideResponse {
  decision_id: string;
  selected_candidate_id: string | null;
  requires_human_approval: boolean;
  ranking: RankingEntryOut[];
  excluded: ExcludedOut[];
  technique_used: string;
  policy_version: string;
}
```

- [ ] **Step 3: Write the failing test for the MADE client**

`tests/made-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/made-client.ts";
import type { DecideRequest, DecideResponse } from "../src/types.ts";

test("decide() posts the request to MADE_URL/decide and returns the parsed response", async () => {
  const fakeResponse: DecideResponse = {
    decision_id: "abc-123",
    selected_candidate_id: "gemma4-12b",
    requires_human_approval: false,
    ranking: [{ id: "gemma4-12b", score: 0.9 }],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };

  let capturedUrl = "";
  let capturedBody: unknown = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const request: DecideRequest = {
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 10, region: "us" },
    decision_kind: "model_selection",
    candidates: [
      { id: "gemma4-12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.75, latency: 9000, business_risk: 0.1 } },
    ],
    policy_set: "default",
  };

  const result = await decide(request, "http://made.test", fakeFetch);

  assert.equal(capturedUrl, "http://made.test/decide");
  assert.deepEqual(capturedBody, request);
  assert.deepEqual(result, fakeResponse);
});

test("decide() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("boom", { status: 503 });

  await assert.rejects(
    () =>
      decide(
        {
          task: { type: "chat", data_classification: "internal" },
          org: { budget_remaining_usd: 10, region: "us" },
          decision_kind: "model_selection",
          candidates: [],
          policy_set: "default",
        },
        "http://made.test",
        fakeFetch
      ),
    /MADE \/decide returned 503/
  );
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/made-client.ts` does not exist yet (module not found).

- [ ] **Step 5: Implement the MADE client**

`src/made-client.ts`:

```typescript
import type { DecideRequest, DecideResponse } from "./types.ts";

export async function decide(
  request: DecideRequest,
  madeUrl: string = process.env.MADE_URL ?? "http://localhost:8000",
  fetchImpl: typeof fetch = fetch
): Promise<DecideResponse> {
  const response = await fetchImpl(`${madeUrl}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (response.status !== 200) {
    throw new Error(`MADE /decide returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as DecideResponse;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: both tests in `tests/made-client.test.ts` PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example src/types.ts src/made-client.ts tests/made-client.test.ts
git commit -m "feat: scaffold project, add shared types and MADE client"
```

---

### Task 2: Candidate config + provider clients (Ollama, DeepSeek)

**Files:**
- Create: `src/candidates.ts`
- Create: `src/providers/ollama-client.ts`
- Create: `src/providers/deepseek-client.ts`
- Test: `tests/candidates.test.ts`
- Test: `tests/providers/ollama-client.test.ts`
- Test: `tests/providers/deepseek-client.test.ts`

**Interfaces:**
- Consumes: `CandidateIn` (from Task 1's `src/types.ts`)
- Produces: `availableCandidates(env?: NodeJS.ProcessEnv): CandidateIn[]` (`src/candidates.ts`); `complete(model: string, prompt: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<string>` (`src/providers/ollama-client.ts`); `complete(model: string, prompt: string, apiKey?: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<string>` (`src/providers/deepseek-client.ts`)

- [ ] **Step 1: Write the failing test for candidates**

`tests/candidates.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCandidates } from "../src/candidates.ts";

test("availableCandidates() always includes the local Ollama candidate", () => {
  const candidates = availableCandidates({});
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("gemma4-12b"));
});

test("availableCandidates() includes DeepSeek only when DEEPSEEK_API_KEY is set", () => {
  const withoutKey = availableCandidates({});
  assert.ok(!withoutKey.map((c) => c.id).includes("deepseek-v4-flash"));

  const withKey = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  assert.ok(withKey.map((c) => c.id).includes("deepseek-v4-flash"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/candidates.ts` does not exist.

- [ ] **Step 3: Implement candidates config**

`src/candidates.ts`:

```typescript
import type { CandidateIn } from "./types.ts";

// ponytail: static score estimates (cost/quality/latency/business_risk),
// not measured from real usage yet. Replace with a live score-cache
// (like MADE's own score_cache) once this app has real traffic to learn from.

const OLLAMA_CANDIDATE: CandidateIn = {
  id: "gemma4-12b",
  vendor: "ollama-local",
  kind: "model",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.75, latency: 9000, business_risk: 0.1 },
};

const DEEPSEEK_CANDIDATE: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: { cost: 0.001, quality: 0.9, latency: 15000, business_risk: 0.25 },
};

export function availableCandidates(env: NodeJS.ProcessEnv = process.env): CandidateIn[] {
  const candidates = [OLLAMA_CANDIDATE];
  if (env.DEEPSEEK_API_KEY) {
    candidates.push(DEEPSEEK_CANDIDATE);
  }
  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `tests/candidates.test.ts` PASS.

- [ ] **Step 5: Write the failing test for the Ollama client**

`tests/providers/ollama-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/ollama-client.ts";

test("complete() posts to {baseUrl}/v1/chat/completions and returns the reply text", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from gemma" } }] }),
      { status: 200 }
    );
  };

  const reply = await complete("gemma4:12b", "hi", "http://ollama.test", fakeFetch);

  assert.equal(capturedUrl, "http://ollama.test/v1/chat/completions");
  assert.deepEqual(capturedBody, {
    model: "gemma4:12b",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(reply, "hello from gemma");
});

test("complete() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(
    () => complete("gemma4:12b", "hi", "http://ollama.test", fakeFetch),
    /Ollama API returned 500/
  );
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/providers/ollama-client.ts` does not exist.

- [ ] **Step 7: Implement the Ollama client**

`src/providers/ollama-client.ts`:

```typescript
export async function complete(
  model: string,
  prompt: string,
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });

  if (response.status !== 200) {
    throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test`
Expected: `tests/providers/ollama-client.test.ts` PASS.

- [ ] **Step 9: Write the failing test for the DeepSeek client**

`tests/providers/deepseek-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/deepseek-client.ts";

test("complete() sends Bearer auth and posts to {baseUrl}/v1/chat/completions", async () => {
  let capturedHeaders: HeadersInit | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from deepseek" } }] }),
      { status: 200 }
    );
  };

  const reply = await complete("deepseek-v4-flash", "hi", "sk-test", "http://deepseek.test", fakeFetch);

  assert.equal((capturedHeaders as Record<string, string>)["authorization"], "Bearer sk-test");
  assert.equal(reply, "hello from deepseek");
});

test("complete() throws if no API key is provided", async () => {
  await assert.rejects(
    () => complete("deepseek-v4-flash", "hi", "", "http://deepseek.test", fetch),
    /DEEPSEEK_API_KEY not set/
  );
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/providers/deepseek-client.ts` does not exist.

- [ ] **Step 11: Implement the DeepSeek client**

`src/providers/deepseek-client.ts`:

```typescript
export async function complete(
  model: string,
  prompt: string,
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test`
Expected: `tests/providers/deepseek-client.test.ts` PASS.

- [ ] **Step 13: Commit**

```bash
git add src/candidates.ts src/providers/ollama-client.ts src/providers/deepseek-client.ts tests/candidates.test.ts tests/providers/
git commit -m "feat: add candidate config and per-provider LLM clients"
```

---

### Task 3: Chat orchestration

**Files:**
- Create: `src/chat.ts`
- Test: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `decide` (Task 1, `src/made-client.ts`), `availableCandidates` (Task 2, `src/candidates.ts`), `complete` from `src/providers/ollama-client.ts` and `src/providers/deepseek-client.ts` (Task 2), `DecideResponse`/`CandidateIn` types (Task 1)
- Produces: `handleChat(message: string, deps?: ChatDeps): Promise<{ selectedCandidateId: string; reply: string }>` — throws `Error("MADE returned no eligible candidate")` if `selected_candidate_id` is `null`.

- [ ] **Step 1: Write the failing test**

`tests/chat.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChat } from "../src/chat.ts";
import type { DecideResponse } from "../src/types.ts";

test("handleChat() asks MADE, then dispatches to the selected candidate's provider", async () => {
  const fakeDecideResponse: DecideResponse = {
    decision_id: "d1",
    selected_candidate_id: "gemma4-12b",
    requires_human_approval: false,
    ranking: [],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };

  let decideCalledWithMessageType = "";
  const reply = await handleChat("hello there", {
    decide: async (request) => {
      decideCalledWithMessageType = request.task.type;
      return fakeDecideResponse;
    },
    availableCandidates: () => [
      { id: "gemma4-12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: {} },
    ],
    completeByProvider: {
      "ollama-local": async (_model, prompt) => `echo: ${prompt}`,
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
  });

  assert.equal(decideCalledWithMessageType, "chat");
  assert.equal(reply.selectedCandidateId, "gemma4-12b");
  assert.equal(reply.reply, "echo: hello there");
});

test("handleChat() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleChat("hello", {
        decide: async () => ({
          decision_id: "d1",
          selected_candidate_id: null,
          requires_human_approval: false,
          ranking: [],
          excluded: [{ id: "gemma4-12b", reason: "denied" }],
          technique_used: "topsis",
          policy_version: "1",
        }),
        availableCandidates: () => [
          { id: "gemma4-12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: {} },
        ],
        completeByProvider: {},
      }),
    /MADE returned no eligible candidate/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/chat.ts` does not exist.

- [ ] **Step 3: Implement chat orchestration**

`src/chat.ts`:

```typescript
import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates } from "./candidates.ts";
import { complete as ollamaComplete } from "./providers/ollama-client.ts";
import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import type { CandidateIn, DecideRequest, DecideResponse } from "./types.ts";

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, prompt: string) => Promise<string>>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
};

export async function handleChat(
  message: string,
  deps: ChatDeps = defaultDeps
): Promise<{ selectedCandidateId: string; reply: string }> {
  const candidates = deps.availableCandidates();

  const decision = await deps.decide({
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  });

  if (!decision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }

  const selected = candidates.find((c) => c.id === decision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${decision.selected_candidate_id}`);
  }

  const complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }

  const reply = await complete(selected.id, message);

  return { selectedCandidateId: selected.id, reply };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `tests/chat.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: add chat orchestration wiring MADE decision to provider dispatch"
```

---

### Task 4: HTTP server + minimal frontend

**Files:**
- Create: `src/server.ts`
- Create: `public/index.html`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `handleChat` and `ChatDeps` (Task 3, `src/chat.ts`)
- Produces: `createServer(handleChatFn?: typeof handleChat): http.Server` (`src/server.ts`)

- [ ] **Step 1: Write the failing test**

`tests/server.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";

test("POST /api/chat returns the handler's result as JSON", async () => {
  const server = createServer(async (message: string) => ({
    selectedCandidateId: "gemma4-12b",
    reply: `echo: ${message}`,
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { selectedCandidateId: "gemma4-12b", reply: "echo: hi" });
  server.close();
});

test("POST /api/chat with missing message returns 400", async () => {
  const server = createServer(async (message: string) => ({
    selectedCandidateId: "x",
    reply: message,
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
    body: JSON.stringify({ message: "hi" }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "MADE returned no eligible candidate");
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/server.ts` does not exist.

- [ ] **Step 3: Implement the server**

`src/server.ts`:

```typescript
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./chat.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function createServer(handleChatFn: typeof handleChat = handleChat): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      let raw = "";
      for await (const chunk of req) raw += chunk;

      let message: unknown;
      try {
        message = JSON.parse(raw).message;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }

      if (typeof message !== "string" || message.length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "message field is required" }));
        return;
      }

      try {
        const result = await handleChatFn(message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all three tests in `tests/server.test.ts` PASS.

- [ ] **Step 5: Write the minimal frontend**

`public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AI Workspace — Chat Core</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
    #log { white-space: pre-wrap; border: 1px solid #ccc; border-radius: 8px; padding: 12px; min-height: 200px; margin-bottom: 12px; }
    form { display: flex; gap: 8px; }
    input { flex: 1; padding: 8px; }
    button { padding: 8px 16px; }
    .model-tag { color: #666; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>AI Workspace — Chat Core</h1>
  <div id="log"></div>
  <form id="form">
    <input id="message" type="text" placeholder="Type a message..." autocomplete="off" required />
    <button type="submit">Send</button>
  </form>
  <script>
    const form = document.getElementById("form");
    const input = document.getElementById("message");
    const log = document.getElementById("log");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const message = input.value;
      log.textContent += `You: ${message}\n`;
      input.value = "";

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = await res.json();

      if (!res.ok) {
        log.textContent += `Error: ${body.error}\n\n`;
        return;
      }
      log.textContent += `[${body.selectedCandidateId}] ${body.reply}\n\n`;
    });
  </script>
</body>
</html>
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts public/index.html tests/server.test.ts
git commit -m "feat: add HTTP server and minimal chat frontend"
```

---

### Task 5: Manual end-to-end verification against real MADE + Ollama

No new files — this task proves the whole chain works against real services, not just mocks. (The MADE thesis project caught a real bug this way — a candidate ID that worked in every mocked test but 404'd against the real Ollama server — so this step is not optional.)

- [ ] **Step 1: Start MADE**

In the `MODE` repo (`/home/naufa/workspace/MODE`):

Run: `.venv/bin/python -m uvicorn api.main:app --port 8000`
Expected: server starts, listening on port 8000.

- [ ] **Step 2: Confirm Ollama is running**

Run: `curl -s http://localhost:11434/api/tags`
Expected: JSON listing `gemma4:12b`. If not running, start with `ollama serve`.

- [ ] **Step 3: Build and start this project**

In `/home/naufa/workspace/ai-workspace`:

Run: `cp .env.example .env` (leave `DEEPSEEK_API_KEY` blank unless you want to spend real API budget testing that path)
Run: `npm run dev`
Expected: `ai-workspace chat core listening on http://localhost:3000`

- [ ] **Step 4: Send a real chat message**

Run: `curl -s -X POST http://localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Say hello in one sentence."}'`
Expected: JSON response with `selectedCandidateId: "gemma4-12b"` (the only candidate available without a DeepSeek key) and a real `reply` string generated by the local model — not an error.

- [ ] **Step 5: Open the browser UI**

Open `http://localhost:3000` in a browser, type a message, click Send.
Expected: the reply appears in the log with the `[gemma4-12b]` tag, within a few seconds (matching Ollama's typical local latency).

- [ ] **Step 6: Record the result**

If Step 4 or 5 fails, fix the root cause before considering Milestone 1 done — do not proceed to Milestone 2 on a chain that only works in mocks.
