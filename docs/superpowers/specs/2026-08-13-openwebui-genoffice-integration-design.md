# Spec: D2 + D3 — GenOffice Integration (Sidebar Link + Full In-App Embedding)

**Date:** 2026-08-14  
**Author (Researcher):** Claude (ai-workspace researcher)  
**Status:** Ready for coder implementation  
**Depends on:** D1 (Tools Registry, shipped) + GenOffice `/document` working  
**Related Brainstorm:** `docs/superpowers/brainstorms/2026-08-13-openwebui-genoffice-tools.md`

---

## 1. Overview

Two phases of GenOffice integration into Open WebUI:

- **D2: Sidebar Link (Phase 1, Approach 1)** — Quick win, launch docs from Open WebUI
  - Add link in Open WebUI sidebar → opens `/document` in new tab
  - Unblocks docs access from Open WebUI context
  - Low risk, trivial code

- **D3: Full In-App Embedding (Phase 2, Approach 3)** — Complete integration
  - Add "Documents" workspace category (6th category, like Models/Tools/Skills)
  - Embed GenOffice docs browser build inside Open WebUI
  - Single app experience (never leave Open WebUI)
  - Higher risk (routing, SvelteKit collision), higher reward (UX polish)

---

## 2. D2: Sidebar Link (Quick Win)

### 2.1 Problem & Goal

GenOffice at `/document` is isolated. Users juggle two apps (Open WebUI chat + separate docs editor).

**Goal:** Quick link in Open WebUI sidebar → `/document` in new tab. Unblocks docs access.

### 2.2 Requirements

**FR-D2-1: Sidebar Menu Item**
- Add "Documents" or "Docs Editor" link in Open WebUI's left sidebar
- Location: after "Tools", before logout (or wherever makes sense in nav)
- On click: open `/document` in new browser tab (or modal)
- Visible to admin users (or all users, policy decision)

**FR-D2-2: Styling**
- Match Open WebUI's sidebar design (icons, text, hover states)
- Use existing icon library (or simple generic docs icon)

**FR-D2-3: Accessibility**
- Keyboard navigable (tab to link, enter to open)
- Semantic HTML (link with href, not button-fake)

### 2.3 Implementation

**File:** `open-webui/src/routes/(app)/workspace/+layout.svelte`
- Sidebar already lists tabs (Models, Knowledge, Prompts, Tools, Skills)
- Add new link after Tools or at end of list:
  ```svelte
  <a href="/document" target="_blank" class="nav-item docs-link">
    📄 Documents
  </a>
  ```
- Or use icon + text matching existing style

**CSS:** Minimal styling (reuse existing nav classes)

**No backend changes:** Just a link, no new API calls

### 2.4 Testing

- Unit: link renders, href correct, target="_blank" set
- Manual: click link, `/document` opens in new tab
- Manual: verify link visible/hidden based on user role (if role-gated)

### 2.5 Deliverables (D2)

- Sidebar link added (one file change)
- Styling consistent with Open WebUI design
- Tests pass
- CLAUDE.md updated (mention docs link is available)

---

## 3. D3: Full In-App Embedding (Complete Integration)

### 3.1 Problem & Goal

Sidebar link is quick but incomplete. Users still context-switch between apps.

**Goal:** Embed GenOffice inside Open WebUI as a native workspace category. True single-app experience.

### 3.2 Requirements

**FR-D3-1: Documents Workspace Category**
- Add "Documents" tab to Open WebUI's Workspace (6th category, after Skills)
- List view: show all open docs (or metadata like title, last-edited)
- Click doc → open in split pane or full modal
- Launch new doc capability

**FR-D3-2: GenOffice Browser Build Integration**
- GenOffice `/document` page already works (browser build via `desktop-stub.ts`)
- Embed that into Open WebUI's Documents workspace
- Route: Open WebUI serves GenOffice at `/workspace/documents/` or `/documents/`
- No duplicate builds (reuse existing `/document` or embed its output)

**FR-D3-3: Document Routing**
- `GET /workspace/documents/` — list view (or default to new doc)
- `GET /workspace/documents/[id]/` — open specific doc
- Fallback to GenOffice's existing `/document` route if needed (for backward compat)

**FR-D3-4: UI Integration**
- Documents tab matches Open WebUI's tabs (Models, Knowledge, Prompts, Tools, Skills)
- Tab styling consistent
- Icon: document/file icon
- Status badge: (optional) show number of docs

**FR-D3-5: Responsive**
- Works on desktop (Documents in sidebar, content in main pane)
- Works on mobile (collapse sidebar, full-width docs)

### 3.3 Implementation Strategy

**Option A: Iframe Embed (Quickest)**
- Keep GenOffice at `/document`
- Open WebUI Documents workspace embeds it via `<iframe src="/document">`
- Pros: zero changes to GenOffice, works immediately
- Cons: iframe is clunky, no direct integration, messaging needed

**Option B: Route Reuse (Better)**
- GenOffice browser build already lives in `open-webui/src/routes/(app)/workspace/documents/[id]/+page.svelte` (or similar)
- Reuse that build (don't duplicate)
- Link from Documents workspace tab to `/workspace/documents/[id]/`
- Pros: true integration, no iframe, single routing tree
- Cons: requires modifying Open WebUI routes, SvelteKit collision risk

**Option C: Proxy via Node Backend (Most Control)**
- Our Node backend proxies `/workspace/documents/` → GenOffice `/document`
- Open WebUI calls our backend route
- Pros: complete control, can add metadata, logging
- Cons: extra hop, more complex

**Recommendation: Option B (Route Reuse)**
- Best balance: true integration without over-engineering
- GenOffice is vendored, not modifying its code
- Open WebUI routes just point to GenOffice's build
- Backward compat: existing `/document` still works

### 3.4 Architecture (Option B)

**GenOffice Build Integration:**
- GenOffice docs build already exists: `genoffice/apps/docs/dist/`
- This is built as part of `npm run build`
- Vite config already includes it in output (`client/dist/document.html`)

**Open WebUI Routes:**
```
open-webui/src/routes/(app)/workspace/documents/
├── +page.svelte           (list view, or default new doc)
└── [id]/+page.svelte      (open specific doc, embeds GenOffice)
```

**Route Logic:**
- `GET /workspace/documents/` → render list view (metadata about docs)
  - Or: auto-redirect to new doc (simpler)
- `GET /workspace/documents/[id]/` → embed GenOffice page
  - SvelteKit component wraps GenOffice in `<div class="documents-container">`
  - GenOffice handles all interactions (read-only embed vs full IDE depends on policy)

**Potential SvelteKit Collision:**
- GenOffice also has `+page.svelte` for its browser build
- Risk: if GenOffice's route also tries to handle `/documents/`, conflict
- Mitigation: GenOffice is vendored under `genoffice/apps/docs/`, not in Open WebUI's routing tree
  - Open WebUI's routes are under `open-webui/src/routes/`
  - No collision if kept separate
  - Careful routing configuration in `vite.config.ts` (already handles this for `/document` page)

### 3.5 Implementation Steps

**Step 1: Add Documents workspace tab**
- File: `open-webui/src/routes/(app)/workspace/+layout.svelte`
- Add new tab to sidebar navigation (like Models, Tools, Skills)
- Link to `/workspace/documents/`

**Step 2: Create Documents list/new view**
- File: `open-webui/src/routes/(app)/workspace/documents/+page.svelte`
- Simple view: "No docs yet" with "New Document" button
- Or: list existing docs (if stored in DB; optional for MVP)
- Click "New" → redirect to `/workspace/documents/new/`

**Step 3: Create Documents viewer component**
- File: `open-webui/src/routes/(app)/workspace/documents/[id]/+page.svelte`
- Embed GenOffice browser build
- Pass doc ID to GenOffice (if needed for state management)

**Step 4: Wire GenOffice embedding**
- How to embed GenOffice's browser build in SvelteKit component?
  - Option A1: `<iframe src="/document">` (simplest, already works)
  - Option A2: Import GenOffice components directly (requires SvelteKit config)
  - Option B: Copy GenOffice's built HTML into this route (duplication, avoid)
- Recommended: **Option A1 (iframe)** for MVP, migrate to A2 later if needed

**Step 5: Styling & Responsive**
- Make Documents workspace match Open WebUI's design
- Responsive: sidebar collapse on mobile, full-width docs

**Step 6: Backward Compat**
- Keep existing `/document` route working (for direct bookmarks, old links)
- Document that `/workspace/documents/` is the new primary URL

### 3.6 Testing (D3)

- Unit: Documents tab renders, navigation works
- Manual: click Documents tab, opens list/new view
- Manual: new doc, GenOffice loads, editor works
- Manual: close and reopen, doc persists
- Manual: mobile responsive (sidebar collapses)
- Integration: verify no SvelteKit route collisions

### 3.7 Deliverables (D3)

- Documents workspace category added
- GenOffice embedded (iframe or native, MVP choice)
- Tab styling & navigation
- Responsive layout
- Tests pass
- Backward compat verified (`/document` still works)
- CLAUDE.md updated (new Documents tab available)

### 3.8 Known Limitations & Future Work

**Not in D3:**
- ✗ Document list/metadata from DB (MVP: always "new")
- ✗ Document sharing/collaboration features
- ✗ Sheets/slides support (GenOffice only has working docs build)
- ✗ Full "upload existing docx" workflow (GenOffice handles open/save via File API, but discovery is manual)

**Deferred to D4+:**
- Document versioning / history
- Collaboration (real-time sync)
- Sheets/slides porting (separate, large effort)

---

## 4. Integration Notes

**D2 + D3 together:**
- D2 ships first (one line, low risk, quick unblock)
- D3 ships after (embedding, full integration)
- Alternatively: ship both together (D3 includes D2 functionality automatically)
- After D3, D2 link becomes "backup" (users prefer Documents tab, but link still works)

**GenOffice constraints:**
- Browser build only (no Electron in Open WebUI context)
- Only docs app fully ported (sheets/slides need work, out of scope)
- Desktop stub limits some File API features (but open/save working now)

---

## 5. Architecture Diagram (D3)

```
Open WebUI (SvelteKit)
├── Workspace Tab: "Documents"
│   ├── /workspace/documents/          (list/new view)
│   └── /workspace/documents/[id]/     (doc viewer, embeds GenOffice)
│
Open WebUI backend (Python/FastAPI)
├── No new routes needed (static embedding)

GenOffice Browser Build
├── /document                          (existing, backward compat)
├── Embedded in /workspace/documents/[id]/  (D3 primary path)

Node Backend (ai-workspace)
├── No changes for D3 embedding
├── Still provides /api/web-search, /api/scrape (for D1 tools)
```

---

## 6. Risk & Mitigation

**Risk:** SvelteKit route collision (Open WebUI's `/documents/` conflicts with GenOffice's)
- **Mitigation:** GenOffice is vendored separately, not in Open WebUI's source tree
- Verify via `ls open-webui/src/routes/` — should have no `documents/` directory initially
- If collision happens: namespace carefully (e.g., `/workspace/docs/` instead of `/documents/`)

**Risk:** iframe is clunky (Option A1)
- **Mitigation:** iframe works for MVP, migrate to native embedding (Option A2) in D4+ if UX issues
- Monitor user feedback on D3 launch

**Risk:** Backward compat break (existing `/document` users)
- **Mitigation:** Keep `/document` route working alongside new `/workspace/documents/`
- Redirect optional, but not required

---

**Specs ready for coder implementation (D1 + D2 + D3). Next: Plans for D2 + D3.**
