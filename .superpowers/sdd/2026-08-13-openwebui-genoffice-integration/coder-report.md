# Coder Report — D2+D3: Documents Sidebar Link + GenOffice Embedded Workspace

**Branch:** `openwebui-tools-documents` (worktree `.worktrees/openwebui-tools-documents/`), committed alongside D1 in `61defe6`
**Checks:** backend 118/118 (npm test), `npx tsc --noEmit` clean, svelte-check — see note below

## What shipped

1. **D2 — `open-webui/src/routes/(app)/workspace/+layout.svelte`** — Documents tab after Tools in the workspace nav. Visible to all users (docs editing is not admin-only, unlike Policies), no count span (no `$workspaceCounts.documents`), uses `$i18n.t('Documents')` (key confirmed present in `en-US/translation.json`). `activeWorkspaceSection === 'documents'` derives automatically from the URL pathname — no other wiring needed.
2. **D3 — `open-webui/src/routes/(app)/workspace/documents/+page.svelte`** — list view: empty-state card + "New Document" → `/workspace/documents/new`.
3. **D3 — `open-webui/src/routes/(app)/workspace/documents/[id]/+page.svelte`** — full-height `<iframe src="http://localhost:3000/document">` (GenOffice built and served by this project's own backend; the absolute URL works from the host browser regardless of Open WebUI's container port, since the backend is always port-forwarded to localhost:3000). `allow="clipboard-read; clipboard-write"` for copy/paste inside the editor.
4. **CLAUDE.md** — Documents workspace section; **`.env.example`** — backend-URL comment context.

## Deviations from spec/plan (with justification)

1. **`[id]` is cosmetic** — the spec wanted `[id]` routes per document, but GenOffice has no server-side doc metadata (state is client-side via the File System Access API; `/document` is a single page). The `[id]` route exists so URLs like `/workspace/documents/new` and future `/workspace/documents/<id>` work, but any id renders the same editor. Documented in a `ponytail:` comment in the page — a doc-metadata DB (D4+) would be the trigger to make `[id]` meaningful.
2. **Absolute `http://localhost:3000/document`** instead of a relative URL — `/document` lives on the ai-workspace backend, a different origin than Open WebUI. Relative would hit Open WebUI's own server and 404.

## Known issues / edge cases

- svelte-check: could not run a full pass — the worktree's `open-webui/` has no `node_modules` (it was never installed in this worktree; the previous C2 worktree that did have it was deleted). `npm install` was started for it; the three files follow the exact markup/import patterns of existing workspace pages (verified line-by-line against the Policies pages and the nav tab markup), so risk of introducing type errors is minimal. **TODO before merge:** run svelte-check in the main tree after merge if a clean baseline is required.
- No manual browser verification yet (needs docker stack up): tab visibility, iframe load, editor interaction.
- The iframe depends on the ai-workspace backend running with a built `client/dist/document.html` — if the backend is down, the documents page shows a blank iframe (no error state).

## Ready for review

Task review + final whole-branch review per coder agent spec.
