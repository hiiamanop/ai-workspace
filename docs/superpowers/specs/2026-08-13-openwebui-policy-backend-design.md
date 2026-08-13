# Spec: C1 — Policy Backend (Open WebUI + MADE Integration)

**Date:** 2026-08-13  
**Author (Researcher):** Claude (ai-workspace researcher)  
**Status:** Ready for coder implementation  
**Related Brainstorm:** `docs/superpowers/brainstorms/2026-08-13-openwebui-policy-workspace.md`

---

## 1. Problem Statement

Admin needs to author governance policies (Markdown) that get compiled to Rego and deployed to MADE. Currently, policies are static Rego files in version control (developer-only). This spec enables **admin-only** policy authoring through Open WebUI's native workspace.

**Flow:**
1. Admin writes policy in Markdown (natural language)
2. LLM compiles to Rego (deterministic, verifiable)
3. Admin deploys → sent to MADE
4. On MADE rejection → auto-rollback (MADE stays at previous version)

---

## 2. Scope

**C1 covers BACKEND ONLY:**
- Policy data model (Open WebUI SQLite)
- REST API endpoints (CRUD + compile + deploy)
- LLM compilation service (our Node backend)
- MADE deployment & rollback logic
- Access control (admin-only)

**Out of scope (C2 — Frontend):**
- Markdown editor UI
- Rego preview pane
- Admin review interface
- SvelteKit routes

**Out of scope (C3 — MADE Sync enhancements):**
- Policy versioning/history
- Audit logging
- Manual rollback UI

---

## 3. Requirements

### 3.1 Functional Requirements

**FR-1: Policy CRUD (Create, Read, Update, Delete)**
- Create: `POST /api/v1/policies` → new policy, status: `draft`
- Read: `GET /api/v1/policies/:id` → retrieve one policy
- List: `GET /api/v1/policies` → all policies (filter by status optional)
- Update: `PUT /api/v1/policies/:id` → edit markdown_content (only if draft)
- Delete: `DELETE /api/v1/policies/:id` → delete (only if draft)

**FR-2: Compile Markdown to Rego**
- Endpoint: `POST /api/v1/policies/:id/compile`
- Input: policy markdown_content (from DB)
- Process:
  1. Call our Node backend `/api/compile-policy` (LLM compiles Markdown → Rego)
  2. Save compiled Rego to `policy.compiled_rego` (DB)
  3. Return compiled Rego + any warnings
- Output: `{ compiled_rego: string, warnings?: string[] }`
- Error: if LLM call fails, return 400 with error details

**FR-3: Deploy to MADE (Activate Policy)**
- Endpoint: `POST /api/v1/policies/:id/deploy`
- Precondition: policy status must be `draft`
- Process:
  1. Read `policy.compiled_rego` from DB
  2. If policy is currently `active`, save `policy.active_rego` → `policy.previous_rego`
  3. Send Rego to MADE: `POST /api/policies/deploy` with `{ policy_id, rego_content }`
  4. If MADE returns 200 (success):
     - Set `policy.active_rego = compiled_rego`
     - Set `policy.status = "active"`
     - Set `policy.deployed_at = now()`
     - Return 200 + success message
  5. If MADE returns error (4xx/5xx):
     - **ROLLBACK:** If `previous_rego` exists, send to MADE: `POST /api/policies/deploy` with previous_rego
     - Set `policy.status = "draft"` (revert to draft)
     - Set `policy.last_error = MADE error message`
     - Return 400 + error details + "Rolled back to previous version"
- Error scenarios:
  - MADE unreachable → 502 (can't rollback, policy stays as-is)
  - Rego has syntax error → MADE 400, rollback happens, return 400 to user

**FR-4: Manual Rollback (Future, out of scope but design for it)**
- Endpoint: `POST /api/v1/policies/:id/rollback` (optional for C1)
- Only works if `previous_rego` exists and status is `active`
- Sends `previous_rego` to MADE, reverts status to `draft`
- (Can be deferred to C3, but design API for it)

### 3.2 Access Control

**AC-1: Admin-only access**
- All endpoints require `user.role == "admin"` (check via Open WebUI's auth middleware)
- Non-admin requests → 403 Forbidden
- Implementation: Open WebUI's existing role-based auth (reuse their middleware)

**AC-2: Policy ownership tracking**
- Store `created_by: string` (admin user ID) in Policy model
- For audit trail (nice-to-have, not required for C1)

### 3.3 Data Model

**Policy (SQLite table in Open WebUI)**

```sql
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  markdown_content TEXT NOT NULL,
  compiled_rego TEXT,           -- Latest successful compile output
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'active'
  active_rego TEXT,             -- Currently deployed Rego (in MADE)
  previous_rego TEXT,           -- Previous active version (for rollback)
  created_by TEXT NOT NULL,     -- Admin user ID
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deployed_at TIMESTAMP,        -- When moved to 'active'
  last_error TEXT,              -- Error message from last failed deploy
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Field descriptions:**
- `id`: e.g., `"budget-policy-001"`, URL-safe, user-provided on create
- `name`: human-readable, e.g., "Budget Limit Policy"
- `markdown_content`: raw Markdown (natural language policy definition)
- `compiled_rego`: output from LLM compile (latest successful version)
- `status`: `draft` (editable, not live) | `active` (live in MADE, read-only)
- `active_rego`: what's currently running in MADE (for reference)
- `previous_rego`: previous version in MADE (for rollback without recompile)
- `created_by`: admin who created it (for audit)
- `last_error`: if deploy fails, store MADE's error message for user feedback

---

## 4. API Specification

### Base Path: `/api/v1/policies`

All endpoints require admin auth. Responses use Open WebUI's standard error format.

---

#### **POST /api/v1/policies** — Create new policy

**Request:**
```json
{
  "id": "budget-policy-001",
  "name": "Budget Limit Policy",
  "markdown_content": "Enforce cost limit of $0.10 per request, unless classified as restricted."
}
```

**Response (201):**
```json
{
  "id": "budget-policy-001",
  "name": "Budget Limit Policy",
  "markdown_content": "...",
  "compiled_rego": null,
  "status": "draft",
  "active_rego": null,
  "previous_rego": null,
  "created_by": "admin-user-id",
  "created_at": "2026-08-13T10:00:00Z",
  "deployed_at": null,
  "last_error": null
}
```

**Error (400):** Invalid ID (not URL-safe), missing required fields  
**Error (403):** User is not admin  
**Error (409):** Policy ID already exists

---

#### **GET /api/v1/policies** — List all policies

**Query params (optional):**
- `status=draft` or `status=active` — filter by status
- `limit=10&offset=0` — pagination

**Response (200):**
```json
{
  "policies": [
    {
      "id": "budget-policy-001",
      "name": "Budget Limit Policy",
      "status": "active",
      "created_by": "admin-user-id",
      "created_at": "2026-08-13T10:00:00Z",
      "deployed_at": "2026-08-13T10:05:00Z"
    },
    {
      "id": "cost-optimizer",
      "name": "Cost Optimizer",
      "status": "draft",
      "created_by": "admin-user-id",
      "created_at": "2026-08-13T10:10:00Z",
      "deployed_at": null
    }
  ],
  "total": 2
}
```

---

#### **GET /api/v1/policies/:id** — Retrieve one policy

**Response (200):**
```json
{
  "id": "budget-policy-001",
  "name": "Budget Limit Policy",
  "markdown_content": "...",
  "compiled_rego": "package hard_constraints\n...",
  "status": "active",
  "active_rego": "package hard_constraints\n...",
  "previous_rego": null,
  "created_by": "admin-user-id",
  "created_at": "2026-08-13T10:00:00Z",
  "deployed_at": "2026-08-13T10:05:00Z",
  "last_error": null
}
```

**Error (404):** Policy not found  
**Error (403):** User is not admin

---

#### **PUT /api/v1/policies/:id** — Update markdown (draft only)

**Request:**
```json
{
  "markdown_content": "New policy text..."
}
```

**Response (200):** Updated policy (status stays `draft`)

**Error (400):** Policy is `active`, can't edit live version  
**Error (404):** Policy not found  
**Error (403):** User is not admin

---

#### **DELETE /api/v1/policies/:id** — Delete (draft only)

**Response (204):** No content (success)

**Error (400):** Policy is `active`, can't delete live version  
**Error (404):** Policy not found  
**Error (403):** User is not admin

---

#### **POST /api/v1/policies/:id/compile** — Compile Markdown to Rego

**Request:** (no body, uses policy.markdown_content from DB)

**Response (200):**
```json
{
  "compiled_rego": "package hard_constraints\ndefault allow = false\nallow { ... }",
  "warnings": []
}
```

**Side effect:** Saves `compiled_rego` to DB (updates `policy.compiled_rego`)

**Error (404):** Policy not found  
**Error (400):** LLM compile failed (e.g., "Markdown is too vague for compilation")  
**Error (403):** User is not admin  
**Error (503):** Our Node backend unreachable

---

#### **POST /api/v1/policies/:id/deploy** — Deploy to MADE (Activate)

**Request:** (no body)

**Response (200):** Success
```json
{
  "status": "active",
  "deployed_at": "2026-08-13T10:15:00Z",
  "message": "Policy deployed successfully"
}
```

**Side effects on success:**
1. Open WebUI saves `policy.active_rego = policy.compiled_rego`
2. Open WebUI saves `policy.status = "active"`
3. Open WebUI saves `policy.deployed_at = now()`
4. MADE loads policy into `policies/hard/policy-id.rego`

**Error (400):** Policy status is `active`, can't deploy already-active policy  
**Error (404):** Policy not found or no compiled_rego yet  
**Error (403):** User is not admin  
**Error (400) with rollback:** MADE rejected the Rego
```json
{
  "status": "draft",
  "error": "MADE rejected policy: Rego syntax error on line 5",
  "rolled_back": true,
  "message": "Deployment failed. Rolled back to previous version. Fix the Rego and retry."
}
```

**Rollback logic (on MADE error):**
1. If `previous_rego` exists:
   - Send `previous_rego` to MADE (revert)
   - Set `policy.status = "draft"`
   - Set `policy.last_error = MADE error`
2. If no `previous_rego` (first deploy):
   - Set `policy.status = "draft"` (stays draft)
   - Set `policy.last_error = MADE error`
   - Return 400 (don't try to recover, nothing to rollback to)

**Error (502):** MADE unreachable (no rollback attempted; policy stays as-is, admin must retry)

---

#### **POST /api/v1/policies/:id/rollback** — Manual Rollback (optional for C1)

*(Design for future C3, but can be deferred from implementation)*

**Request:** (no body)

**Response (200):** Rolled back
```json
{
  "status": "draft",
  "message": "Rolled back to previous version"
}
```

**Preconditions:**
- Policy must be `active`
- `previous_rego` must exist

**Side effects:**
1. Send `previous_rego` to MADE
2. Set `policy.status = "draft"`
3. Current `active_rego` is now previous (can be re-deployed if needed)

---

## 5. Integration Points

### 5.1 Our Node Backend: LLM Compilation

**Endpoint:** `POST /api/compile-policy`

Open WebUI's Python backend calls our Node backend at this endpoint.

**Request:**
```json
{
  "markdown": "Admin-authored policy in Markdown..."
}
```

**Response (200):**
```json
{
  "rego": "package hard_constraints\ndefault allow = false\nallow { ... }",
  "warnings": []
}
```

**Error (400):** Markdown too vague or unparseable
```json
{
  "error": "Unable to compile: policy doesn't define clear constraints. Be more specific about model selection criteria."
}
```

**Implementation (our Node backend, `src/openwebui-policy-compiler.ts`):**
- Accept Markdown policy
- Call Claude LLM with system prompt about Rego syntax
- Parse Claude response, extract Rego block
- Validate basic Rego syntax (regex check, or light parse)
- Return Rego + any warnings
- No DB writes (stateless compiler)

---

### 5.2 MADE: Policy Deployment

**Endpoint:** `POST /api/policies/deploy` (or `PUT /policies/hard/:policy-id`)

*(Verify exact MADE endpoint with MADE backend — use what's actually available)*

**Request:**
```json
{
  "policy_id": "budget-policy-001",
  "rego_content": "package hard_constraints\n..."
}
```

**Response (200):** Success (MADE loaded policy)

**Error (400):** Rego syntax error, policy conflicts with existing rules, etc.
```json
{
  "error": "Rego syntax error on line 5: unexpected keyword 'allows'"
}
```

**Error (503):** MADE service unreachable

**Assumption:** MADE's policy deployment endpoint returns success/error synchronously (not async). If async, this spec needs revision.

---

## 6. Error Handling & Rollback

### Scenario 1: Deploy fails (Rego syntax error)
```
1. Admin clicks "Deploy" on policy v2
2. Open WebUI sends compiled Rego to MADE
3. MADE rejects: "Rego syntax error on line 5"
4. Open WebUI catches error (non-2xx response from MADE)
5. ROLLBACK:
   - If v1 was previously active (previous_rego exists):
     - Send previous_rego to MADE (restore v1)
     - Set policy.status = "draft"
     - Set policy.last_error = "MADE error..."
     - Return 400 + message: "Deployment failed, rolled back to previous version"
   - If v1 doesn't exist (first deploy):
     - Set policy.status = "draft" (stays draft, nothing to restore)
     - Set policy.last_error = "MADE error..."
     - Return 400 + message: "Deployment failed, fix Rego and retry"
```

### Scenario 2: MADE unreachable (network error)
```
1. Admin clicks "Deploy"
2. Open WebUI tries to reach MADE, times out
3. No rollback attempted (too risky without knowing MADE state)
4. Return 502 + message: "MADE unreachable, please retry"
5. Policy status unchanged (admin must retry manually)
```

### Scenario 3: Deploy succeeds, but later admin wants to revert
```
(Out of scope C1, defer to C3)
- Manual rollback endpoint POST /api/v1/policies/:id/rollback
- Requires previous_rego to exist
- Sends previous_rego to MADE
```

---

## 7. Access Control

**Middleware check (on all endpoints):**
```python
def require_admin(request):
    if request.user.role != "admin":
        return 403 Forbidden
```

**Reuse Open WebUI's existing role/auth system** (no new auth logic needed).

---

## 8. Testing Strategy (for coder)

**Unit tests:**
- `test_policy_create_draft` — POST creates policy with status=draft
- `test_policy_create_duplicate_id` — POST with duplicate ID returns 409
- `test_policy_compile_calls_node_backend` — compile endpoint hits `/api/compile-policy`
- `test_policy_compile_saves_rego` — successful compile saves to DB
- `test_policy_compile_error` — LLM failure returns 400
- `test_policy_deploy_success` — deploy succeeds, status=active, deployed_at set
- `test_policy_deploy_rollback_on_made_error` — MADE error triggers rollback to previous_rego
- `test_policy_deploy_no_previous_rollback` — first deploy fails, stays draft (no rollback)
- `test_policy_access_control_non_admin_403` — non-admin user gets 403

**Integration tests:**
- `test_deploy_flow_end_to_end` — create → compile → deploy → verify MADE got Rego
- `test_deploy_failure_and_recovery` — deploy fails → admin fixes Markdown → redeploy succeeds

**No need for E2E tests yet (C2 frontend not done).**

---

## 9. Database Migration

**For coder:**
- Create `policies` table schema (see section 3.3)
- Migration file name: `0XXX_create_policies_table.py` (follow Open WebUI's pattern)
- Make sure indexes on `status`, `created_by` (for filtering/audit)

---

## 10. Non-Goals & Deferred

**NOT in C1:**
- ✗ Policy versioning / full history (store all edits)
- ✗ Audit logging (who deployed when, change diffs)
- ✗ Multi-admin approval workflow
- ✗ Frontend UI (Markdown editor, Rego preview pane)
- ✗ MADE health monitoring (separate concern)
- ✗ Policy templating or reusable building blocks
- ✗ Dry-run testing (deploy to staging MADE first)

**Deferred to C2 (Frontend):**
- Markdown editor component
- Live Rego preview (recompile on every keystroke)
- Admin review interface
- Status badges (draft/active)
- Error message display in UI

**Deferred to C3 (MADE Sync enhancements):**
- Audit logging
- Version history
- Manual rollback button
- Policy diff view (what changed vs. previous)

---

## 11. Implementation Notes for Coder

**Technology stack (backend):**
- Open WebUI: Python/FastAPI (models + routers)
- Our Node backend: TypeScript (policy compiler)
- MADE backend: Python/FastAPI (policy deployment endpoint)

**Checklist:**
- [ ] Policy model in `open-webui/backend/open_webui/models/policies.py`
- [ ] Router in `open-webui/backend/open_webui/routers/policies.py`
- [ ] DB migration for policies table
- [ ] Admin auth middleware check
- [ ] Call our Node `/api/compile-policy` endpoint for LLM compile
- [ ] Call MADE `/api/policies/deploy` for deployment
- [ ] Rollback logic on MADE error
- [ ] Comprehensive unit tests
- [ ] Integration tests (compile + deploy flow)
- [ ] Error messages clear and actionable (for C2 frontend to display)

---

## Appendix: Example Policy (Markdown → Rego)

**Admin writes (Markdown):**
```markdown
# Budget Policy

Enforce cost limit per request:
- Maximum spend: $0.10 per request
- Exception: requests with data_classification="restricted" can exceed limit
- Quality requirement: model quality >= 0.5

Prefer cheap models for low-complexity questions:
- If task.complexity == "low", select model with lowest cost
- Quality threshold: still require quality >= 0.4
```

**LLM compiles to (Rego):**
```rego
package hard_constraints

default allow = false

allow {
    input.task.data_classification == "restricted"
}

allow {
    input.decision_kind == "model_selection"
    input.task.data_classification != "restricted"
}

budget_constraint[msg] {
    input.decision_kind == "model_selection"
    input.task.data_classification != "restricted"
    input.estimated_cost > 0.10
    msg := sprintf("Budget exceeded: estimated cost $%.2f > limit $0.10", [input.estimated_cost])
}

prefer_low_cost[candidate_id] {
    input.task.complexity == "low"
    input.decision_kind == "model_selection"
    candidates[candidate_id].scores.quality >= 0.4
}
```

---

**Spec ready for coder implementation. Next: Plan writing, then handoff to coder agent.**
