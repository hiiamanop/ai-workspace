# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Obsidian note-keeping (required)

After finishing any non-trivial piece of work on this repo (a shipped feature, a bug fix, a design decision, an investigation with a real conclusion) — not just internal memory — also write or update a note in the user's Obsidian vault at:

```
/mnt/c/Users/naufa/Documents/Obsidian Vault/Projects/ai-workspace/
```

- One markdown file per piece of work, named `YYYY-MM-DD-<topic>.md`.
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

Full local run needs two processes, neither of which survives a session switch:
1. MADE (separate repo, `/home/naufa/workspace/MODE`): `.venv/bin/python -m uvicorn api.main:app --port 8000`
2. This project: `npm install && npm run dev`

This project's own chat (`chat.ts`) is DeepSeek-only (API-token based, via `DEEPSEEK_API_KEY` in `.env`) — there is no local model provider.

Or the whole stack via Docker: `cp .env.example .env` (`env_file: .env` is not optional for `docker compose up`) then `docker compose up --build`. Compose brings up `app`, `searxng`, `scrapling`, `made`, and `open-webui`. Rebuild (`--build`) after any dependency change or `git merge` — a plain `docker compose up` reuses stale images and a plain `git merge` doesn't run `npm install`, so `node_modules` silently goes stale after pulling.

Open WebUI is reachable at `http://localhost:3001`; `WEBUI_SECRET_KEY` must be set in `.env` or the container refuses to start (see `.env.example`). The first account created via sign-up becomes admin. LLM providers (e.g. DeepSeek) are configured entirely inside Open WebUI's Admin Settings post-login, not via `.env`—this project deliberately keeps zero LLM provider secrets in scope.

**Provisioning is auto-reconciled, not just a one-time script.** If
`OPENWEBUI_ADMIN_EMAIL`/`OPENWEBUI_ADMIN_PASSWORD` are set, `server.ts`
starts `src/openwebui-provisioning-reconciler.ts` alongside the health
monitor — it re-runs `provisionFilter()`/`provisionTools()` every 5 minutes
(immediately on startup, then on an interval), tolerating Open WebUI/MADE
being briefly unreachable the same way the health monitor does. This is
what keeps the Filter and Tools registered after a fresh `open-webui-data`
volume, a container recreate, or a source change to `made_routing.py`,
without a human remembering to re-run the CLI scripts. The manual steps
below are for **initial setup** (creating the account, the tier/brand
models) — steps 3 and the tools-provisioning script still work standalone
for a one-off run (e.g. to verify a change immediately instead of waiting
up to 5 minutes), but aren't required for steady-state operation anymore.

**Complexity classification is a length heuristic, not an LLM call.**
`made_routing.py`'s `_classify_complexity()` used to make a full extra chat
completion per message just to get one word (low/medium/high) out —
doubling the cost of every turn. It's now synchronous and free: message
length + word count against fixed thresholds. Less precise, but MADE's own
soft ranking already absorbs classification error; not worth an LLM call.

**MADE-routing setup (one-time, after `open-webui` is up):**
1. Create an automation admin account by signing up a second time with a
   dedicated email (or reuse your first admin account) — put its
   credentials in `.env` as `OPENWEBUI_ADMIN_EMAIL`/`OPENWEBUI_ADMIN_PASSWORD`.
2. Ensure `MADE_URL` is set in `.env` (see `.env.example`). The provisioning
   script uses it to configure the Filter's valves.
3. Run `node --import tsx src/openwebui-provision.ts` to install the
   MADE-routing Filter (`openwebui-filters/made_routing.py`) into Open
   WebUI (the reconciler above does this automatically too, but a manual
   run reflects a source change right away). The script automatically:
   - Creates a long-lived API key for the Filter to use (avoids JWT expiry issues)
   - Creates or updates the Filter function with its content
   - Provisions the Filter's configuration (MADE_URL, Open WebUI URL, token)
   Re-run this any time the Filter's source changes, or after a fresh volume/deploy.
4. In Open WebUI's Admin Settings → Models, create the tier models for
   each brand (e.g. `deepseek-v4-flash`, `deepseek-v4-pro`), each with a
   `meta.made_scores` object containing cost and performance metrics.
   **IMPORTANT:** Every tier MUST include `cost_per_1k_tokens` (numeric, lower=better).
   **Critical:** When creating each tier model, grant access to every logged-in Open WebUI user via the
   `access_grants` field in the create payload: `"access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}]`.
   This grant is set once and never revoked — tiers remain dispatchable at all times,
   regardless of MADE's health status. If Open WebUI's UI doesn't expose this field, create tiers
   via direct `POST /api/v1/models/create` call instead (token obtained via `POST /api/v1/auths/signin`):
   ```bash
   curl -X POST http://localhost:3001/api/v1/models/create \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "deepseek-v4-flash",
       "name": "DeepSeek Flash",
       "base_model_id": "deepseek-v3",
       "meta": {"made_scores": {"brand": "deepseek", "cost_per_1k_tokens": 0.0005, "quality": 0.6, "latency": 10, "business_risk": 0.1, "context_window_tokens": 32000}},
       "params": {},
       "access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}]
     }'
   ```
   **IMPORTANT:** `base_model_id` MUST be set to an actual model id as it appears in Open WebUI's
   Admin Settings → Connections (e.g., the real DeepSeek model identifier configured in that connection).
   Without it, the tier will be created but excluded from model listings and dispatching. Look up your
   actual provider model ids in Admin Settings before creating tiers.
5. Create one brand entry per brand (e.g. id `deepseek`) — `base_model_id`
   pointing at any one of that brand's tiers (MADE overrides it on every
   call while healthy). The brand entry's `meta.made_scores` MUST contain
   ONLY `{ "brand": "deepseek" }` with NO `cost_per_1k_tokens`. Name it
   `"<Brand> (auto)"` (e.g. `"DeepSeek (auto)"`) so it's explicit in the
   model picker that selecting it hands the tier choice to MADE.
   This discriminator is how the Filter and health monitor recognize the
   brand entry from tier entries.
6. The health monitor **and** the provisioning reconciler run automatically
   if `OPENWEBUI_ADMIN_EMAIL` and `OPENWEBUI_ADMIN_PASSWORD` are set in
   `.env` (same account from step 1). Both sign in fresh on each cycle,
   avoiding token expiry issues. The health monitor checks MADE's health
   and toggles only the brand entry's visibility:
   - MADE healthy: brand entry active (users select the brand, filter routes to tiers via MADE)
   - MADE unhealthy: brand entry inactive (tiers are directly selectable as fallback, always public)

**Score polarity (for MADE's TOPSIS):**
  - `cost_per_1k_tokens`: raw USD amount, lower is better (e.g., 0.0005, 0.003)
  - `quality`: 0-1 scale, higher is better (e.g., 0.6, 0.9)
  - `latency`: raw milliseconds (or seconds), lower is better (e.g., 10, 100)
  - `business_risk`: 0-1 scale, lower is better (0=no risk)

**Policy authoring UI (C2, admin-only):** `open-webui/src/routes/(app)/workspace/policies/` — list, `[id]` editor (split-pane Markdown/Rego with live compile + autosave), and `new`. Backed by C1's `/api/v1/policies*` endpoints. Gotchas when touching it: timestamps are epoch-ns BigInts (format via `$lib/utils/policies.ts::formatEpochNs`); C1's compile endpoint compiles the policy's **saved** markdown, so the editor always saves before compiling; policy rename is not supported by the backend (PUT only takes `markdown_content`). Admin-only tab in `(app)/workspace/+layout.svelte`; non-admins are redirected to `/`.

**Markdown→Rego compile is deterministic, not an LLM call.** `src/openwebui-policy-compiler.ts`'s `compilePolicy()` parses a fixed syntax — `IF <condition>\n[AND <condition>]...\nTHEN deny "<message>"`, everything else in the Markdown (headings, prose) is ignored as documentation — and generates the Rego with plain string templating. No hallucination risk: a well-formed policy compiles the same way every time, a malformed one fails with a line-numbered `CompileError`. This used to call DeepSeek; changed because free-text-to-Rego via LLM was judged too much unreviewable trust for a hard-constraint policy engine. Grammar: a condition is `<field>` (bare = true-check), `NOT <field>`, `<field> <op> <value>` (op one of `== != > < >= <=`), or `<field> IN [<value>, ...]` (compiles to a Rego set-membership check), each optionally `NOT`-prefixed; fields must be `decision_kind` or start with `task.`/`candidate.`/`org.`; values are double-quoted strings, numbers, or `true`/`false`.

**Chat-assisted policy drafting (still uses an LLM, deliberately — only to write the Markdown, never the Rego):** `openwebui/src/lib/components/workspace/Policies/PolicyDraftChat.svelte` is a chat panel embedded in both the `new` and `[id]` policy pages (hidden when a policy is active/locked) — type a request in plain language, or upload a regulation document (`.txt/.md/.pdf/.docx`, extracted via Open WebUI's own existing file-upload pipeline, no new parser built for this) and it's attached to the next message. Backed by `src/policy-drafter.ts`'s `draftPolicy()` (DeepSeek call) and proxied through `POST /api/v1/policies/draft` (admin-only, stateless — full message history resent each turn, nothing persisted server-side) in `open_webui/routers/policies.py`. The system prompt teaches the model the exact IF/THEN grammar above; critically, `draftPolicy()` runs the real deterministic `compilePolicy()` against any fenced draft the model produces **before** reporting it as ready — a draft that doesn't actually compile is never surfaced as a usable draft, its `CompileError` message is appended to the chat reply instead so the next turn can fix the exact line. This closes the loop without a second LLM round-trip (compiling is free/synchronous now). The extracted draft only ever fills the page's Markdown textarea for human review — it still has to pass through the same compile/deploy buttons as any hand-written policy.

**Tools registration:** `src/openwebui-provision-tools.ts` provisions six native Open WebUI Tools (`node --import tsx src/openwebui-provision-tools.ts`), all in `TOOL_DEFINITIONS`, two valve shapes:
- `web_search`, `scrape`, `memory` — call back into this project's own `/api/*` routes (`backend_url` valve, default `http://app:3000`; host-dev: `OPENWEBUI_BACKEND_URL=http://localhost:3000`). `memory` (`remember`/`recall`) is this project's own feature (`src/memory-store.ts`, `node:sqlite`, `MEMORY_DB_PATH` — not a proxy to Open WebUI's own `memories.py`, see below) — scoped per user via the `__user__` special parameter Open WebUI injects into Tool methods (excluded from the schema the model sees; confirmed live).
- `knowledge_search`, `read_file`, `generate_image` — call Open WebUI's *own* REST API (`/api/v1/retrieval/query/collection`, `/api/v1/files/{id}/data/content`, `/api/v1/images/generations`) using a shared admin API key (`openwebui_url`/`openwebui_token` valves). `generate_image` will 403 until an image generation backend is actually configured in Open WebUI's Admin Settings — nothing here does that. `read_file` matters mainly when a model's `file_context` capability is off (Open WebUI auto-injects attached-file content into the prompt by default already).

**Why not proxy to Open WebUI's own `memories.py`:** Tools only receive `__user__` as profile data (id/name/email/role, from `UserModel.model_dump()`) — never an auth token. Open WebUI's own memories endpoints require `Depends(get_verified_user)`, i.e. a real per-user token Tools don't have. Using the shared admin key there would collapse every chat user's memories into one admin account. `src/memory-store.ts` sidesteps this entirely by trusting the plain `user_id` string (no token needed — Open WebUI's own tool-execution boundary already authenticated the caller).

**The shared admin API key is a single slot, not a list — mint once per provisioning run, not once per thing provisioned.** `POST /api/v1/auths/api_key` *overwrites* Open WebUI's one stored key for that admin user; it does not append. `src/openwebui-auth.ts`'s `mintApiKey()` exists so `src/openwebui-provisioning-reconciler.ts` can mint exactly once per cycle and hand the same key to both `provisionFilter()` and `provisionTools()` — minting independently in each would have the second call silently invalidate the key the first one just wrote into its valve. Both `provisionFilter`/`provisionTools` still accept an optional `openwebuiToken` override for this; omit it (as their standalone CLI entry points do) and each mints its own.

Idempotent: creates, updates when source or `made_scores` differ, skips when up-to-date (valves always re-applied). Requires `OPENWEBUI_ADMIN_EMAIL`/`OPENWEBUI_ADMIN_PASSWORD` in `.env`. A newly created model's `meta.toolIds` is **not** set automatically — attach the tool ids you want to a model (`POST /api/v1/models/model/update?id=<id>`) or the model won't see the tools exist at all, regardless of what's registered.

**MADE-driven tool selection ("Auto"):** each tool's `meta.manifest.made_scores` (set by the provisioning script above, scores copied from `src/candidates.ts`'s `WEB_SEARCH_CANDIDATE`/`SCRAPE_CANDIDATE`) is what lets `made_routing.py` treat tools the same way it treats model tiers. The chat UI's tools menu (`IntegrationsMenu.svelte`) has a synthetic "Auto (MADE decides)" entry, mutually exclusive with manually-picked tools; selecting it sends `tool_ids: ["auto"]`. The Filter's `inlet()` sees that sentinel, calls MADE with `decision_kind: "tool_selection"` using every tool's `made_scores` as candidates, and replaces `tool_ids` with **every id in the response's `ranking`** (not just the top one — multiple tools can be usable in one turn, unlike model selection). Fails closed (`tool_ids: []`) if MADE is unreachable or has no scored candidates — there's no safe "cheapest tool" fallback the way model routing has one.

## Architecture

**Request flow:** every chat request first calls MADE's `POST /decide` (a separate Python/FastAPI service from an unrelated thesis repo, reached only over HTTP — never import its code) to pick which model and which tools are allowed for that request, based on cost/quality/latency/risk policy (Rego hard constraints + TOPSIS soft ranking). Only after MADE approves does the code call a provider client (`src/providers/deepseek-client.ts`) or execute a tool. `MADE returned no eligible candidate` / `requires human approval` from that response are real control-flow branches, not edge cases — always check them before assuming a model/tool is usable.

**Entry point:** `src/chat.ts`'s `handleChat()` — the standalone chat page (`/`, `client/src/chat/ChatApp.tsx`), owns its own multi-turn history with mechanical token-budget trimming (`src/history-budget.ts`, `HISTORY_BUDGET_TOKENS`). Accepts optional `streamCallbacks` (`onDelta`, `onToolCallDelta`, `onToolResult`, `onSources`) — when present, the provider client streams via SSE (`completeStream()` in `src/providers/deepseek-client.ts`) instead of one-shot `complete()`. `src/server.ts` is the only place that turns these callbacks into wire events: a persistent WebSocket at `/ws`, one connection per page session, turn-based protocol keyed by a server-generated `turnId` with monotonic per-turn `seq` numbers. Events are buffered (capped, evicted after completion) so a client can `{type:"resume", turnId, lastSeq}` after a reconnect and replay only what it missed — `ChatApp.tsx` implements this.

**Web search citations:** `src/mcp/searxng-client.ts`'s `callWebSearch()` asks `mcp-searxng` for `response_format:"json"` and returns structured `WebSearchResult[]` (not raw text). `src/web-search-format.ts` turns that into a numbered `[N]` citable block, with the numbering offset threaded per-turn through `chat.ts` so multiple searches in one turn don't collide. `ChatApp.tsx` renders `[N]` markers as clickable chips backed by the matching structured result — see `docs/superpowers/specs/2026-08-12-inline-citations-design.md` before touching this again.

**MADE integration specifics:** `decide()` calls take `DecideRequest{task, org, decision_kind, candidates, policy_set}`. `decision_kind` is `"model_selection" | "tool_selection" | "human_approval"`. `src/context-guard.ts`'s `ensureCandidateFits()` re-checks capacity mid-loop (not just at the start of a turn) and can switch models if a growing conversation would exceed the current model's context window — it re-derives its `DecideRequest` from a caller-supplied `baseRequest` rather than building its own, specifically to avoid drifting from whatever policy classification the caller already established.

**MADE's privacy subsystem (`MADE/core/privacy/`):** `POST /privacy/redact` / `POST /privacy/restore` — reversible pseudonymization, not a vector-DB/RAG feature (that was scoped out, see `docs/PRD-confidentiality-pipeline.md`'s "No vector store" note). `detectors.py` combines regex (email/phone/ID-number/card-number, card numbers Luhn-validated) with spaCy NER (`en_core_web_sm`, PERSON/ORG/GPE) — regex wins on overlap. `pseudonymizer.py` persists placeholder↔original mappings in the `entity_mappings` table (same SQLite engine as `DecisionRecord`), keyed by `(org_id, sha256(original_value))` so the same value always gets the same placeholder; original values are Fernet-encrypted at rest, keyed by the **required** `MADE_MAPPING_ENCRYPTION_KEY` env var (redact/restore raise `MissingEncryptionKeyError` without it — other MADE endpoints are unaffected).

**Confidential-redaction Filter (Phase 3, Open WebUI's chat path):** `openwebui-filters/confidential_redaction.py` is a second Filter (separate from `made_routing.py`) whose `inlet()` calls MADE's `/privacy/redact` on every user message and whose `outlet()` calls `/privacy/restore` on every message in the response. `org_id` for the per-org entity-mapping scope is the requesting user's id (`__user__.id` — no auth token needed, same as any Tool). When it actually redacts something it sets `body["_privacy"] = {"data_classification": "confidential", "redacted": True}`; `made_routing.py`'s `_call_made()` reads that (falling back to `"internal"`/not-redacted when absent, so it still works standalone) and forwards it to MADE's `/decide`, which is what lets `external_vendor.rego`'s deny rule actually engage. Must run before `made_routing.py` for that signal to exist in time — `Valves.priority` defaults to `-10` (Open WebUI sorts filters ascending by priority; `made_routing.py` defaults to `0`). Provisioned by `src/openwebui-provision-redaction.ts`'s `provisionRedactionFilter()` — simpler than `provisionFilter()` since this Filter's valves are just `MADE_URL`/`REQUEST_TIMEOUT_SECONDS` (it never calls back into Open WebUI's own API, so no admin API key is needed at all — though the reconciler still passes it the shared token, to reuse the signin from minting rather than sign in a fourth time per cycle). Wired into `src/openwebui-provisioning-reconciler.ts`'s `reconcileOnce()` alongside the other two provisioners. `chat.ts` (ai-workspace's own standalone chat page) is not wired up — deprioritized, Open WebUI is the primary chat surface.

## Workflow

No mandatory spec/plan/subagent-review ritual for this repo. Work directly on requests like a senior engineer: read the relevant code, make the change, verify it (run tests/typecheck, or check the diff), report what changed. Reserve upfront design discussion for genuinely ambiguous or high-blast-radius changes — ask a targeted question or state the tradeoff in a sentence, don't produce a brainstorm/spec/plan document for it. Don't spawn subagents or worktrees for routine work; do it inline.

`docs/superpowers/` holds historical specs/plans from when this repo used that process — still useful as a record of past decisions, but nothing new needs to be added there.
