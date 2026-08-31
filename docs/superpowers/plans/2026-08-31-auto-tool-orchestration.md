# Auto Tool Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Open WebUI Auto Pipe execute MADE-approved web tools before producing a final OmniRouter answer, and repair the MADE Fernet encryption configuration.

**Architecture:** Keep MADE as the model/tool policy gate. The Auto Pipe will detect the selected tool, call the existing ai-workspace backend route (`/api/web-search` or `/api/scrape`), append the returned evidence as a message, then send the enriched request to OmniRouter. The provider key remains in `.env`; no provider credential is copied into Open WebUI valves by this change.

**Tech Stack:** Python Open WebUI Pipe, TypeScript Node backend, MCP-backed SearXNG/Scrapling routes, FastAPI MADE, Docker Compose, Node test runner.

**Spec:** Approved in conversation on 2026-08-31; prior design at `docs/superpowers/plans/2026-08-31-auto-tool-orchestration.md`.

## Global Constraints

- MADE `/decide` must run before any tool execution.
- Only tools present in MADE's approved ranking may execute.
- Search and scrape failures must be represented to the model; never fabricate tool results.
- Do not print, commit, or persist API keys outside `.env`.
- Preserve the existing Docker service names and internal URLs.
- Use a valid Fernet key for `MADE_MAPPING_ENCRYPTION_KEY`; old encrypted mappings are not recoverable after key rotation.

---

### Task 1: Add a backend tool-orchestration contract

**Files:**
- Modify: `openwebui-filters/made_multimodal.py` source of truth if present, or the provisioning source that installs the live `made_multimodal` Pipe.
- Test: `tests/` existing Open WebUI provisioning/Pipe-related tests, adding the smallest regression test available in this repository.

**Interfaces:**
- Consumes: `body`, selected `tool_ids`, MADE-ranked model ids, and `UPSTREAM_BASE_URL`/`UPSTREAM_API_KEY` valves.
- Produces: an async stream whose request sequence is MADE decision → approved backend tool call → enriched OmniRouter completion.

- [ ] **Step 1: Add a failing test** asserting a search request causes a backend `POST /api/web-search` call and that its result is included in the subsequent completion messages.
- [ ] **Step 2: Run the focused test and verify it fails because the current Pipe only forwards `tool_ids` and never calls the backend tool route.**
- [ ] **Step 3: Add minimal Pipe helpers:** `_approved_tool_ids`, `_run_approved_tools`, and `_enrich_with_tool_results`; call them after `_decide` and before `_stream_with_fallback`. Use `web_search` only when MADE's ranking contains it, send `{query: last_user_prompt}`, and append a clearly delimited tool-result message containing structured JSON.
- [ ] **Step 4: Keep `_stream` responsible only for completion transport; ensure forwarded JSON does not include unresolved `tool_ids`/`auto` sentinel values and retains the selected model id.
- [ ] **Step 5: Run the focused test and verify it passes.**

### Task 2: Preserve and provision the Pipe source correctly

**Files:**
- Modify: the TypeScript provisioning source that owns `made_multimodal` if one exists.
- Test: corresponding provisioning test.

**Interfaces:**
- Consumes: Pipe source and existing Open WebUI admin provisioning flow.
- Produces: an idempotent update that installs the orchestration-enabled Pipe without overwriting upstream values unexpectedly.

- [ ] **Step 1: Verify the live Pipe source is represented in a repository source-of-truth; if not, extract the current live content into the existing provisioning module rather than creating a second Pipe id.**
- [ ] **Step 2: Add a regression assertion that provisioning content contains the orchestration path and backend route, while still declaring `UPSTREAM_BASE_URL` and `UPSTREAM_API_KEY` valves.
- [ ] **Step 3: Provision/update the Pipe through the existing reconciler, reusing the already minted Open WebUI admin key.**
- [ ] **Step 4: Verify the live Pipe is active and its non-secret URL valves remain correct; never print secret valve values.**

### Task 3: Repair the MADE Fernet key and verify privacy endpoints

**Files:**
- Modify: `.env` only for the local secret value; do not commit it.
- Modify: `.env.example` only if its guidance needs correction.

**Interfaces:**
- Consumes: `MADE_MAPPING_ENCRYPTION_KEY` from Compose `env_file`.
- Produces: valid Fernet encryption/decryption for `/privacy/redact` and `/privacy/restore`.

- [ ] **Step 1: Generate a fresh Fernet key locally and replace the invalid local `.env` value without displaying the value.**
- [ ] **Step 2: Recreate `made` so Compose loads the new environment value.**
- [ ] **Step 3: POST a harmless email-containing text to `/privacy/redact`, then POST the returned placeholder text to `/privacy/restore`; assert both return HTTP 200 and restored text matches the original.**
- [ ] **Step 4: Record that old mappings encrypted with the invalid/previous key are intentionally not used; do not delete persistent data without explicit approval.**

### Task 4: End-to-end verification

**Files:**
- Modify: required Obsidian project note under the configured vault path after a real conclusion.

- [ ] **Step 1: Run TypeScript tests, typecheck, and production build.**
- [ ] **Step 2: Rebuild/recreate `app`, `made`, and `open-webui` so the provisioned Pipe is current.**
- [ ] **Step 3: Verify `GET /candidates`, `POST /decide`, `/api/web-search`, and authenticated Scrapling fetch remain healthy.**
- [ ] **Step 4: Inspect logs for a real Auto request and confirm MADE calls precede a tool call and final completion; confirm no “I will search” response is emitted without tool evidence.**
- [ ] **Step 5: Update the dated Obsidian note with the shipped orchestration and key-rotation conclusion, without including secrets.**
