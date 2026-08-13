# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Obsidian note-keeping (required)

After finishing any non-trivial piece of work on this repo (a shipped feature, a bug fix, a design decision, an investigation with a real conclusion) — not just internal memory — also write or update a note in the user's Obsidian vault at:

```
/mnt/c/Users/naufa/Documents/Obsidian Vault/Projects/ai-workspace/
```

- One markdown file per piece of work, named `YYYY-MM-DD-<topic>.md`, matching this repo's own `docs/superpowers/plans/`/`specs/` naming convention.
- Frontmatter: `name`, `description`, `date`, `status` (`shipped`/`in-progress`/`investigating`), `tags`. Match the style already in `Projects/ai-workspace/memory-project-ai-workspace.md` and `2026-08-12-inline-citations.md`.
- Content: what shipped/was decided and why, non-obvious bugs found (especially ones only review caught, not tests), known deferred gaps, and a link back to this repo's own spec/plan file if one exists. Skip routine details a `git log` already covers.
- Link related notes with `[[wikilink]]` syntax, and add a line to the relevant existing note (e.g. `memory-project-ai-workspace.md`) pointing at the new one, so the vault stays navigable — don't leave orphaned notes.
- This is in addition to, not a replacement for, this session's own memory system — both get written.

## Commands

```bash
npm run dev          # backend, tsx watch src/server.ts, serves http://localhost:3000
npm run dev:client    # Vite dev server for the React client (proxies /api and /ws to :3000)
npm run build         # tsc + vite build -> dist/
npm start             # node dist/server.js (after build)
npm test              # node --test over tests/**/*.test.ts
node --import tsx --test tests/chat.test.ts              # single test file
node --import tsx --test tests/chat.test.ts -t "onSources" # single test by name pattern
npx tsc --noEmit       # typecheck only
```

Full local run needs three processes, none of which survive a session switch:
1. MADE (separate repo, `/home/naufa/workspace/MODE`): `.venv/bin/python -m uvicorn api.main:app --port 8000`
2. Ollama: `ollama serve` — **must set `OLLAMA_CONTEXT_LENGTH=8192` or higher**, or GenOffice's AI panel silently returns empty content (its combined system prompt + tool schemas eat almost all of Ollama's default 4096-token context window before the model gets to respond). Not persisted across restarts since Ollama isn't run as a service here — re-set it every time.
3. This project: `npm install && npm run dev`

Or the whole stack via Docker: `cp .env.example .env` (`env_file: .env` is not optional for `docker compose up`) then `docker compose up --build`. Compose brings up `app`, `searxng`, `scrapling`, `made`, and `open-webui`. `OLLAMA_BASE_URL` inside Docker points at `host.docker.internal` — Ollama itself still runs on the host, not in a container. Rebuild (`--build`) after any dependency change or `git merge` — a plain `docker compose up` reuses stale images and a plain `git merge` doesn't run `npm install`, so `node_modules` silently goes stale after pulling.

Open WebUI is reachable at `http://localhost:3001`; `WEBUI_SECRET_KEY` must be set in `.env` or the container refuses to start (see `.env.example`). The first account created via sign-up becomes admin. LLM providers (e.g. DeepSeek) are configured entirely inside Open WebUI's Admin Settings post-login, not via `.env`—this project deliberately keeps zero LLM provider secrets in scope.

**MADE-routing setup (one-time, manual, after `open-webui` is up):**
1. Create an automation admin account by signing up a second time with a
   dedicated email (or reuse your first admin account) — put its
   credentials in `.env` as `OPENWEBUI_ADMIN_EMAIL`/`OPENWEBUI_ADMIN_PASSWORD`.
2. Ensure `MADE_URL` and `CLASSIFIER_MODEL` are set in `.env` (see `.env.example`).
   The provisioning script uses these to configure the Filter's valves.
3. Run `node --import tsx src/openwebui-provision.ts` to install the
   MADE-routing Filter (`openwebui-filters/made_routing.py`) into Open
   WebUI. The script automatically:
   - Creates a long-lived API key for the Filter to use (avoids JWT expiry issues)
   - Creates or updates the Filter function with its content
   - Provisions the Filter's configuration (MADE_URL, Open WebUI URL, token, classifier model)
   Re-run this any time the Filter's source changes, or after a fresh volume/deploy.
4. In Open WebUI's Admin Settings → Models, create the tier models for
   each brand (e.g. `deepseek-v4-flash`, `deepseek-v4-pro`), each with a
   `meta.made_scores` object containing cost and performance metrics.
   **IMPORTANT:** Every tier MUST include `cost_per_1k_tokens` (numeric, lower=better).
   **Critical:** When creating each tier model, grant public read access via the
   `access_grants` field in the create payload: `"access_grants": [{"principal_type": "anyone", "principal_id": "*", "permission": "read"}]`.
   This grant is set once and never revoked — tiers remain publicly dispatchable at all times,
   regardless of MADE's health status. If Open WebUI's UI doesn't expose this field, create tiers
   via direct `POST /api/v1/models/create` call instead (token obtained via `POST /api/v1/auths/signin`):
   ```bash
   curl -X POST http://localhost:3001/api/v1/models/create \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "deepseek-v4-flash",
       "name": "DeepSeek Flash",
       "meta": {"made_scores": {"brand": "deepseek", "cost_per_1k_tokens": 0.0005, "quality": 0.6, "latency": 10, "business_risk": 0.1, "context_window_tokens": 32000}},
       "params": {},
       "access_grants": [{"principal_type": "anyone", "principal_id": "*", "permission": "read"}]
     }'
   ```
5. Create one brand entry per brand (e.g. id `deepseek`) — `base_model_id`
   pointing at any one of that brand's tiers (MADE overrides it on every
   call while healthy). The brand entry's `meta.made_scores` MUST contain
   ONLY `{ "brand": "deepseek" }` with NO `cost_per_1k_tokens`.
   This discriminator is how the Filter and health monitor recognize the
   brand entry from tier entries.
6. The health monitor runs automatically if `OPENWEBUI_ADMIN_EMAIL` and
   `OPENWEBUI_ADMIN_PASSWORD` are set in `.env` (same account from step 1).
   It signs in fresh on each check, avoiding token expiry issues.
   The monitor checks MADE's health and toggles only the brand entry's visibility:
   - MADE healthy: brand entry active (users select the brand, filter routes to tiers via MADE)
   - MADE unhealthy: brand entry inactive (tiers are directly selectable as fallback, always public)

**Score polarity (for MADE's TOPSIS):**
  - `cost_per_1k_tokens`: raw USD amount, lower is better (e.g., 0.0005, 0.003)
  - `quality`: 0-1 scale, higher is better (e.g., 0.6, 0.9)
  - `latency`: raw milliseconds (or seconds), lower is better (e.g., 10, 100)
  - `business_risk`: 0-1 scale, lower is better (0=no risk)

GenOffice (`genoffice/`) is its own npm workspace root, vendored separately — `cd genoffice && npm install` before touching anything under it. Its own commands: `npm run typecheck` / `npm run test -- --run` (vitest) scoped per-app, e.g. `cd genoffice/apps/docs && npm run typecheck`.

## Architecture

**Request flow:** every chat/agent-turn request first calls MADE's `POST /decide` (a separate Python/FastAPI service from an unrelated thesis repo, reached only over HTTP — never import its code) to pick which model and which tools are allowed for that request, based on cost/quality/latency/risk policy (Rego hard constraints + TOPSIS soft ranking). Only after MADE approves does the code call a provider client (`src/providers/ollama-client.ts` or `deepseek-client.ts`) or execute a tool. `MADE returned no eligible candidate` / `requires human approval` from that response are real control-flow branches, not edge cases — always check them before assuming a model/tool is usable.

**Two entry points, one shared tool-calling core:**
- `src/chat.ts`'s `handleChat()` — the standalone chat page (`/`, `client/src/chat/ChatApp.tsx`), owns its own multi-turn history with mechanical token-budget trimming (`src/history-budget.ts`, `HISTORY_BUDGET_TOKENS`).
- `src/agent-turn.ts`'s `handleAgentTurn()` — used by GenOffice's document AI panel (`/document`). Distinguishes **server-executed tools** (`web_search`, `scrape` — resolved internally via SearXNG/Scrapling MCP, the caller never sees them) from **client-executed tools** (GenOffice's own document-editing tools — returned to the caller unexecuted as `{type:"tool_calls"}` for it to run and continue the turn with the result).

Both loops accept optional `streamCallbacks` (`onDelta`, `onToolCallDelta`, `onToolResult`, `onSources`) — when present, provider clients stream via SSE (`completeStream()` in each `src/providers/*-client.ts`) instead of one-shot `complete()`. `src/server.ts` is the only place that turns these callbacks into wire events: a persistent WebSocket at `/ws`, one connection per page session, turn-based protocol keyed by a server-generated `turnId` with monotonic per-turn `seq` numbers. Events are buffered (capped, evicted after completion) so a client can `{type:"resume", turnId, lastSeq}` after a reconnect and replay only what it missed — `ChatApp.tsx` implements this; GenOffice's `transport.ts` deliberately does not (a mid-turn disconnect there errors cleanly instead of hanging, but never auto-resumes).

**Web search citations:** `src/mcp/searxng-client.ts`'s `callWebSearch()` asks `mcp-searxng` for `response_format:"json"` and returns structured `WebSearchResult[]` (not raw text). `src/web-search-format.ts` turns that into a numbered `[N]` citable block, with the numbering offset threaded per-turn through `chat.ts`/`agent-turn.ts` so multiple searches in one turn don't collide. Both UIs render `[N]` markers as clickable chips backed by the matching structured result — see `docs/superpowers/specs/2026-08-12-inline-citations-design.md` before touching this again, and note the citation-state lifetime gotcha recorded there and in the Obsidian note of the same date (GenOffice's citation counter is module-level/session-scoped in `tools.ts`, while the UI-side accumulator has to be kept in lockstep with it — this exact class of bug has bitten twice).

**GenOffice** (`genoffice/`) is a vendored (not submoduled — its own `.git` was removed) Apache-2.0 Electron office suite, run here as a plain browser page instead of packaged Electron. Its Electron IPC bridge (`window.desktop`/`window.projectApi`) is replaced by `genoffice/apps/docs/src/renderer/desktop-stub.ts` — anything that stub doesn't implement (currently: `image_search`, real `.docx` file save, PDF export, and a few others) fails or no-ops rather than throwing. When `desktop-stub.ts` needs to reach a real backend capability (as `webSearch` now does), it calls this project's own `/api/*` routes, same-origin — GenOffice's own build (`genoffice/apps/docs`'s Vite/Electron config) is not otherwise involved in serving `/document`; this repo's own `vite.config.ts` resolves GenOffice's renderer source and builds it into `client/dist/document.html` alongside the chat page. GenOffice has its own `CLAUDE.md` (theming token rules, main-vs-renderer build gotchas) — read it before editing anything under `genoffice/`.

**MADE integration specifics:** `decide()` calls take `DecideRequest{task, org, decision_kind, candidates, policy_set}`. `decision_kind` is `"model_selection" | "tool_selection" | "human_approval"`. `src/context-guard.ts`'s `ensureCandidateFits()` re-checks capacity mid-loop (not just at the start of a turn) and can switch models if a growing conversation would exceed the current model's context window — it re-derives its `DecideRequest` from a caller-supplied `baseRequest` rather than building its own, specifically to avoid drifting from whatever policy classification the caller already established.

## Workflow

This repo is developed via the [superpowers](https://github.com) skill workflow: brainstorming → design spec (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`) → implementation plan (`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`) → subagent-driven-development (fresh subagent per task, task-scoped review, final whole-branch review) → finishing-a-development-branch. Feature branches happen in a worktree under `.worktrees/` (gitignored) with a per-plan ledger under `.superpowers/sdd/` (gitignored, deleted on successful merge). Skim recent files under `docs/superpowers/` before starting related work — they're the authoritative record of what was actually decided and why, more current than any older design doc that later got superseded (e.g. the original top-level design spec chose Univer as the document editor; that was later reversed in favor of GenOffice — trust the most recent dated doc, not the oldest one).

Both `src/chat.ts` and `src/agent-turn.ts` deliberately duplicate the same tool-loop shape rather than sharing an abstraction — they diverge just enough (client-vs-server tool split, history handling) that a shared abstraction was rejected during planning. Match this existing duplication pattern rather than trying to unify it.

**Model selection by workflow phase:** brainstorming uses Sonnet; writing specs and plans uses Haiku; writing code (implementer subagent dispatches) uses Haiku; review (task review, re-review, final whole-branch review) uses Sonnet. **Sonnet is the maximum model tier for any subagent dispatch in this repo — never dispatch on Opus, including for the final whole-branch review** (overriding subagent-driven-development's own "most capable available model" guidance for that step). This fixed mapping overrides the skill's default per-task-complexity model picks generally.
