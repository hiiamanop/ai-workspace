# Spec: C3 — Policy Enhancements (Audit, Versioning, Rollback, Tests)

**Date:** 2026-08-13  
**Author (Researcher):** Claude (ai-workspace researcher)  
**Status:** Ready for coder implementation  
**Depends on:** C1 backend (0dc6c6a) + C2 frontend (WIP)  
**Related Brainstorm:** `docs/superpowers/brainstorms/2026-08-13-openwebui-policy-enhancements.md`

---

## 1. Overview

C3 ships 4 independent governance + reliability enhancements:

- **C3-A: Audit Logging** — log all policy actions (create/update/compile/deploy/rollback/delete)
- **C3-B: Policy Versioning** — immutable changelog of deployed versions
- **C3-C: Rollback Completion** — implement rollback endpoint + button UI
- **C3-D: 503 Test Coverage** — automate MADE unreachable scenario

Each is self-contained, can be shipped separately or in groups.

---

## 2. C3-A: Audit Logging

### Problem

No record of who deployed what or when. MADE policies change silently.

### Requirements

**FR-A1: Log all policy actions**
- Table: `policy_audit_log` (see section 4)
- Actions logged: `create`, `update`, `compile`, `deploy`, `rollback`, `delete`
- For each action: user_id, timestamp, policy_id, action, before/after state, MADE response (if deploy/rollback)
- Retention: permanent (no cleanup)

**FR-A2: Log entry on every mutation**
- Create policy → log action=`create`, before=null, after={policy}
- Update markdown (blur autosave) → log action=`update`, before={old markdown}, after={new markdown}
- Compile → log action=`compile`, before={compiled_rego}, after={new compiled_rego}, compile_success=true/false, compile_error=null/message
- Deploy → log action=`deploy`, before={status}, after={status}, made_response={success/error}
- Rollback → log action=`rollback`, before={status}, after={status}, made_response={success/error}
- Delete → log action=`delete`, before={policy}, after=null

**FR-A3: Optional UI — audit trail display** (low priority, can defer to later C3 phase)
- Route: `/workspace/policies/:id/audit` (show all log entries for this policy)
- Table: timestamp, action, user, before/after diff, made_response
- Search/filter by action type
- (Optional, not required for C3-A shipping)

### Implementation

**Backend (Python/FastAPI in Open WebUI):**

1. Create migration: `0XXX_create_policy_audit_log_table.py`
   ```sql
   CREATE TABLE policy_audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     policy_id TEXT NOT NULL,
     action TEXT NOT NULL,  -- 'create'|'update'|'compile'|'deploy'|'rollback'|'delete'
     user_id TEXT NOT NULL,
     timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     before TEXT,           -- JSON (old policy state or old markdown)
     after TEXT,            -- JSON (new policy state or new markdown)
     made_response TEXT,    -- JSON (MADE response if deploy/rollback)
     compile_success BOOLEAN,  -- null if not compile action
     compile_error TEXT,    -- error message if compile failed
     FOREIGN KEY (policy_id) REFERENCES policies(id)
   );
   INDEX policy_audit_log_policy_id
   INDEX policy_audit_log_timestamp
   ```

2. Create model: `open-webui/models/policy_audit_log.py`
   - Class `PolicyAuditLog(Base)` with fields from schema above

3. Logging helper function: `src/audit.ts` or similar
   - Call this from each policy endpoint (create, update, compile, deploy, rollback, delete)
   - Log entry automatically captured with user_id, timestamp, before/after

4. Wire into C1 endpoints (modify existing routers to log):
   - POST /api/v1/policies → log create
   - PUT /api/v1/policies/:id → log update
   - POST /api/v1/policies/:id/compile → log compile (success/error)
   - POST /api/v1/policies/:id/deploy → log deploy (success/error, include MADE response)
   - POST /api/v1/policies/:id/rollback → log rollback (success/error, include MADE response)
   - DELETE /api/v1/policies/:id → log delete

5. Optional: GET /api/v1/policies/:id/audit (return list of audit log entries for this policy)
   - Used by C2 frontend if audit display UI is added

### Testing

- Unit test: `test_audit_log_on_create` — create policy, verify audit entry
- Unit test: `test_audit_log_on_deploy` — deploy, verify audit entry with MADE response
- Integration test: `test_full_lifecycle_audit_trail` — create → update → compile → deploy, verify all logged

---

## 3. C3-B: Policy Versioning

### Problem

No way to see what was deployed when. If policy breaks, hard to revert to a known good version.

### Requirements

**FR-B1: Immutable version changelog**
- Table: `policy_versions` (see section 4)
- On each successful deploy:
  1. Create new row: policy_id, version_number (auto-increment), rego_content, deployed_by, deployed_at
  2. Version becomes immutable (can't edit)
- Retention: permanent (full history)

**FR-B2: Version in-policy tracking**
- Policies table: add field `current_version` (FK to policy_versions, can be null for drafts)
- On deploy success: update current_version to new version

**FR-B3: Optional UI — version sidebar in editor** (low priority, can defer)
- Route: `/workspace/policies/:id/versions` (show all deployed versions)
- List: version_number, deployed_at, deployed_by, action button "View" (shows Rego read-only)
- Click version → show its Rego in preview pane (read-only)
- (Optional, not required for C3-B shipping)

### Implementation

**Backend (Python/FastAPI in Open WebUI):**

1. Create migration: `0XXX_create_policy_versions_table.py`
   ```sql
   CREATE TABLE policy_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     policy_id TEXT NOT NULL,
     version_number INTEGER NOT NULL,  -- starts at 1, increments on each deploy
     rego_content TEXT NOT NULL,        -- deployed Rego code (immutable)
     deployed_by TEXT NOT NULL,         -- user_id who deployed
     deployed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (policy_id) REFERENCES policies(id),
     UNIQUE (policy_id, version_number)
   );
   INDEX policy_versions_policy_id
   ```

2. Modify policies table: add field `current_version` (FK to policy_versions, nullable)

3. Create model: `open-webui/models/policy_versions.py`
   - Class `PolicyVersion(Base)` with fields from schema above
   - Helper method: `get_next_version_number(policy_id)`

4. Wire into deploy endpoint:
   - On successful deploy:
     1. Query latest version_number for this policy
     2. Create new PolicyVersion(policy_id, version_number+1, compiled_rego, user_id, timestamp)
     3. Update Policy.current_version = new_version.id
     4. Return success

5. Optional: GET /api/v1/policies/:id/versions
   - Return list of all versions for this policy (ordered by version_number DESC)
   - Include: version_number, deployed_at, deployed_by, link to Rego content

### Testing

- Unit test: `test_version_on_first_deploy` — deploy draft policy, verify version_number=1
- Unit test: `test_version_number_increments` — deploy same policy twice, verify v1 then v2
- Integration test: `test_versions_immutable` — deploy, verify Rego can't be edited in versions table

---

## 4. C3-C: Rollback Completion

### Problem

C1 has rollback endpoint stubbed (returns 501). C2 frontend has rollback button hidden. Need to complete implementation + wire UI.

### Requirements

**FR-C1: Implement rollback endpoint (complete)**
- Endpoint: `POST /api/v1/policies/:id/rollback`
- Preconditions:
  - Policy status must be `active`
  - `previous_rego` must exist (was deployed before)
  - User must be admin (already enforced by middleware)
- Process:
  1. Call MADE: `POST /api/policies/deploy` with `previous_rego`
  2. On success:
     - Swap: `active_rego` ↔ `previous_rego` (so can rollback again)
     - Set `status = draft`
     - Create new audit log entry (action=`rollback`, success)
     - Create new version entry? → NO (versions only for deployments, not rollbacks)
     - Return 200 + `{ status: 'draft', message: 'Rolled back' }`
  3. On failure:
     - Create audit log entry (action=`rollback`, error)
     - Return 400 + `{ error: MADE error }`
  4. On MADE unreachable (502):
     - Don't attempt rollback (risky, state unknown)
     - Return 502 + `{ error: 'MADE unreachable' }`

**FR-C2: Rollback button in C2 frontend**
- Show only when:
  - Policy status is `active` AND
  - `previous_rego` exists (check via GET /api/v1/policies/:id before rendering)
- On click:
  - Confirm dialog: "Rollback to previous version?"
  - POST /api/v1/policies/:id/rollback
  - On success: status badge active→draft, editor unlocked, show success banner
  - On error: show error banner with MADE message

**FR-C3: Audit trail for rollbacks**
- Rollback creates audit log entry (action=`rollback`, made_response)
- Visible in C3-A audit UI (when shipped)

### Implementation

**Backend (Python/FastAPI):**

1. Modify routers/policies.py:
   - Replace 501 stub with full implementation
   - Follow FR-C1 logic above
   - Ensure audit logging happens

**Frontend (SvelteKit):**

1. Modify C2 editor component:
   - Add "Rollback" button (show only if active + previous_rego exists)
   - Wire to POST /api/v1/policies/:id/rollback
   - Update status + editor state on success
   - Show error banner on failure

### Testing

- Unit test: `test_rollback_swaps_active_previous` — rollback, verify active/previous swapped
- Unit test: `test_rollback_only_active` — try rollback on draft, verify 400
- Unit test: `test_rollback_no_previous` — try rollback with no previous_rego, verify 400
- Integration test: `test_rollback_full_workflow` — deploy → deploy again → rollback to first
- E2E test (Playwright): deploy → button appears → click rollback → status changes, editor unlocks

---

## 5. C3-D: MADE 503 Test Coverage

### Problem

C1 handles MADE 503 correctly (deploy fails, no rollback attempted), but no automated test.

### Requirements

**FR-D1: Add test for MADE 503 scenario**
- File: `open-webui/backend/tests/test_policies_integration.py`
- Test function: `test_deploy_made_503_unreachable_no_rollback`
- Scenario:
  1. Policy is draft, previous_rego exists (from prior deploy)
  2. Mock MADE to return 503 (Service Unavailable)
  3. Call POST /api/v1/policies/:id/deploy
  4. Verify:
     - Our endpoint returns 502 (we interpret MADE 503 as bad gateway)
     - `policy.status` stays `draft` (no rollback)
     - `policy.active_rego` unchanged (rollback NOT attempted)
     - `policy.last_error` contains "MADE unreachable" or similar
     - No second call to MADE (no retry/rollback logic)

### Implementation

**Backend (Python/pytest):**

```python
def test_deploy_made_503_unreachable_no_rollback(client, db, admin_user, policy_with_previous):
    """
    MADE unreachable (503) → we return 502, no rollback attempted.
    Policy status unchanged, can retry later.
    """
    # Mock MADE to return 503
    with patch('httpx.post', side_effect=httpx.HTTPStatusError(503, ...)):
        response = client.post(
            f'/api/v1/policies/{policy_with_previous.id}/deploy',
            headers={'Authorization': f'Bearer {admin_token}'}
        )
    
    # Verify: we return 502
    assert response.status_code == 502
    
    # Verify: policy unchanged
    policy = db.query(Policy).get(policy_with_previous.id)
    assert policy.status == 'draft'  # still draft
    assert policy.active_rego == policy_with_previous.active_rego  # unchanged
    assert 'unreachable' in policy.last_error.lower()
    
    # Verify: no second MADE call (no rollback)
    # (Use mock.call_count == 1 to verify only one attempt)
```

### Testing

- Unit test: `test_deploy_made_503_unreachable_no_rollback` (see above)

---

## 6. Database Schema (C3)

### policy_audit_log

```sql
CREATE TABLE policy_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'compile', 'deploy', 'rollback', 'delete')),
  user_id TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  before TEXT,  -- JSON: old policy/markdown (null for create)
  after TEXT,   -- JSON: new policy/markdown (null for delete)
  made_response TEXT,  -- JSON: MADE's response (deploy/rollback only)
  compile_success BOOLEAN,  -- true/false if action=compile, null otherwise
  compile_error TEXT,  -- LLM compile error message if action=compile and failed
  FOREIGN KEY (policy_id) REFERENCES policies(id),
  INDEX idx_policy_audit_log_policy_id (policy_id),
  INDEX idx_policy_audit_log_timestamp (timestamp)
);
```

### policy_versions

```sql
CREATE TABLE policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  rego_content TEXT NOT NULL,
  deployed_by TEXT NOT NULL,
  deployed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (policy_id) REFERENCES policies(id),
  UNIQUE(policy_id, version_number),
  INDEX idx_policy_versions_policy_id (policy_id)
);
```

### Modify policies table

```sql
ALTER TABLE policies ADD COLUMN current_version_id INTEGER;
ALTER TABLE policies ADD FOREIGN KEY (current_version_id) REFERENCES policy_versions(id);
```

---

## 7. Implementation Order (Recommended)

1. **C3-A (Audit Logging)** — foundation, other features log to it
   - Create table, model, logging helper
   - Wire into all C1 endpoints
   - Add optional audit trail display endpoint

2. **C3-B (Versioning)** — pairs naturally with audit
   - Create tables, models
   - Modify deploy endpoint to create version entries
   - Add optional versions list endpoint

3. **C3-C (Rollback Completion)** — depends on A done (for audit)
   - Implement rollback endpoint (replace 501 stub)
   - Wire C2 rollback button (if C2 shipped)

4. **C3-D (503 Test)** — can ship anytime after C3-A/B
   - Add one test function
   - Ship as follow-up PR or bundle with C3-C

---

## 8. Testing Strategy

**Unit tests:**
- Audit logging on each action type (create, update, compile, deploy, rollback, delete)
- Version number increments correctly
- Rollback swaps active/previous rego
- Rollback only works on active policies

**Integration tests:**
- Full lifecycle with audit trail (create → update → compile → deploy → rollback)
- Deploy failure with previous_rego → audit logged correctly
- MADE 503 scenario → no rollback attempted
- Versions increment across multiple deploys

**E2E tests (if C2 shipped):**
- Rollback button visible/hidden appropriately
- Rollback workflow (confirm → POST → status updates)

---

## 9. Non-Goals & Deferred

**NOT in C3:**
- ✗ Policy comparison view (diff old vs new)
- ✗ Version restore to arbitrary version (only rollback to immediate previous)
- ✗ Audit log purging / retention policies
- ✗ MADE policy rollback confirmation (we assume MADE succeeds)

**Deferred to C4:**
- Advanced version management (restore to arbitrary version, compare versions)
- Policy templates / bulk operations
- Performance optimization (audit log indexing if it grows large)

---

## 10. Implementation Notes for Coder

**Checklist C3-A (Audit):**
- [ ] Create migration + table
- [ ] Create model
- [ ] Create audit logging helper function
- [ ] Wire into all C1 endpoints (create, update, compile, deploy, rollback, delete)
- [ ] Optional: implement GET /api/v1/policies/:id/audit endpoint
- [ ] Unit tests: audit on each action
- [ ] Integration test: full lifecycle audit trail

**Checklist C3-B (Versioning):**
- [ ] Create migration + table
- [ ] Create model + helper methods
- [ ] Modify deploy endpoint to create version entries
- [ ] Optional: implement GET /api/v1/policies/:id/versions endpoint
- [ ] Unit tests: version number increments
- [ ] Integration test: full lifecycle with versions

**Checklist C3-C (Rollback):**
- [ ] Implement rollback endpoint (replace 501)
- [ ] Follow FR-C1 logic (swap, status→draft, audit log)
- [ ] Wire C2 rollback button (if C2 shipped)
- [ ] Unit tests: rollback conditions
- [ ] Integration test: full rollback workflow
- [ ] E2E test: button + UI interaction

**Checklist C3-D (503 Test):**
- [ ] Add `test_deploy_made_503_unreachable_no_rollback` to integration tests
- [ ] Verify: 502 returned, no rollback attempted, policy unchanged

---

**Spec ready for coder implementation. Next: Plan writing for C2 and C3.**
