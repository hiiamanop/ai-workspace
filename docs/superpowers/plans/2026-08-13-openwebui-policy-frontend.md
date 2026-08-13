# Plan: C2 — Policy Frontend (SvelteKit UI)

**Date:** 2026-08-13  
**Spec:** `docs/superpowers/specs/2026-08-13-openwebui-policy-frontend-design.md`  
**Complexity:** Medium (SvelteKit routes + state management + API integration)  
**Phases:** 1 (all frontend, C3 deferred)

---

## Overview

Implement Open WebUI SvelteKit frontend for policy authoring. Split-pane editor (Markdown left, Rego right), live compile preview, autosave, deploy/rollback UI.

---

## Step-by-Step Implementation

### Phase 1: Routes & Stores

**Step 1: Create routes**
- Directory: `open-webui/src/routes/workspace/policies/`
- Create `+page.svelte` (list view)
- Create `[id]/+page.svelte` (editor view)
- Create `new/+page.svelte` (new policy)
- Optional: `[id]/audit/+page.svelte` (audit trail, defer to C3)

**Step 2: Create Svelte stores**
- File: `open-webui/src/lib/stores/policies.ts`
- Stores: `policies` (list), `currentPolicy` (editing), `compileStatus`, `compileError`, `saveStatus`, `saveError`, `deployStatus`, `deployError`, `rollbackStatus`
- Initialize from empty state

**Step 3: Create API client**
- File: `open-webui/src/lib/api/policies.ts`
- Functions: fetchPolicies(), fetchPolicy(), createPolicy(), updatePolicy(), compilePolicyMarkdown(), deployPolicy(), rollbackPolicy(), deletePolicy()
- Use existing Open WebUI fetch wrapper (reuse auth, error handling)

---

### Phase 2: List View

**Step 4: Build list view component**
- File: `open-webui/src/routes/workspace/policies/+page.svelte`
- Features:
  - Fetch all policies on mount
  - Display table: name, status badge, created date, actions
  - "New Policy" button → navigate to `/policies/new`
  - Click row → navigate to `/policies/:id`
  - Filter dropdown: show draft / active / all
  - Search box: filter by name (client-side)
  - Delete button (draft only) with confirm dialog
  - Error handling: show banner on fetch failure

**Step 5: Add status badges styling**
- CSS: `.badge.draft { color: gray; }`, `.badge.active { color: green; }`
- Use ✓ for active, ⚪ for draft (or icon font if available)

---

### Phase 3: Editor View (core feature)

**Step 6: Build editor component (split pane)**
- File: `open-webui/src/routes/workspace/policies/[id]/+page.svelte`
- Fetch policy on mount: GET /api/v1/policies/:id
- Layout: two-pane (left=Markdown, right=Rego)
- Header: policy name (editable input), status badge, action buttons
- Markdown textarea (left pane):
  - Bind to `currentPolicy.markdown_content`
  - Disabled when status=active
  - Focus styling
- Rego preview (right pane):
  - Display `currentPolicy.compiled_rego` in `<pre>`
  - Read-only, syntax highlighting optional
  - Show compile status: "Compiling...", "✅ Ready", "❌ Error"

**Step 7: Wire live compile debounce**
- On Markdown input (every keystroke):
  - Debounce 500ms (use lodash debounce or custom)
  - Auto-trigger POST /api/v1/policies/:id/compile
  - Update `compileStatus` → `compileError`
  - Update `currentPolicy.compiled_rego` in store
  - Show status: "Compiling..." → "✅ Compiled" or "❌ Error: ..."
  - On error, show red banner above Rego pane

**Step 8: Wire autosave debounce**
- On Markdown blur (when focus leaves textarea):
  - Debounce 1000ms
  - Auto-trigger PUT /api/v1/policies/:id with updated markdown
  - Update `saveStatus` → `saveError`
  - Show status: "Saving..." → "✅ Saved" or "❌ Save failed"
  - Only on draft policies (active are read-only)

**Step 9: Deploy button**
- Show only when status = draft
- On click:
  - Confirm dialog: "Deploy this policy to MADE? It will become active."
  - POST /api/v1/policies/:id/deploy
  - Update `deployStatus` → `deployError`
  - On success (200):
    - Set status → active, update badge
    - Disable Markdown editor (readonly=true)
    - Hide "Deploy" button, show "Rollback" button (if previous_rego exists)
    - Show success banner: "Policy deployed successfully"
  - On error (400/502):
    - Show error banner: "Deployment failed: [MADE error]"
    - Status stays draft, editor stays editable
    - Suggest: "Rollback attempted if previous version exists. Fix and retry."

**Step 10: Rollback button**
- Show only when status = active AND previous_rego exists
- On click:
  - Confirm dialog: "Rollback to previous version? This will revert MADE's active policy."
  - POST /api/v1/policies/:id/rollback
  - Update `rollbackStatus` → `rollbackError`
  - On success (200):
    - Set status → draft, update badge
    - Enable Markdown editor (readonly=false)
    - Show success banner: "Rolled back to previous version"
    - Hide "Rollback" button (need to deploy again)
  - On error (400/502):
    - Show error banner: "Rollback failed: [error]"
    - Status stays active, editor stays locked

---

### Phase 4: New Policy

**Step 11: New policy route**
- File: `open-webui/src/routes/workspace/policies/new/+page.svelte`
- Start with empty Markdown textarea
- Generate temp policy ID (UUID or `untitled-{timestamp}`)
- First compile: POST /api/v1/policies with `{ id, name: "Untitled Policy", markdown: ... }`
- Backend creates policy, returns full policy object
- Redirect to `/policies/:id/` with real policy ID
- Show "Untitled Policy" as editable name, user can change it
- "Deploy" button disabled until compile succeeds once

---

### Phase 5: Error Handling & Polish

**Step 12: Error handling**
- 403 Forbidden (non-admin): redirect to `/403` page (reuse existing)
- 404 Not Found (policy deleted): show banner "Policy not found", redirect to list after 2s
- 500 Service Error: show banner "Backend error, retry", add retry button
- Network timeout: show banner "Connection lost", auto-retry every 5s
- All error messages in banner + inline (not just alerts)

**Step 13: Responsive design**
- Desktop (>1024px): split panes 50/50 horizontal
- Tablet (768-1024px): split panes 40/60
- Mobile (<768px): stack vertically (Markdown full-width, Rego below)
- Use flexbox/grid (no special libraries)

**Step 14: Polish**
- Keyboard shortcut: Ctrl+S / Cmd+S to manually save (besides autosave)
- Loading spinners on buttons during API calls
- Disabled states on buttons (e.g., Deploy disabled while deploying)
- Confirm dialogs for destructive actions (deploy, rollback, delete)
- Back button → return to list

---

### Phase 6: Testing

**Step 15: Unit tests (Vitest + component tests)**
- `test_list_view_renders_policies` — fetches and displays list
- `test_list_filter_by_status` — filter works (draft/active/all)
- `test_editor_loads_policy` — GET /api/v1/policies/:id works
- `test_markdown_compile_debounce` — compile triggers after 500ms of typing
- `test_autosave_debounce` — save triggers after 1000ms on blur
- `test_deploy_button_disabled_when_active` — button hidden for active policies
- `test_rollback_button_only_if_previous` — button visible only if previous_rego exists
- `test_error_banners_display` — error messages shown inline + in banner
- `test_status_badge_colors` — draft gray, active green
- `test_new_policy_workflow` — create → compile → deploy

**Step 16: E2E tests (Playwright)**
- `test_create_policy_workflow.spec.ts` — new → compile → deploy → active
- `test_deploy_failure_rollback.spec.ts` — deploy fails → error shown, status stays draft
- `test_rollback_workflow.spec.ts` — active → rollback → draft
- `test_delete_draft_policy.spec.ts` — delete works on draft
- `test_mobile_responsive.spec.ts` — panes stack on mobile
- `test_error_recovery.spec.ts` — network error → retry works

**Step 17: Manual testing**
- Create, list, edit, deploy, rollback workflows
- All error scenarios (404, 500, timeout)
- Mobile responsiveness
- Autosave verification (check DB directly)
- Deploy/rollback with different error messages from MADE

---

## Files Modified / Created

```
open-webui/src/routes/workspace/policies/
├── +page.svelte                    [NEW: list view]
├── +page.server.ts                 [NEW: optional server data loading]
├── [id]/
│   └── +page.svelte                [NEW: editor view]
└── new/
    └── +page.svelte                [NEW: new policy]

open-webui/src/lib/
├── stores/
│   └── policies.ts                 [NEW: Svelte stores]
└── api/
    └── policies.ts                 [NEW: API client]

open-webui/src/tests/
├── policies-list.test.svelte       [NEW: list view unit tests]
├── policies-editor.test.svelte     [NEW: editor unit tests]
└── e2e/
    ├── policies-create.spec.ts     [NEW: E2E workflows]
    ├── policies-deploy.spec.ts
    └── policies-responsive.spec.ts

open-webui/CLAUDE.md                [MODIFY: add C2 notes if applicable]
```

---

## Testing Checklist

- [ ] List view renders all policies from backend
- [ ] List filters work (draft/active/all)
- [ ] Editor loads policy correctly
- [ ] Markdown compile triggers on keystroke (debounce 500ms)
- [ ] Compile status updates: "Compiling" → "✅ Ready" or "❌ Error"
- [ ] Autosave triggers on blur (debounce 1000ms)
- [ ] Save status shows: "Saving" → "✅ Saved" or "❌ Error"
- [ ] Deploy button hidden when active
- [ ] Deploy success → status active, editor locked, button changes to Rollback
- [ ] Deploy error → status stays draft, error shown, suggest fix
- [ ] Rollback button only visible if active + previous_rego
- [ ] Rollback success → status draft, editor unlocked
- [ ] Rollback error → status stays active, error shown
- [ ] New policy workflow works (create → compile → deploy)
- [ ] Delete works on draft policies (confirm dialog)
- [ ] 404 handled (policy not found)
- [ ] 500 error → retry button works
- [ ] Network timeout → auto-retry works
- [ ] Mobile layout stacks panes vertically
- [ ] Vitest unit tests pass
- [ ] Playwright E2E tests pass

---

## Deliverables

**After coder completes C2:**
1. All 3 routes (list, editor, new) implemented + tested
2. Split-pane layout working on desktop/tablet/mobile
3. Live compile + autosave debounce working
4. Deploy/Rollback workflows working
5. Full test suite (unit + E2E)
6. Brief implementation notes if deviations from spec

---

## Model Selection

- **Implementation:** Haiku (SvelteKit is familiar, straightforward)
- **Testing:** Haiku (component tests + E2E)
- **Review:** Sonnet (UX + cross-layer consistency)

---

**Ready for coder implementation. Plan complete.**
