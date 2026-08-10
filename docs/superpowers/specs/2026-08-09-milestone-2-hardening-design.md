# Design: Milestone 2 Hardening

Status: approved by user (2026-08-09).
Follow-up to Milestone 2 (MCP tools) — addresses deferred minors and one new request from the final whole-branch review (`docs/superpowers/plans/2026-08-09-milestone-2-mcp-tools.md`, ledger). No new features, no new files beyond tests — pure hardening of existing code.

## 1. Goal

Address every item deferred at Milestone 2's final review, plus bind the app's own port to loopback (matching the treatment already given to `searxng`/`scrapling`/`made`).

## 2. Items

**1. Truncate tool results fed back to the model** (`src/chat.ts`)
Cap each `toolResult` string to 8000 characters before pushing it as a `tool`-role message. If truncated, append a marker: `` ...[truncated, <N> chars total]`` where `<N>` is the original length. 8000 chars (~2000 tokens) comfortably covers a normal `web_search`/`scrape` result while preventing a large scraped page from flooding a small local model's context — this was the proximate cause of an observed hallucination during Milestone 2's manual verification.

**2. Validate URLs before calling `scrape`** (`src/mcp/scrapling-client.ts`)
Before `callScrape` dispatches to the MCP connection, reject:
- Any URL whose scheme is not `http`/`https`.
- Any URL whose hostname is a known internal service (`searxng`, `scrapling`, `made`, `host.docker.internal`), `localhost`, `127.0.0.1`, or falls in a private IP range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).

On rejection, `callScrape` throws a descriptive `Error` (e.g. `"scrape refused: URL targets an internal/private host"`) — this is caught by `chat.ts`'s existing executor try/catch and turned into a tool-result error string fed back to the model, exactly like any other tool failure. No new error-handling path needed in `chat.ts`.

**3. Show `toolsUsed` in the UI** (`public/index.html`)
When a chat response's `toolsUsed` array is non-empty, render an extra line under the reply: `[tools: web_search, scrape]` (comma-joined). Empty array renders nothing extra, matching current behavior.

**4. Clarify `.env.example`** (`.env.example`)
Add a comment block separating the two ways this project runs: bare `npm run dev` (all `localhost` values) vs `docker compose up` (docker service DNS names for `MADE_URL`/`SEARXNG_URL`/`SCRAPLING_URL`). The file keeps one active value per variable (the docker-oriented ones, since that's the primary supported path per Milestone 2) with the local alternative shown as a comment.

**5. Pre-install `mcp-searxng`, avoid per-call registry hits** (`package.json`, `src/mcp/searxng-client.ts`)
Add `mcp-searxng` as a regular `dependencies` entry (`npm install mcp-searxng`) so it's present in `node_modules` at build time (already copied into the app image via `npm ci`). Change the stdio spawn in `searxng-client.ts` from `npx -y mcp-searxng` to `npx mcp-searxng` — without `-y`, `npx` resolves a locally-installed binary directly with no registry round-trip; the `-y` flag was only needed to auto-confirm installing a package that wasn't already present.

**6. Graceful tool-loop exhaustion** (`src/chat.ts`)
Track the last non-empty `result.content` seen across iterations. If the loop reaches `MAX_TOOL_ITERATIONS` without a final non-tool-call response, return that last non-empty content with an appended note: `"\n\n[tool loop limit reached — response may be incomplete]"` instead of throwing. If no iteration ever produced non-empty content, keep the existing behavior: throw `Error("tool-calling loop exceeded maximum iterations")`.

**7. Bind the app's port to loopback** (`docker-compose.yaml`)
Change the `app` service's port mapping from `"3000:3000"` to `"127.0.0.1:3000:3000"`, consistent with `searxng`/`scrapling`/`made`'s existing loopback-only bindings from Milestone 2's final review fix.

## 3. Testing

- Item 1: unit test that a tool executor returning a string >8000 chars gets truncated with the marker in the resulting `tool`-role message; a string ≤8000 chars passes through unchanged.
- Item 2: unit tests for `callScrape` — reject `ftp://...`, reject `http://searxng:8080/...`, reject `http://192.168.1.5/...`, reject `http://localhost/...`, accept `https://example.com` (mocked connection, no real network).
- Item 3: no automated test (static HTML/JS) — verified manually in-browser as part of this hardening pass's own end-to-end check.
- Item 4: no automated test (comment-only change to an example file).
- Item 5: existing `tests/mcp/searxng-client.test.ts` continues to pass unchanged (the test injects a fake `connect`, so the spawn args aren't exercised there); manual `docker compose` verification confirms no registry access is needed at runtime (can be checked by observing the container has no outbound npm-registry traffic during a `web_search` call, or simply that it still works with `npx mcp-searxng`).
- Item 6: unit test that a mocked model which always returns `toolCalls` (never finishing) across 5 iterations, with the last iteration's `content` non-empty, causes `handleChat` to return that content plus the truncation note rather than throwing. A second test: all iterations return empty content — still throws.
- Item 7: manual `docker compose up` + `docker compose ps` check that port 3000 is bound to `127.0.0.1` (e.g. `curl http://127.0.0.1:3000` succeeds, and the container is not reachable via the host's other interfaces — same style of check as the final review's port-binding fix).

## 4. Out of Scope

- Any new feature or UI beyond showing `toolsUsed`.
- Milestone 3 (Univer) / Milestone 4 (Nextcloud) — unrelated, unchanged.
- Rate limiting, auth, or other production-hardening concerns not already identified in Milestone 2's final review.
