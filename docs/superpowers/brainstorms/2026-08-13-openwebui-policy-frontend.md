# Brainstorm: Sub-project C2 (Policy Frontend — Markdown Editor + Admin UI)

**Date:** 2026-08-13  
**Scope:** SvelteKit frontend for policy authoring workspace in Open WebUI  
**Depends on:** C1 backend (already shipped at 0dc6c6a)

## Problem Statement

C1 shipped backend API (7 endpoints: CRUD + compile + deploy), but no UI. Admins can only interact via curl/Postman.

**Goal:** Add SvelteKit frontend so admins can:
1. Create/list/edit/delete policies (UI, status tracking)
2. Click "Compile" → see live Rego preview (side-by-side editor)
3. Review Rego output → click "Deploy"
4. See status (draft/active) + error messages on deploy failure
5. Click "Rollback" to manually revert to previous version (if exists)

---

## Three Approaches

### Approach 1: "Minimal CRUD" — Just data entry, no preview
**Idea:** Simple form-based UI for policy CRUD. On compile, show Rego in a modal. Deploy via button.

**Implementation:**
- One route: `/workspace/policies/`
  - List view: table of policies (id, name, status, created_at)
  - Click policy → editor modal opens
  - Markdown textarea + Compile button + Deploy button
  - Rego output shown below in `<pre>` (read-only)

**Pros:**
- Minimal code, fast to ship
- Solves the basic workflow (create, compile, deploy)
- No complex state management needed

**Cons:**
- Poor UX: Markdown input + Rego output stacked vertically, cramped
- No live preview as user types
- Error messages shown as alerts, not inline
- No visual status indicators (badges, colors)
- No manual rollback UI (stub endpoint exists but unused)

**Tradeoff:** Quickest to ship, but UX feels basic. Works, not polished.

---

### Approach 2: "Professional Editor" — Split pane + live preview + status tracking
**Idea:** Left pane = Markdown editor, right pane = live Rego preview (recompile on every keystroke). Top bar shows status (draft/active) with visual badges.

**Implementation:**
- Route: `/workspace/policies/` (list) + `/workspace/policies/:id/` (editor)
- List view:
  - Table: policy id, name, status (badge: gray draft / green active), created_at, actions
  - "New Policy" button → redirects to `/policies/new`
  - Search/filter by status (draft/active)
  
- Editor view:
  - Header: policy name, status badge, "Deploy" / "Rollback" buttons
  - Two-pane layout:
    - Left: Markdown textarea (autosave on blur, debounced)
    - Right: Live Rego preview (recompile on each keystroke via debounce)
  - Show Rego side-by-side with warnings/errors inline
  - Error display: red banner at top + inline error on failed compile
  - On compile success: green "Ready to deploy" message
  - On deploy success: status badge changes draft→active, lock editor
  - On deploy failure: show MADE error, suggest fixes

**Pros:**
- Professional UX (split pane + live preview = industry standard)
- Quick feedback loop (see Rego as you type)
- Clear status tracking (badges, colors)
- Error messages inline + actionable
- Extensible (easy to add more features later)

**Cons:**
- More code (split layout + state sync + debounce logic)
- More API calls (recompile on every keystroke = noisy)
- Autosave complexity (handle conflicts if multiple tabs)
- Rollback button visible but maybe confusing (when does it appear?)

**Tradeoff:** Better UX, moderate complexity. Worth the investment.

---

### Approach 3: "Full-Featured IDE" — Tabs, version sidebar, diff view, export
**Idea:** Policy authoring as a full IDE: multiple tabs, version history sidebar, before/after diff, policy templates, export to file.

**Implementation:**
- Tabs: "editor", "versions", "diff", "templates"
- Left sidebar: version history (list of all deployed versions)
- Right sidebar: policy templates (copy-paste starter policies)
- Diff view: highlight what changed between versions
- Export: download Rego as .rego file, download policy as .yaml

**Pros:**
- Most polished, full-featured
- Version history visible (great for audit trail)
- Templates speed up policy creation
- Export for backup/sharing

**Cons:**
- High complexity (tabs + sidebar + diff highlighting + export)
- Overkill for MVP (C2 is just frontend, versioning is C3 work anyway)
- Long implementation time, high bug surface area
- Tabs/sidebar layout might be cluttered

**Tradeoff:** Most feature-rich, but too much for C2. Defer versioning/export to C3.

---

## Recommendation

**Go with Approach 2: Professional Editor**

**Why:**
- Sweet spot: UX is polished (split pane, live preview) without over-engineering
- Matches Open WebUI's UI standards (other workspaces like Skills have similar layouts)
- Extensible for C3 (add sidebar for version history, keep editor logic intact)
- Fast iteration (no tabs/modals, straightforward state management)

**Scope for C2:**
- ✅ List view (table, filter by status)
- ✅ Editor view (split pane: Markdown left, Rego right)
- ✅ Live compile on keystroke (debounced 500ms)
- ✅ Status badges (draft/active visual indicators)
- ✅ Deploy button (calls backend, updates status on success)
- ✅ Error display (inline + banner)
- ✅ Rollback button stub (calls endpoint, shows result)
- ✅ Autosave Markdown on blur (debounced)
- ✅ Lock editor when active (read-only mode)

**Scope deferred to C3:**
- ❌ Version history sidebar (requires DB versioning first, C3 work)
- ❌ Diff view (requires version comparison logic)
- ❌ Templates / export (nice-to-have, low priority)

---

## Implementation Notes for C2

**Frontend stack:**
- SvelteKit (existing Open WebUI tech)
- Markdown editor: use `svelte-simple-editor` or raw `<textarea>` (simple is fine)
- Rego preview: `<pre>` with syntax highlighting (optional, use Prism.js if available)
- State: Svelte stores for policy data, compile state, deploy status
- Debounce: use `debounce` utility (lodash or simple custom)

**Routes:**
- `/workspace/policies/` → list view
- `/workspace/policies/new` → new policy editor (empty Markdown, status=draft)
- `/workspace/policies/[id]/` → edit existing policy

**Integration with C1 backend:**
- Call 7 endpoints via our existing fetch wrapper
- Handle 403 (non-admin) → redirect to 403 page
- Handle 400/500 → display error banner with MADE message

**Testing (E2E via Playwright or Cypress):**
- Create policy → compile → deploy workflow
- Deploy failure → error message displays
- Rollback → status updates
- Autosave → verify Markdown saved without explicit button
- Status badge colors (draft gray, active green)

---

## UI Mockup (ASCII)

```
┌─────────────────────────────────────────────────────────────┐
│ Open WebUI Workspace > Policy                                │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│ 📋 Policies                                                   │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [+ New]  [Filter: All ▼]  [Search...]                  │ │
│ ├───────────────────────┬──────────┬──────────────────────┤ │
│ │ Name                  │ Status   │ Created              │ │
│ ├───────────────────────┼──────────┼──────────────────────┤ │
│ │ Budget Policy         │ ✓ ACTIVE │ Aug 13, 10:00 AM    │ │
│ │ Cost Optimizer        │ ⚪ DRAFT  │ Aug 13, 10:15 AM    │ │
│ └───────────────────────┴──────────┴──────────────────────┘ │
│                                                               │
│  → Click policy to edit                                      │
│                                                               │
└─────────────────────────────────────────────────────────────┘

─────────────────────────────────────────────────────────────

EDITOR VIEW (when editing a policy):

┌─────────────────────────────────────────────────────────────┐
│ Policy: Cost Optimizer              [⚪ DRAFT]               │
│ [Deploy]  [Rollback]  [Delete]                              │
├───────────────────────┬───────────────────────────────────┤
│ Markdown              │ Rego (live preview)               │
├───────────────────────┼───────────────────────────────────┤
│ # Cost Policy         │ package hard_constraints          │
│                       │                                   │
│ Enforce cost limit    │ default allow = false             │
│ for all requests      │                                   │
│                       │ allow {                           │
│ - Max: $0.10          │   input.task.org == "acme"       │
│ - Quality >= 0.4      │   input.cost <= 0.10             │
│ - Exception: none     │ }                                 │
│                       │                                   │
│                       │ ✅ Compile successful (2 sec ago) │
│                       │                                   │
├───────────────────────┴───────────────────────────────────┤
│ 💾 Auto-saving...                                          │
└───────────────────────────────────────────────────────────┘
```

---

## Next: Spec + Plan for C2

After brainstorm approval:
1. Write spec with exact SvelteKit routes, component structure, API calls
2. Write plan with 15-20 implementation steps
3. Deliver to coder
