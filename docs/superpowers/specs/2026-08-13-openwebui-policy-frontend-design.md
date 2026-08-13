# Spec: C2 — Policy Frontend (SvelteKit UI)

**Date:** 2026-08-13  
**Author (Researcher):** Claude (ai-workspace researcher)  
**Status:** Ready for coder implementation  
**Depends on:** C1 backend (shipped at 0dc6c6a)  
**Related Brainstorm:** `docs/superpowers/brainstorms/2026-08-13-openwebui-policy-frontend.md`

---

## 1. Problem Statement

C1 shipped 7 REST endpoints for policy CRUD + compile + deploy. Admins can only interact via curl/Postman. C2 adds SvelteKit UI so admins can author policies visually.

**Flow:**
1. Admin opens Policy workspace in Open WebUI sidebar
2. See list of policies (status, created date)
3. Click policy → split-pane editor opens (Markdown left, Rego right)
4. Edit Markdown → live Rego preview updates (debounced)
5. Click "Deploy" → policy sent to MADE, status draft→active
6. On error, status stays draft, error message shown
7. Click "Rollback" (if available) → revert to previous version

---

## 2. Scope

**C2 covers FRONTEND ONLY:**
- SvelteKit routes + components
- Markdown editor (left pane) + Rego preview (right pane)
- List view, editor view, state management
- API integration (call C1 backend endpoints)
- Error display, status badges, autosave

**Out of scope (C3):**
- Version history sidebar
- Diff view (what changed between versions)
- Audit trail display
- Export / templates

---

## 3. Requirements

### 3.1 Functional Requirements

**FR-1: Policy List View**
- Route: `GET /workspace/policies/`
- Display: table with columns: Name, Status (badge), Created, Actions
- Status badges: `draft` (gray circle), `active` (green checkmark)
- Search box: filter by policy name (client-side)
- Filter button: show draft / active / all
- "New Policy" button → redirect to `/policies/new`
- Click policy row → redirect to `/policies/:id/`
- Delete button (only on draft policies) → confirm dialog → DELETE /api/v1/policies/:id

**FR-2: Policy Editor View**
- Route: `GET /workspace/policies/:id/` or `/policies/new` (new policy)
- Layout: two-pane split
  - Left pane: Markdown textarea (name + markdown_content)
  - Right pane: Rego preview (read-only `<pre>`)
- Header: policy name, status badge, action buttons
  - "Deploy" button (only if draft) → POST /api/v1/policies/:id/deploy
  - "Rollback" button (only if active + previous_rego exists) → POST /api/v1/policies/:id/rollback
  - "Delete" button (only if draft) → confirm dialog → DELETE
  - "Back to List" link
- On mount (edit mode): fetch policy via GET /api/v1/policies/:id

**FR-3: Live Compile on Edit**
- When user types in Markdown textarea:
  - Debounce 500ms (wait for user to stop typing)
  - Auto-trigger compile: POST /api/v1/policies/:id/compile
  - Show compiled Rego in right pane preview
  - Show compile status: "Compiling...", "✅ Compiled (2 sec ago)", or "❌ Error: [message]"
- On compile error: show error message in red banner above Rego pane

**FR-4: Autosave Markdown**
- When user leaves Markdown textarea (blur event):
  - Debounce 1000ms
  - Auto-save via PUT /api/v1/policies/:id
  - Show save status: "Saving...", "✅ Saved", or "❌ Save failed: [message]"
- Only on draft policies (active policies are read-only)

**FR-5: Deploy Policy**
- Click "Deploy" button
- Confirm dialog: "Deploy this policy to MADE? It will become active."
- POST /api/v1/policies/:id/deploy
- On success (200):
  - Status badge changes draft → active
  - Disable Markdown editor (read-only mode)
  - Hide "Deploy" button, show "Rollback" button
  - Show success banner: "Policy deployed successfully"
- On error (400/502):
  - Show error banner: "Deployment failed: [MADE error message]"
  - Suggest: "Rollback attempted if previous version exists. Fix and retry."
  - Status stays draft
  - Editor stays editable

**FR-6: Rollback Policy**
- Click "Rollback" button (only visible if active + previous_rego exists)
- Confirm dialog: "Rollback to previous version? This will revert MADE's active policy."
- POST /api/v1/policies/:id/rollback
- On success (200):
  - Status badge changes active → draft
  - Enable Markdown editor (editable again)
  - Show success banner: "Rolled back to previous version"
  - Hide "Rollback" button (need to deploy again to show it)
- On error (400/502):
  - Show error banner: "Rollback failed: [error]"
  - Status stays active, editor stays locked

**FR-7: New Policy**
- Route: `GET /workspace/policies/new`
- Open editor with empty Markdown textarea
- Policy name: auto-generate "Untitled Policy" (user can edit)
- Status: pre-set to draft
- "Deploy" button disabled until at least one compile succeeds
- First compile: POST /api/v1/policies creates it, gets back policy.id
- Editor updates to `/policies/:id/` with real policy ID

**FR-8: Status Indicators**
- Markdown editor locked (read-only) when policy is active
- Compile status shown: "Compiling...", "✅ Ready", "❌ Error"
- Save status shown: "Saving...", "✅ Saved", "❌ Error"
- Deploy/Rollback buttons show loading state (disabled + spinner) during API call
- All error messages displayed inline + in banner (not just alerts)

### 3.2 Non-Functional Requirements

**NF-1: Performance**
- Compile debounce: 500ms (prevent excessive LLM calls)
- Autosave debounce: 1000ms (prevent excessive DB writes)
- List should load in <1s (even with 100+ policies)

**NF-2: Error Handling**
- 403 Forbidden (non-admin): redirect to 403 page
- 404 Not Found (policy deleted by another admin): show error, redirect to list
- 500/502 (backend error): show error banner, retry button
- Network timeout: show "Connection lost" message, retry on reconnect

**NF-3: UX Polish**
- Keyboard shortcuts: Ctrl+S / Cmd+S to save (besides autosave)
- Markdown textarea focus styling (outline, border color)
- Rego preview has syntax highlighting (optional, use Prism.js if available in Open WebUI)
- Responsive layout: works on mobile (stack panes vertically) and desktop (side-by-side)

---

## 4. Component Architecture

### SvelteKit Routes

```
src/routes/workspace/policies/
├── +page.svelte                    [List view]
├── +page.server.ts                 [Server-side data loading (optional)]
├── [id]/
│   └── +page.svelte                [Editor view]
└── new/
    └── +page.svelte                [New policy editor]
```

### Key Stores (Svelte stores for state management)

```typescript
// stores/policies.ts
export const policies = writable<Policy[]>([]);  // all policies from list
export const currentPolicy = writable<Policy | null>(null);  // editing now
export const compileStatus = writable<'idle' | 'compiling' | 'success' | 'error'>('idle');
export const compileError = writable<string | null>(null);
export const saveStatus = writable<'idle' | 'saving' | 'success' | 'error'>('idle');
export const saveError = writable<string | null>(null);
export const deployStatus = writable<'idle' | 'deploying' | 'success' | 'error'>('idle');
export const deployError = writable<string | null>(null);
export const rollbackStatus = writable<'idle' | 'rolling' | 'success' | 'error'>('idle');
```

### API Client (reuse existing Open WebUI fetch wrapper)

```typescript
// lib/api/policies.ts
export async function fetchPolicies(): Promise<Policy[]>
export async function fetchPolicy(id: string): Promise<Policy>
export async function createPolicy(name: string, markdown: string): Promise<Policy>
export async function updatePolicy(id: string, markdown: string): Promise<Policy>
export async function compilePolicyMarkdown(id: string): Promise<{ rego: string, warnings?: string[] }>
export async function deployPolicy(id: string): Promise<{ status: string, deployed_at: string }>
export async function rollbackPolicy(id: string): Promise<{ status: string }>
export async function deletePolicy(id: string): Promise<void>
```

---

## 5. UI Layout Details

### List View (`+page.svelte`)

```html
<div class="workspace">
  <h1>Policies</h1>
  
  <div class="toolbar">
    <button class="btn-primary">+ New Policy</button>
    <input type="text" placeholder="Search policies..." />
    <select>
      <option value="all">All</option>
      <option value="draft">Draft</option>
      <option value="active">Active</option>
    </select>
  </div>

  <table class="policies-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Status</th>
        <th>Created</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each filteredPolicies as policy}
        <tr on:click={() => goto(`/policies/${policy.id}`)}>
          <td>{policy.name}</td>
          <td>
            {#if policy.status === 'draft'}
              <span class="badge draft">⚪ Draft</span>
            {:else}
              <span class="badge active">✓ Active</span>
            {/if}
          </td>
          <td>{new Date(policy.created_at).toLocaleDateString()}</td>
          <td>
            <button on:click={() => editPolicy(policy.id)}>Edit</button>
            {#if policy.status === 'draft'}
              <button on:click={() => deletePolicy(policy.id)}>Delete</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
```

### Editor View (`[id]/+page.svelte`)

```html
<div class="policy-editor">
  <div class="header">
    <input type="text" bind:value={currentPolicy.name} placeholder="Policy name" />
    <span class="badge" class:draft={status === 'draft'} class:active={status === 'active'}>
      {status === 'draft' ? '⚪ Draft' : '✓ Active'}
    </span>
    <div class="actions">
      {#if status === 'draft'}
        <button class="btn-primary" on:click={deploy} disabled={deployStatus === 'deploying'}>
          {deployStatus === 'deploying' ? '⏳ Deploying...' : 'Deploy'}
        </button>
      {/if}
      {#if status === 'active' && currentPolicy.previous_rego}
        <button on:click={rollback} disabled={rollbackStatus === 'rolling'}>
          {rollbackStatus === 'rolling' ? '⏳ Rolling back...' : 'Rollback'}
        </button>
      {/if}
      {#if status === 'draft'}
        <button on:click={deletePolicy} class="btn-danger">Delete</button>
      {/if}
      <button on:click={() => goto('/policies')}>Back</button>
    </div>
  </div>

  {#if deployError}
    <div class="banner error">
      ❌ Deployment failed: {deployError}
      {#if rollbackAttempted}
        Rolled back to previous version. Fix and retry.
      {/if}
    </div>
  {/if}

  {#if saveError}
    <div class="banner error">❌ Save failed: {saveError}</div>
  {/if}

  <div class="split-pane">
    <div class="pane left">
      <h3>Markdown</h3>
      <textarea
        bind:value={currentPolicy.markdown_content}
        on:blur={handleMarkdownBlur}
        placeholder="Write your policy in Markdown..."
        disabled={status === 'active'}
      />
      <div class="save-status">
        {#if saveStatus === 'saving'}
          💾 Saving...
        {:else if saveStatus === 'success'}
          ✅ Saved
        {:else if saveStatus === 'error'}
          ❌ Error
        {/if}
      </div>
    </div>

    <div class="pane right">
      <h3>Rego Preview</h3>
      <div class="compile-status">
        {#if compileStatus === 'compiling'}
          ⏳ Compiling...
        {:else if compileStatus === 'success'}
          ✅ Compiled
        {:else if compileStatus === 'error'}
          ❌ Error: {compileError}
        {/if}
      </div>
      <pre class="rego-preview"><code>{currentPolicy.compiled_rego || '(Click "Compile" to see Rego)'}</code></pre>
    </div>
  </div>
</div>
```

---

## 6. API Integration

All endpoints call C1 backend via standard fetch wrapper (existing Open WebUI pattern).

| Action | Method | Endpoint | Payload | Response |
|--------|--------|----------|---------|----------|
| List policies | GET | `/api/v1/policies` | - | `{ policies: [...], total: N }` |
| Get one | GET | `/api/v1/policies/:id` | - | `{ id, name, markdown_content, compiled_rego, status, ... }` |
| Create | POST | `/api/v1/policies` | `{ id, name, markdown_content }` | `{ ...policy }` |
| Update | PUT | `/api/v1/policies/:id` | `{ markdown_content }` | `{ ...policy }` |
| Compile | POST | `/api/v1/policies/:id/compile` | - | `{ compiled_rego, warnings? }` |
| Deploy | POST | `/api/v1/policies/:id/deploy` | - | `{ status, deployed_at }` or error |
| Rollback | POST | `/api/v1/policies/:id/rollback` | - | `{ status }` or error |
| Delete | DELETE | `/api/v1/policies/:id` | - | 204 No Content |

---

## 7. State Machine (Frontend)

**Policy Status Transitions:**

```
draft → (click Deploy) → deploying → active [or] error → draft
active → (click Rollback) → rolling → draft [or] error → active
draft → (click Delete) → deleted [or] error → draft
```

**Compile Status (independent):**
```
idle → (user types, debounce 500ms) → compiling → success [or] error
```

**Save Status (independent):**
```
idle → (user blur, debounce 1000ms) → saving → success [or] error
```

---

## 8. Error Handling

**403 Forbidden (non-admin):**
- Intercept at router level
- Redirect to `/403` page

**404 Not Found (policy deleted):**
- On fetch: show error banner "Policy not found"
- Redirect to list after 2s

**400 Bad Request (validation error):**
- Show banner with error message
- Don't redirect, let user fix

**500/502 Service Error:**
- Show banner "Backend error, please retry"
- Retry button
- Don't redirect

**Network timeout:**
- Show banner "Connection lost"
- Auto-retry every 5s
- Offline indicator in UI

---

## 9. Testing Strategy (for coder)

**Unit tests (SvelteKit component tests via Vitest):**
- List view renders all policies
- List filter works (draft/active/all)
- Editor view loads policy
- Markdown textarea debounce works
- Compile status updates on keystroke
- Save status updates on blur
- Deploy button disabled for active policies
- Rollback button only shows if previous_rego exists
- Error banners display correctly

**E2E tests (Playwright):**
- Create policy workflow (new → compile → deploy → active)
- Deploy failure → error shown, status stays draft
- Rollback → status active → draft, editor unlocked
- Delete draft policy
- Edit live policy fails (textarea locked)

**Manual testing:**
- Create, list, edit, deploy, rollback workflows
- All error scenarios (404, 500, timeout)
- Mobile responsiveness (split panes stack)

---

## 10. Responsive Design

**Desktop (>1024px):** Side-by-side panes (50/50 split)
**Tablet (768px-1024px):** Side-by-side (40/60)
**Mobile (<768px):** Stack vertically (Markdown full-width, Rego below)

Use CSS flexbox/grid (no special breakpoint library needed).

---

## 11. Non-Goals & Deferred

**NOT in C2:**
- ✗ Version history sidebar
- ✗ Policy diff view
- ✗ Rego syntax highlighting (nice-to-have, use plain `<pre>` if not available)
- ✗ Policy templates
- ✗ Export to file
- ✗ Audit trail display (C3 work)
- ✗ Keyboard shortcuts (Ctrl+S) — autosave is enough

**Deferred to C3:**
- Version history UI
- Audit log display
- Advanced rollback (to arbitrary version, not just previous)

---

## 12. Implementation Notes for Coder

**Tech stack:**
- SvelteKit (existing Open WebUI framework)
- Svelte stores for state
- Fetch API (reuse Open WebUI's wrapper)
- CSS (no external UI library required, match Open WebUI's styles)
- Optional: Prism.js for Rego syntax highlighting (if available)

**Checklist:**
- [ ] Create SvelteKit routes (list, editor, new)
- [ ] Implement stores (policies, compile status, save status, etc.)
- [ ] Create API client functions (call C1 endpoints)
- [ ] Build list view component
- [ ] Build editor view component (split pane, markdown textarea, rego preview)
- [ ] Wire compile debounce + live preview
- [ ] Wire autosave debounce + PUT
- [ ] Deploy button logic (confirm dialog + POST + status update)
- [ ] Rollback button logic (confirm dialog + POST + status update)
- [ ] Error handling (403 redirect, 404 banner, 500 retry, timeout)
- [ ] Unit tests (component + stores)
- [ ] E2E tests (Playwright workflows)
- [ ] Mobile responsive layout

---

**Spec ready for coder implementation. Next: Plan writing.**
