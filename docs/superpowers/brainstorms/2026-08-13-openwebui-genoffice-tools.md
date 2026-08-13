# Brainstorm: Sub-project D' (GenOffice + Tools in Open WebUI)

**Date:** 2026-08-13  
**Scope:** Integrate GenOffice document editor and web_search/scrape tools into Open WebUI's UX.

## Problem Statement

Currently:
- GenOffice docs editor is at `/document` (separate URL, isolated from Open WebUI's primary chat)
- This project's `web_search` + `scrape` tools are server-side, hidden from Open WebUI's native tool UI
- Open WebUI has a mature native Tools workspace (Python-based custom tools) and in-app editor, but it doesn't know about our tools
- Users can't: (1) launch a doc from Open WebUI, (2) see our tools as native Open WebUI offerings

**Goal:** D' should make GenOffice and our tools feel native to Open WebUI, not bolted-on.

---

## Three Approaches

### Approach 1: "In-App Launcher" — Open WebUI sidebar link to `/document`
**Idea:** Add a link in Open WebUI's left sidebar that opens GenOffice docs in a modal or new browser tab.

**Pros:**
- Trivial to implement (one link in Open WebUI's frontend)
- No new backend routes needed
- Docs stay at `/document` (existing URL, no refactor)
- Coexists with everything else; zero risk to chat flow

**Cons:**
- Weak UX: docs are still separate, not integrated
- Does NOT solve the tools visibility problem
- Users still see two apps, not one

**Tradeoff:** Fastest to ship, but least integrated. Doesn't address tools at all.

---

### Approach 2: "Open WebUI Tools Registry" — Register web_search + scrape as Open WebUI native tools
**Idea:** Define `web_search` and `scrape` as Open WebUI "Tools" (Python functions in its workspace), making them visible in Open WebUI's tool picker and callable from chat.

**Implementation:**
- Create Python tool definitions in Open WebUI's `tools/` directory or via its `/api/v1/tools/create` API
- Our existing `web_search`/`scrape` endpoints (`/api/web-search`, `/api/scrape` from `src/server.ts`) become the backend
- Open WebUI's chat can invoke them like any native tool
- GenOffice link remains a sidebar launcher (Approach 1)

**Pros:**
- Tools become native Open WebUI citizens (visible in UI, Workspace → Tools)
- Chat can use them naturally without MADE governance (or we add governance layer separately)
- No change to existing server routes; wrapper only
- Clear ownership: Open WebUI owns the UI, our server owns the backend

**Cons:**
- Doesn't integrate docs (still separate from chat)
- Tools lose MADE's decision-layer governance if we just expose them as-is
- Need to decide: do tools in Open WebUI also call MADE's `/decide`, or bypass it?

**Tradeoff:** Solves tools integration cleanly, but docs remain separate.

---

### Approach 3: "Full In-App Integration" — Embed GenOffice in Open WebUI as a workspace category
**Idea:** Add a new "Documents" workspace category to Open WebUI (like its existing Models, Tools, Skills), showing a list of GenOffice docs and launching them in a split pane or modal within the Open WebUI app itself.

**Implementation:**
- Add GenOffice `docs` browser build as a sub-route (e.g., `/open-webui/documents/:id`)
- Open WebUI routes requests there; our Node server serves the GenOffice static files
- Add toolbar button or sidebar entry linking to this workspace
- Approach 2 tools registry as a bonus

**Pros:**
- True integration: docs are part of the Open WebUI experience
- Users never leave Open WebUI
- Can combine with tools registry (Approach 2) for full integration
- Professional, polished UX

**Cons:**
- More complex: requires reverse-proxying GenOffice build output through Open WebUI
- Needs careful routing (Open WebUI is SvelteKit; collision risk if not planned)
- Sheets/slides porting (out of scope) will expose incomplete UX if we don't hide them
- Higher risk of breaking Open WebUI's existing routes

**Tradeoff:** Best UX, most integrated, but highest implementation complexity. Requires careful routing design.

---

## Recommendation

**Go with Approach 2 + Approach 1:**

1. **Phase 1 (Approach 2):** Register `web_search` + `scrape` as Open WebUI Tools. Straightforward, low risk, high value for tools integration. Define them via Open WebUI's API, wire backend to existing endpoints, add regression test.

2. **Phase 2 (Approach 1 as stopgap):** Sidebar link to GenOffice. Minimal effort, unblocks docs access from Open WebUI context. Document the limitation (separate URL, not full integration).

3. **Defer Approach 3:** Full in-app embedding is nice-to-have UX polish, not a blocker. Ship tools first (high value), docs link (unblocks docs), then revisit in-app embedding if time allows.

**Why:** Approach 2 solves the immediately valuable problem (tools visibility/integration) without complexity risk. Approach 1 unblocks docs access with zero risk. Approach 3 is valuable but can ship after; it's a UX refinement, not functionality.

**One open question:** Should Open WebUI-invoked `web_search`/`scrape` also route through MADE's `/decide` (for governance), or skip it? Answer: **Skip for now.** Tools in Open WebUI are end-user-initiated (not auto-triggered by complexity-based routing like B' does for chat models). User explicitly picks the tool from the UI, so they've already made the governance decision. Add MADE governance only if a future sub-project adds auto-tool-recommendation (like "this question needs web search, I'll invoke it for you"). Simpler spec, faster to ship.

---

## Next Step

Recommend: Write spec for **D1 (Open WebUI Tools Registry)** covering:
- Which endpoints (web_search, scrape) + their signatures
- Open WebUI Tool definition schema (Python function + metadata)
- Provisioning: create/update Tools via Open WebUI's `/api/v1/tools/create` at setup time
- Testing: verify tools appear in chat, can be invoked, results flow back
- Defer sheets/slides to a future D2 sub-project (only if in scope)

Then plan + code + ship. **Approach 1** (sidebar link) is one-line code change — defer until after D1 ships.
