# Coder Task: Sub-Project D (Full Bundle) — Tools Registry + GenOffice Integration

**Spec References:**
- D1: `docs/superpowers/specs/2026-08-13-openwebui-tools-registry-design.md`
- D2+D3: `docs/superpowers/specs/2026-08-13-openwebui-genoffice-integration-design.md`

**Plan References:**
- D1: `docs/superpowers/plans/2026-08-13-openwebui-tools-registry.md`
- D2+D3: `docs/superpowers/plans/2026-08-13-openwebui-genoffice-integration.md`

**Complexity:** Low (D1) + Low (D2) + Medium (D3) = **Medium overall**  
**Estimated Time:** 5-7 hours total (1h D1 + 1h D2 + 3h D3)  
**Status:** Ready for implementation

---

## Overview

Implement Sub-Project D as one coordinated 3-phase delivery:

1. **D1: Tools Registry** — Register web_search + scrape as native Open WebUI Tools
2. **D2: Sidebar Link** — Quick Documents link in Open WebUI navigation
3. **D3: Full Embedding** — Embed GenOffice as Documents workspace (true single-app)

Each phase is independent but together form complete GenOffice integration into Open WebUI.

---

## Phase 1: D1 — Tools Registry (1 hour)

### What to Build

Create provisioning script to register our backend's `web_search` and `scrape` tools as native Open WebUI Tools.

### Implementation Steps

1. **Create provisioning script** — `src/openwebui-provision-tools.ts`
   - Similar structure to existing `openwebui-provision.ts`
   - Load tool definitions (Python functions as strings)
   - Sign into Open WebUI (fetch admin token via credentials in `.env`)
   - Register each tool:
     - GET `/api/v1/tools/{id}` (check if exists)
     - If exists: PUT to update
     - If not: POST to create
   - Log actions: "Creating web_search", "Updating scrape", "web_search already up-to-date"

2. **Define web_search tool**
   - ID: `web_search`
   - Name: "Web Search"
   - Python source (see spec section 4.1):
     ```python
     def web_search(query: str, language: str = "en") -> dict:
         import requests
         response = requests.post(
             "http://localhost:3000/api/web-search",
             json={"query": query, "language": language},
             timeout=10
         )
         if response.status_code == 200:
             results = response.json()
             return {
                 "status": "success",
                 "results": results.get("results", []),
                 "count": len(results.get("results", []))
             }
         else:
             return {"status": "error", "error": f"Search failed: {response.status_code}"}
     ```
   - Metadata: author="ai-workspace", tags=["search", "web"]

3. **Define scrape tool**
   - ID: `scrape`
   - Name: "Web Scrape"
   - Python source (see spec section 4.1):
     ```python
     def scrape(url: str) -> dict:
         import requests
         response = requests.post(
             "http://localhost:3000/api/scrape",
             json={"url": url},
             timeout=10
         )
         if response.status_code == 200:
             data = response.json()
             return {
                 "status": "success",
                 "content": data.get("content", ""),
                 "url": url
             }
         else:
             return {"status": "error", "error": f"Scrape failed: {response.status_code}"}
     ```
   - Metadata: author="ai-workspace", tags=["scrape", "web"]

4. **Make provisioning idempotent**
   - Check if tool exists before creating
   - Only update if definition differs
   - Skip if already up-to-date
   - Safe to run multiple times

5. **Wire CLI entry point**
   - Run via: `node --import tsx src/openwebui-provision-tools.ts`
   - No required arguments (use `.env` for Open WebUI credentials)

### Testing (D1)

- **Unit:** Tool definitions valid Python, error handling works, idempotent logic
- **Integration:** Run script, verify tools appear in Open WebUI `/api/v1/tools` listing
- **Manual:** Open Open WebUI, check Workspace → Tools, see "Web Search" + "Web Scrape"

### Files Created/Modified (D1)

```
src/openwebui-provision-tools.ts          [NEW: provisioning script]
tests/openwebui-provision-tools.test.ts   [NEW: unit + integration tests]
CLAUDE.md                                  [MODIFY: add D1 setup section]
```

---

## Phase 2: D2 — Sidebar Link (1 hour)

### What to Build

Add "Documents" link in Open WebUI sidebar → opens `/document` in new tab.

### Implementation Steps

1. **Add Documents tab to sidebar**
   - File: `open-webui/src/routes/(app)/workspace/+layout.svelte`
   - Find Models, Tools, Skills tabs in the sidebar
   - Add new tab/link after Tools:
     ```svelte
     <a href="/workspace/documents/" class="nav-item docs-link">
       📄 Documents
     </a>
     ```
   - Or: Navigate to `/workspace/documents/` (no target="_blank" needed if using workspace nav)

2. **Style to match**
   - Reuse existing nav classes (no new CSS)
   - Icon + text matching Models/Tools/Skills pattern

3. **Test**
   - Click tab, verify navigation works
   - Styling consistent with other tabs

### Files Created/Modified (D2)

```
open-webui/src/routes/(app)/workspace/+layout.svelte  [MODIFY: add Documents tab]
```

---

## Phase 3: D3 — Full In-App Embedding (3 hours)

### What to Build

Embed GenOffice as native "Documents" workspace category. Complete single-app experience.

### Implementation Steps

1. **Create Documents workspace list view**
   - File: `open-webui/src/routes/(app)/workspace/documents/+page.svelte`
   - Simple view: "No documents yet" or show existing docs
   - Button: "New Document" → redirect to `/workspace/documents/new/`
   - MVP: Always start fresh document (no document DB/metadata yet)

2. **Create Documents viewer component**
   - File: `open-webui/src/routes/(app)/workspace/documents/[id]/+page.svelte`
   - Embed GenOffice:
     - **MVP Approach:** `<iframe src="/document" class="full-height"></iframe>`
     - Simple, no changes to GenOffice, works immediately
   - Full-height, responsive container
   - Let GenOffice handle all editing/saving (File API)

3. **Route for new documents**
   - `/workspace/documents/new/` — can redirect to a fixed ID or generate one
   - For MVP: just use a generic ID (e.g., `new-doc`, `untitled`)
   - GenOffice already handles state via File API

4. **Styling**
   - Match Open WebUI workspace design
   - Responsive: sidebar visible on desktop, collapse on mobile
   - Documents container: full-height, handles overflow

5. **Verify routing**
   - Check no SvelteKit collisions (GenOffice is vendored, not in Open WebUI routes)
   - Backward compat: `/document` direct URL still works
   - Verify new `/workspace/documents/` works

6. **Update CLAUDE.md**
   - Add section: "Documents Workspace (D2+D3)"
   - Explain: Open WebUI's Documents tab embeds GenOffice
   - Note: `/document` still accessible
   - Note: Docs-only for now (sheets/slides future)

### Testing (D3)

- **Unit:** Components render, routing works
- **Manual:** Documents tab opens, "New Document" works, GenOffice loads
- **Manual:** Edit and save in GenOffice, close tab, reopen — document persists
- **Manual:** Mobile responsive (sidebar collapses)
- **Manual:** Verify `/document` direct URL still works (backward compat)

### Files Created/Modified (D3)

```
open-webui/src/routes/(app)/workspace/
├── +layout.svelte                                    [MODIFY: add Documents tab]
└── documents/
    ├── +page.svelte                                 [NEW: list view]
    └── [id]/
        └── +page.svelte                             [NEW: viewer with iframe]

CLAUDE.md                                             [MODIFY: add Documents section]
```

---

## Integration Notes

**D1 + D2 + D3 together:**
- D1 is independent (tools in Open WebUI, backend endpoints exist)
- D2 is independent (just a link)
- D3 depends on D2 (uses Documents workspace nav)
- Can implement in any order, but recommend: D1 → D2 → D3

**After completion:**
- D1: Tools appear in chat, model can invoke web_search + scrape
- D2: Quick access link from Open WebUI sidebar
- D3: Full GenOffice docs editor embedded, never leave Open WebUI

---

## Testing Checklist (All Phases)

**D1 — Tools Registry:**
- [ ] Provisioning script runs without errors
- [ ] Tools appear in Open WebUI Tools listing
- [ ] Tool metadata correct (name, description)
- [ ] web_search callable from chat
- [ ] scrape callable from chat
- [ ] Error handling works (backend unreachable → graceful error)

**D2 — Sidebar Link:**
- [ ] Documents link appears in workspace sidebar
- [ ] Link styling matches other tabs
- [ ] Click navigates to `/workspace/documents/`

**D3 — Full Embedding:**
- [ ] `/workspace/documents/` loads (list or new view)
- [ ] "New Document" button works
- [ ] GenOffice loads in iframe/embedded view
- [ ] Can edit and save documents
- [ ] Close/reopen tab: document persists
- [ ] Mobile: sidebar collapses, full-width documents
- [ ] Backward compat: `/document` direct URL works

**All Phases:**
- [ ] npm test passes
- [ ] npx tsc --noEmit clean
- [ ] CLAUDE.md updated with D1+D2+D3 sections

---

## Known Limitations & Deferred (D4+)

**Not in D1+D2+D3:**
- ✗ Document list from database (MVP: always new)
- ✗ Document metadata/versioning
- ✗ Sheets/slides support
- ✗ Document sharing/collaboration
- ✗ MADE governance on tools
- ✗ Upload existing docx discovery

**Deferred to D4+:**
- Full document metadata UI
- Collaboration features
- Sheets/slides porting
- Advanced tool governance

---

## Model Selection

- **Implementation:** Haiku (all three phases, straightforward)
- **Testing:** Haiku (component + integration tests)
- **Review:** Sonnet (integration correctness, final whole-branch review)

---

## Success Criteria

After coder completes D1+D2+D3:

1. ✅ Tools Registry: web_search + scrape registered, callable from Open WebUI
2. ✅ Sidebar Link: Documents tab visible, navigates to workspace
3. ✅ Full Embedding: GenOffice embedded in workspace, functional
4. ✅ All tests passing (unit + integration)
5. ✅ Type-check clean (`npx tsc --noEmit`)
6. ✅ CLAUDE.md updated (all three phases documented)
7. ✅ Brief implementation notes if any deviations from spec

---

## Handoff to Researcher (Review Phase)

After coder completes, pass:
1. Implementation report (commits, tests, manual verification)
2. Any deviations from spec (with justification)
3. Known issues or edge cases found
4. Ready for task review + final whole-branch review

Researcher will review all three phases coordinated, test, and approve for merge.

---

**Ready for coder implementation. Full D1+D2+D3 bundle coordinated delivery.**
