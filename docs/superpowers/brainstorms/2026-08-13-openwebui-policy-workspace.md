# Brainstorm: Sub-project C' (Policy Workspace in Open WebUI)

**Date:** 2026-08-13  
**Scope:** Add "Policy" category to Open WebUI's Workspace, enabling policy authoring via Markdown + LLM-compile-to-Rego.

## Problem Statement

Currently:
- MADE's governance runs on hard Rego policies authored by developers (static, in version control)
- No end-user or ops-team way to author/test/deploy policies without code (and developer review cycle)
- Open WebUI has a mature Workspace with 5 categories (Models, Knowledge, Prompts, Tools, Skills), each with native CRUD UI + editor
- Policy should be a 6th category, following the same pattern

**Goal:** Let non-engineers author policies in Markdown, auto-compile to Rego, review before live deployment.

**Anti-goal (explicitly rejected by user):** Do NOT use RAG-at-decision-time (probabilistic policy interpretation). Policies must be deterministic/auditable — compile once, review, activate.

---

## Three Approaches

### Approach 1: "Policy-as-Skills" — Reuse Open WebUI's Skills workspace, store policies there
**Idea:** Open WebUI already has a Skills workspace (custom Python functions). Store policies as special Skills entries, use its editor and CRUD.

**Implementation:**
- Add a "policy" type to Skills (alongside "function", if Skills already has types)
- On save, trigger LLM compile step (Skills endpoint hooks into our backend)
- Show compilation result (Rego preview) for human review
- Activation = toggle a "deployed" flag on the Skill entry

**Pros:**
- Reuses existing Skills infrastructure (no new workspace category needed)
- Open WebUI already has editor, versioning, CRUD
- Minimal new code (just compile hook + deploy toggle)
- Follows "composition over new categories" principle

**Cons:**
- Conflates two distinct things (executable Skills, policy rules)
- Skills are meant for tool definitions, not governance policies
- Skills workspace UI might not expose the Rego preview/review UX we want
- Hard to distinguish policies from tools for users

**Tradeoff:** Minimal code, but semantically weird. UX might be confusing.

---

### Approach 2: "Parallel Category" — Add Policy as a true 6th Workspace category
**Idea:** Follow Open WebUI's pattern for adding Skills (backend model + router + frontend route). Policy is a first-class workspace type with its own UI, editor, compile preview, and review flow.

**Implementation (Backend):**
- New `Policy` model in `open-webui/models/` (id, name, markdown_content, compiled_rego, status: draft|review|active, last_reviewer, reviewed_at)
- New router in `open-webui/routers/` with endpoints:
  - `POST /api/v1/policies` — create
  - `GET /api/v1/policies/:id` — retrieve
  - `POST /api/v1/policies/:id/compile` — trigger LLM compile, save Rego preview (backend calls our `/api/compile-policy` endpoint)
  - `POST /api/v1/policies/:id/review` — human review approval
  - `POST /api/v1/policies/:id/activate` — deploy to MADE (backend calls MADE's policy-deployment endpoint)

**Implementation (Frontend):**
- New SvelteKit route `+page.svelte` in `open-webui/src/routes/workspace/policies/`
- List view (all policies, filter by status: draft/review/active)
- Editor view (Markdown input + live Rego preview pane)
- Review UI (show Rego diff, approve/reject with comments)

**Implementation (Sync with MADE):**
- On activation, POST compiled Rego to MADE's `PUT /policies/hard/<policy-id>` (assumed endpoint, verify)
- Store activation timestamp + compiled Rego version in Policy model
- If MADE rejects, show error, keep in review status (don't auto-activate)

**Pros:**
- Clean, semantically correct: policies are policies, not tools
- First-class UX: dedicated editor, status tracking, review flow
- Extensible: can add version history, rollback, A/B testing later
- Follows Open WebUI's existing pattern (Skills category as reference)

**Cons:**
- More code: new model, router, frontend route, compile step, MADE sync
- Need to define Policy model schema + Open WebUI DB migration
- Needs testing at integration level (compile LLM call, MADE endpoint, review flow)
- Higher implementation complexity

**Tradeoff:** Proper semantic fit, good UX, but requires more code.

---

### Approach 3: "External Policy Service" — Policy stays outside Open WebUI, linked via iframe
**Idea:** Policies are managed in a separate tool/service (could be a simple Markdown → Rego editor running in this project's Node backend). Open WebUI just links to it via an admin-only iframe/popup.

**Implementation:**
- Create minimal policy editor service in `src/` (React component or simple form)
- Route: `/api/policy-editor`
- Open WebUI adds an admin-only "Manage Policies" button linking to it
- Full compile/review/activate flow runs in this service
- Policies auto-sync to MADE when activated

**Pros:**
- Zero changes to Open WebUI codebase (no vendored code modifications)
- Isolated: policy infrastructure doesn't entangle with Open WebUI
- Faster iteration: can change policy UX without touching Open WebUI
- Can move later as a standalone microservice if needed

**Cons:**
- Breaks the "Open WebUI is the unified workspace" mental model
- Feels bolted-on, not integrated
- Users see another UI for policies (in iframe) vs. native workspace experience
- Harder to unify ACLs (who can author policies? different from Open WebUI's roles?)

**Tradeoff:** Quick, isolated, but weak UX integration.

---

## Recommendation

**Go with Approach 2: Parallel Category**

Reasons:
1. **Semantic fit:** Policies are a first-class governance artifact, deserve their own workspace type, not mixed with tools
2. **UX:** Dedicated editor + Rego preview + review flow is what this feature needs; reusing Skills would feel cramped
3. **Precedent:** Open WebUI was literally designed for this — adding Skills as a 5th category is exactly the pattern we'd follow
4. **Future-proof:** Version history, rollback, audit logs can layer on top naturally
5. **Integration:** Feels native to Open WebUI, not bolted-on

**Why not Approach 1:** Conflating policies with tools is semantically wrong and would confuse users (are Skills for code functions or policies?).

**Why not Approach 3:** Breaking the unified workspace model is a downgrade in UX. We're adopting Open WebUI to be the primary app; keeping admin tasks outside it defeats that goal.

**Scope & Sequence:**
- **Phase 1 (C1):** Backend only — Policy model, basic CRUD routes, compile endpoint (calls our Node `/api/compile-policy`), review endpoint
- **Phase 2 (C2):** Frontend — SvelteKit routes, Markdown editor, Rego preview pane, review UI
- **Phase 3 (C3):** MADE sync — activation calls MADE's policy deployment endpoint, status tracking

This splits implementation across 3 phases so code review can happen incrementally (backend first, then frontend, then integration).

---

## Key Design Decisions

1. **Compile endpoint:** Where does it live?
   - **Option A:** In Open WebUI backend (call our Node backend from Open WebUI's Python)
   - **Option B:** In this project's Node backend (Open WebUI calls it directly)
   - **Recommendation:** Option B — Open WebUI calls our `/api/compile-policy` endpoint. Simpler, keeps LLM policy logic in one place, Open WebUI just routes the request.

2. **Review flow:** Who reviews? How?
   - **Assumption:** An admin (same person who configures Open WebUI) reviews and approves before activation
   - **Recommendation:** Simple approval flow — no comments/iterations yet. Just "approve and deploy" or "reject and send back to draft".

3. **Rego version tracking:** Store compiled Rego in the Policy model or only in MADE?
   - **Recommendation:** Store both. Policy model keeps audit trail of what was approved + when. MADE has the live version. If MADE is rebuilt, can re-activate the last-approved Rego.

4. **Rollback:** If an activated policy causes problems, can we rollback?
   - **Recommendation:** Out of scope for C'. Add later as C4 if needed. For now, assume admins manually deactivate via MADE and re-activate an older policy version.

---

## Next Step

Recommend: Write **spec for C1 (Policy Backend)** covering:
- Policy model schema (name, markdown, compiled_rego, status, metadata)
- CRUD routes (create, get, list, update, delete — all by admin)
- Compile route: `POST /api/v1/policies/:id/compile` → calls our Node `/api/compile-policy`, returns Rego preview
- Review route: `POST /api/v1/policies/:id/review?approve=true/false`
- Integration: where's the LLM compile step? (Node backend, `src/openwebui-policy-compiler.ts`)
- Testing: mock Open WebUI requests, verify compile + review flow

Then **plan for C1**, code/test, review. **C2 & C3 are follow-up phases** (frontend + MADE sync).
