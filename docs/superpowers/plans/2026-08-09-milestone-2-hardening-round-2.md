# Milestone 2 Hardening Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `scrape`'s SSRF blocklist to cover cloud-metadata/link-local addresses and IPv6 literals ahead of a planned cloud VM deployment, make `docker-compose.yaml` read the app's environment from the user's real `.env` file instead of hardcoding values inline, fix a surrogate-pair-splitting bug in tool-result truncation, and change the UI's `toolsUsed` display from a raw repeated list to a counted summary.

**Architecture:** Pure hardening/polish on top of the existing Milestone 2 hardening pass — no new files except tests, no new architecture. Confirmed via direct experimentation that Node's WHATWG `URL` parser already normalizes IPv4 numeric-encoding tricks (decimal/hex/octal) before our validation code ever sees them, so only genuinely-uncovered cases (link-local/metadata addresses, `0.0.0.0`, IPv6 literals) need new logic.

**Tech Stack:** Same as before — Node.js 22+, TypeScript, `tsx`, `node:test`, Docker Compose.

## Global Constraints

- No new runtime dependencies.
- Follow the existing dependency-injection pattern in `scrapling-client.ts` (`connect` parameter) and `ChatDeps` in `chat.ts` — no global mutable state.
- All new logic needs a covering `node:test` test using the existing fake-injection style.
- Full suite must stay green (`npm test`) and `npm run build` (tsc) must stay clean after every task.
- `.env` is already gitignored (see `.gitignore`) — no secret-handling changes needed for the `env_file` switch.

---

### Task 1: Extend SSRF blocklist for cloud deployment (link-local/metadata, 0.0.0.0, IPv6 literals)

**Files:**
- Modify: `src/mcp/scrapling-client.ts`
- Modify: `tests/mcp/scrapling-client.test.ts`

**Interfaces:**
- No signature changes — `callScrape`'s behavior is a strict superset of what it already rejects; nothing that was previously allowed becomes disallowed except the newly-blocked ranges.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp/scrapling-client.test.ts`:

```typescript
test("callScrape() rejects URLs whose numeric-encoded IPv4 host normalizes to a private address", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  // These all normalize to 127.0.0.1 via the WHATWG URL parser before our
  // code ever inspects the hostname — this test guards against that
  // normalization behavior changing in a future Node/URL-spec version.
  await assert.rejects(() => callScrape("http://2130706433/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://0x7f.0.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://0177.0.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://127.1/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});

test("callScrape() rejects cloud metadata (169.254.*) and 0.0.0.0-range addresses", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://169.254.169.254/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://169.254.1.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://0.0.0.0/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://0/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});

test("callScrape() rejects IPv6 literal hosts", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://[::1]/", fakeConnect), /IPv6 literal/);
  await assert.rejects(() => callScrape("http://[::ffff:127.0.0.1]/", fakeConnect), /IPv6 literal/);
  assert.equal(connected, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the "cloud metadata / 0.0.0.0" and "IPv6 literal" tests FAIL (those ranges aren't blocked yet); the "numeric-encoded IPv4" test PASSES already (this is a regression guard for existing behavior, not new logic — confirm it passes both before and after this task's changes).

- [ ] **Step 3: Extend the blocklist**

In `src/mcp/scrapling-client.ts`, replace the `isPrivateIPv4` function:

```typescript
function isPrivateIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
```

Then replace `assertUrlAllowed`:

```typescript
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

  // ponytail: blocks all IPv6 literals rather than parsing private ranges —
  // revisit with proper IPv6 range checks only if a real need to scrape an
  // IPv6-literal URL shows up. Legitimate scrape targets are domain names.
  if (hostname.startsWith("[")) {
    throw new Error("scrape refused: IPv6 literal hosts are not allowed");
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateIPv4(hostname)) {
    throw new Error("scrape refused: URL targets an internal/private host");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests in `tests/mcp/scrapling-client.test.ts` PASS (8/8: 5 existing + 3 new).

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: clean, no tsc errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/scrapling-client.ts tests/mcp/scrapling-client.test.ts
git commit -m "fix: block cloud-metadata/link-local addresses and IPv6 literals in scrape URL validation"
```

---

### Task 2: Fix surrogate-pair splitting in tool-result truncation

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

**Interfaces:**
- No signature changes — `truncateToolResult` remains a private helper with the same `(result: string) => string` shape; only its cut-point logic changes.

- [ ] **Step 1: Write the failing test**

Append to `tests/chat.test.ts`:

```typescript
test("handleChat() does not split a surrogate pair when truncating a tool result", async () => {
  const emoji = "\u{1F600}"; // a single Unicode code point, 2 UTF-16 code units
  const longResult = "x".repeat(7999) + emoji + "y".repeat(1000);
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

  await handleChat("search something with emoji at the truncation boundary", deps);

  const markerIndex = capturedToolContent.indexOf("...[truncated");
  const truncatedPortion = capturedToolContent.slice(0, markerIndex);

  // The cut must land BEFORE the emoji's high surrogate (at index 7999),
  // not in the middle of it (which an 8000-char slice would do).
  assert.equal(truncatedPortion, "x".repeat(7999));
  assert.equal(truncatedPortion.length, 7999);
  assert.ok(capturedToolContent.endsWith(`...[truncated, ${longResult.length} chars total]`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the current `slice(0, 8000)` cuts the emoji's high surrogate off at index 8000, leaving `truncatedPortion` as `"x".repeat(7999) + <lone high surrogate>` (length 8000, not 7999).

- [ ] **Step 3: Fix the truncation cut point**

In `src/chat.ts`, replace `truncateToolResult`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests in `tests/chat.test.ts` PASS, including the existing truncation tests from the previous hardening pass (the 8000-char boundary test still passes since a plain ASCII string at exactly 8000 chars has no surrogate at the cut point, so `cut` stays at 8000).

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: clean, no tsc errors.

- [ ] **Step 6: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "fix: avoid splitting a UTF-16 surrogate pair at the tool-result truncation boundary"
```

---

### Task 3: docker-compose reads from `.env`, counted toolsUsed summary, and manual verification

**Files:**
- Modify: `docker-compose.yaml`
- Modify: `public/index.html`

**Interfaces:**
- No code interfaces — config and presentation changes, verified manually.

- [ ] **Step 1: Switch the app service to `env_file`**

In `docker-compose.yaml`, replace the `app` service's `environment:` block:

```yaml
    environment:
      MADE_URL: http://made:8000
      SEARXNG_URL: http://searxng:8080
      SCRAPLING_URL: http://scrapling:8000/mcp
      OLLAMA_BASE_URL: http://host.docker.internal:11434
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      DEEPSEEK_BASE_URL: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
```

with:

```yaml
    env_file:
      - .env
```

The full `app` service block should read:

```yaml
  app:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - searxng
      - scrapling
      - made
```

Do not change `searxng`, `scrapling`, or `made` service blocks.

- [ ] **Step 2: Show `toolsUsed` as a counted summary in the UI**

In `public/index.html`, replace this block inside the `form.addEventListener` handler:

```javascript
      let line = `[${body.selectedCandidateId}] ${body.reply}\n`;
      if (body.toolsUsed && body.toolsUsed.length > 0) {
        line += `[tools: ${body.toolsUsed.join(", ")}]\n`;
      }
      log.textContent += line + "\n";
```

with:

```javascript
      let line = `[${body.selectedCandidateId}] ${body.reply}\n`;
      if (body.toolsUsed && body.toolsUsed.length > 0) {
        const counts = {};
        for (const name of body.toolsUsed) {
          counts[name] = (counts[name] || 0) + 1;
        }
        const summary = Object.entries(counts)
          .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
          .join(", ");
        line += `[tools: ${summary}]\n`;
      }
      log.textContent += line + "\n";
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yaml public/index.html
git commit -m "chore: read app env from .env in docker-compose, show toolsUsed as a counted summary"
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: full suite PASSES (39/39: 33 before this round + 3 from Task 1 + 1 from Task 2 + 2 more — recount against actual state at execution time, since exact prior count may have shifted; the important thing is 0 failures).

- [ ] **Step 5: Manual end-to-end verification against the running stack**

This proves the `.env` wiring and toolsUsed rendering work together against real services, not just mocks.

- [ ] **Step 5a: Confirm a real `.env` file exists**

The user has already created `.env` (from `.env.example`'s docker-oriented values). Confirm it exists: `ls -la .env`. If missing, `cp .env.example .env` first.

- [ ] **Step 5b: Start the stack**

Run: `docker compose up --build -d`
Expected: all 4 services come up. Ensure `ollama serve` is running on the host first.

- [ ] **Step 5c: Confirm the app actually received its env vars from `.env`**

Run: `docker compose exec app printenv MADE_URL SEARXNG_URL SCRAPLING_URL OLLAMA_BASE_URL`
Expected: prints the docker-oriented values (`http://made:8000`, `http://searxng:8080`, `http://scrapling:8000/mcp`, `http://host.docker.internal:11434`) — confirms `env_file` actually wired `.env` into the container, not just relying on stale hardcoded values from a prior image layer.

- [ ] **Step 5d: Confirm a message triggering two tool calls renders the counted summary**

Run: `curl -s --max-time 90 -X POST http://127.0.0.1:3000/api/chat -H 'content-type: application/json' -d '{"message":"Search the web twice: once for \"OpenAI GPT-5\" and once for \"Anthropic Claude 5\", then briefly summarize both."}'`
Expected: JSON response with `"toolsUsed":["web_search","web_search"]` (or similar, if the model actually makes two calls — model behavior isn't fully deterministic, so if it only calls once that's fine too, just confirms the single-call path still renders without the `×` suffix). If `toolsUsed` does contain two `web_search` entries, open `http://127.0.0.1:3000` in a browser, send the same message, and confirm the UI shows `[tools: web_search ×2]` — not `[tools: web_search, web_search]`.

- [ ] **Step 5e: Confirm SSRF hardening still works live**

Run: `docker compose exec app sh -c "node -e \"import('./dist/mcp/scrapling-client.js').then(m=>m.callScrape('http://169.254.169.254/').then(()=>console.log('FAIL')).catch(e=>console.log('OK:', e.message)))\""`
Expected: `OK: scrape refused: URL targets an internal/private host`

Run: `docker compose exec app sh -c "node -e \"import('./dist/mcp/scrapling-client.js').then(m=>m.callScrape('http://[::1]/').then(()=>console.log('FAIL')).catch(e=>console.log('OK:', e.message)))\""`
Expected: `OK: scrape refused: IPv6 literal hosts are not allowed`

- [ ] **Step 5f: Tear down**

Run: `docker compose down`

- [ ] **Step 6: Record the result**

If any step in 5a-5e fails, fix the root cause before considering this round done.
