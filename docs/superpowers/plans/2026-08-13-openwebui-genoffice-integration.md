# Plan: D2 + D3 — GenOffice Integration (Sidebar Link + Full Embedding)

**Date:** 2026-08-14  
**Spec:** `docs/superpowers/specs/2026-08-13-openwebui-genoffice-integration-design.md`  
**Complexity:** Low (D2) + Medium (D3)  
**Phases:** 2 (D2 quick, D3 full embedding)

---

## Overview

Integrate GenOffice into Open WebUI (two phases):

- **D2:** Sidebar link to `/document` (1-2 hours, quick unblock)
- **D3:** Full workspace category with embedded GenOffice (2-3 hours, complete integration)

---

## D2: Sidebar Link (Quick Phase)

### Steps (3 total)

**Step 1: Add Documents tab to sidebar**
- File: `open-webui/src/routes/(app)/workspace/+layout.svelte`
- Find where Models, Tools, Skills tabs are defined
- Add new tab/link: "📄 Documents" linking to `/workspace/documents/`
- Styling: match existing tab design (reuse classes)

**Step 2: Test**
- Click link, verify navigation to `/workspace/documents/`
- Manual: verify link appears, styling correct
- Optional: unit test for link rendering

**Step 3: Commit**
- Message: "feat(open-webui): add Documents link in workspace sidebar"

**Estimate:** 1 hour total

---

## D3: Full In-App Embedding (Complete Phase)

### Steps (10 total)

**Step 4: Create Documents workspace view**
- File: `open-webui/src/routes/(app)/workspace/documents/+page.svelte`
- View: "New Document" button (or docs list if MVP supports it)
- On click "New": navigate to `/workspace/documents/new/`
- Simple view for MVP (no document DB/metadata yet)

**Step 5: Create Documents viewer component**
- File: `open-webui/src/routes/(app)/workspace/documents/[id]/+page.svelte`
- Render GenOffice embed:
  - Option A1 (MVP): `<iframe src="/document" class="full-height"></iframe>`
  - Option A2 (later): Import GenOffice components directly
- Full-height, responsive container

**Step 6: Styling for Documents workspace**
- CSS: match Open WebUI's workspace design
- Full-height container for iframe/GenOffice
- Sidebar collapses on mobile (responsive)

**Step 7: Verify routing**
- Check: no SvelteKit route collisions
- Verify: `/document` (old) still works (backward compat)
- Verify: `/workspace/documents/` (new) works

**Step 8: Handle document state**
- GenOffice browser build already handles its own state (File API for save/load)
- No new backend needed (embedding is static)
- Document persistence: handled by GenOffice's existing logic

**Step 9: Testing**
- Unit: components render, routing works
- Manual: Documents tab opens, new doc works, GenOffice loads
- Manual: close tab, reopen, doc persists (GenOffice state)
- Manual: mobile responsive (sidebar collapse)
- Manual: `/document` direct URL still works

**Step 10: Update CLAUDE.md**
- Add section: "Documents Workspace"
- Explain: Open WebUI's Documents tab launches GenOffice
- Note: `/document` still accessible for backward compat
- Note: Sheets/slides not yet supported (docs-only for now)

**Estimate:** 3 hours total

---

## Files Created / Modified

```
open-webui/src/routes/(app)/workspace/
├── +layout.svelte                                [MODIFY: add Documents tab]
└── documents/
    ├── +page.svelte                             [NEW: list/new view]
    └── [id]/
        └── +page.svelte                         [NEW: viewer with GenOffice embed]

CLAUDE.md                                         [MODIFY: add Documents section]
```

---

## Testing Checklist

**D2:**
- [ ] Documents tab appears in sidebar
- [ ] Tab styling matches other workspace tabs
- [ ] Click tab → navigates to `/workspace/documents/`

**D3:**
- [ ] `/workspace/documents/` loads (list or new view)
- [ ] "New Document" button works (redirects to `/workspace/documents/new/`)
- [ ] GenOffice loads inside `/workspace/documents/[id]/`
- [ ] GenOffice editor is fully functional (can edit, save)
- [ ] Close and reopen: document persists
- [ ] Mobile: sidebar collapses, Documents workspace full-width
- [ ] Backward compat: `/document` direct URL still works
- [ ] npm test passes (if any new tests added)
- [ ] npx tsc --noEmit clean

---

## Integration with D1

D1 (Tools Registry) and D2+D3 (GenOffice Integration) are independent:
- D1: Register web_search + scrape tools in Open WebUI
- D2+D3: Embed GenOffice documents in Open WebUI

**Can ship in any order.** Recommend: D1 first (simpler, lower risk), then D2+D3 (embedding).

---

## Known Constraints & Deferred

**Not in D2+D3:**
- ✗ Document list from database (MVP: always new)
- ✗ Document sharing / collaboration
- ✗ Sheets/slides support (docs-only)
- ✗ Full "upload existing docx" discovery workflow
- ✗ Document versioning / history

**Deferred to D4+:**
- Sheets/slides porting
- Document metadata / list UI
- Collaboration features

---

## Model Selection

- **Implementation:** Haiku (straightforward embedding)
- **Testing:** Haiku (component + integration tests)
- **Any re-fixes:** Haiku

---

**Ready for coder implementation (D1 + D2 + D3 all phases). Plans complete.**
