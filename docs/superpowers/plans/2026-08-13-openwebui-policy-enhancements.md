# Plan: C3 — Policy Enhancements (Audit, Versioning, Rollback, Tests)

**Date:** 2026-08-13  
**Spec:** `docs/superpowers/specs/2026-08-13-openwebui-policy-enhancements-design.md`  
**Complexity:** Medium (database schema changes, endpoint modifications, test additions)  
**Phases:** 4 independent sub-features (can be done sequentially or in parallel)

---

## Overview

Implement 4 governance + reliability enhancements to C1 backend:
- C3-A: Audit Logging (log all actions)
- C3-B: Versioning (immutable deployed version changelog)
- C3-C: Rollback Completion (finish endpoint + wire C2 UI)
- C3-D: 503 Test Coverage (automate MADE unreachable scenario)

Each is self-contained, can ship independently.

---

## C3-A: Audit Logging (2-3 days)

### Steps

**Step 1: Create DB migration**
- File: `open-webui/backend/open_webui/migrations/0XXX_create_policy_audit_log_table.py`
- Schema: policy_audit_log table (id, policy_id, action, user_id, timestamp, before, after, made_response, compile_success, compile_error)
- Indexes: policy_id, timestamp
- Follow Alembic migration pattern (existing in Open WebUI)

**Step 2: Create model**
- File: `open-webui/backend/open_webui/models/policy_audit_log.py`
- Class: `PolicyAuditLog(Base)` with all fields from schema
- No business logic, just ORM mapping

**Step 3: Create audit logging helper**
- File: `open-webui/backend/open_webui/utils/audit.py` or inline in routers
- Function: `log_policy_action(policy_id, action, user_id, before=None, after=None, made_response=None, compile_success=None, compile_error=None)`
- Serializes before/after to JSON
- Inserts into audit_log table
- Reused by all policy endpoints

**Step 4: Wire into C1 endpoints**
- Modify routers/policies.py:
  - POST /api/v1/policies (create) → call log_policy_action(action='create', before=None, after=policy)
  - PUT /api/v1/policies/:id (update) → call log_policy_action(action='update', before={old markdown}, after={new markdown})
  - POST /api/v1/policies/:id/compile (compile) → call log_policy_action(action='compile', compile_success=True/False, compile_error=...)
  - POST /api/v1/policies/:id/deploy (deploy) → call log_policy_action(action='deploy', made_response=...)
  - POST /api/v1/policies/:id/rollback (rollback) → call log_policy_action(action='rollback', made_response=...)
  - DELETE /api/v1/policies/:id (delete) → call log_policy_action(action='delete', before=policy, after=None)

**Step 5: Optional — audit trail display endpoint**
- Optional, can defer to later phase
- Endpoint: GET /api/v1/policies/:id/audit
- Returns: list of audit_log entries for this policy (ordered by timestamp DESC)
- Optional query params: ?action=deploy (filter by action type)

**Step 6: Testing**
- Unit tests: `test_audit_log_create`, `test_audit_log_deploy`, `test_audit_log_compile_error`
- Verify audit entries created for each action
- Integration test: `test_full_lifecycle_audit_trail` (create → update → compile → deploy)

---

## C3-B: Versioning (2-3 days)

### Steps (after C3-A, since deployments trigger versions)

**Step 1: Create DB migrations**
- File 1: `0XXX_create_policy_versions_table.py`
  - Schema: policy_versions (id, policy_id, version_number, rego_content, deployed_by, deployed_at)
  - Indexes: policy_id, version_number
- File 2: `0XXX_alter_policies_add_current_version.py`
  - Add field `current_version_id` to policies table (FK to policy_versions)

**Step 2: Create model**
- File: `open-webui/models/policy_versions.py`
- Class: `PolicyVersion(Base)` with all fields
- Helper method: `get_next_version_number(policy_id)` → returns current max + 1

**Step 3: Modify deploy endpoint**
- File: routers/policies.py, POST /api/v1/policies/:id/deploy
- After successful MADE deploy:
  1. Query next version_number: `next_version = get_next_version_number(policy_id)`
  2. Create PolicyVersion(policy_id, next_version, compiled_rego, user_id, timestamp)
  3. Update Policy.current_version_id = new_version.id
  4. Commit changes
- On failure: don't create version (only successful deploys are versioned)

**Step 4: Optional — versions list endpoint**
- Optional, can defer
- Endpoint: GET /api/v1/policies/:id/versions
- Returns: list of PolicyVersion entries for this policy (ordered by version_number DESC)
- Include: version_number, rego_content, deployed_by, deployed_at

**Step 5: Testing**
- Unit tests: `test_version_on_first_deploy` (deploy creates v1), `test_version_increments` (v1→v2)
- Integration test: `test_versions_only_on_success` (deploy fails → no version created)
- Verify versions are immutable (can't update rego_content)

---

## C3-C: Rollback Completion (1-2 days)

### Steps (after C3-A, since it logs; can be parallel with C3-B)

**Step 1: Implement rollback endpoint (replace 501)**
- File: routers/policies.py, POST /api/v1/policies/:id/rollback
- Preconditions:
  - Check `policy.status == 'active'` → 400 if not
  - Check `policy.previous_rego` exists → 400 if not
  - Check user is admin (already enforced by middleware)
- Process:
  1. Call MADE: `POST /api/policies/deploy` with `policy.previous_rego`
  2. On MADE success (200):
     - Swap: `active_rego` ↔ `previous_rego`
     - Set `status = 'draft'`
     - Call `log_policy_action(action='rollback', made_response=...)`
     - Return 200 + `{ status: 'draft', message: 'Rolled back' }`
  3. On MADE error (4xx/5xx):
     - Call `log_policy_action(action='rollback', made_response=... with error)`
     - Return 400 + `{ error: MADE error }`
  4. On MADE unreachable (network error):
     - Don't attempt rollback
     - Return 502 + `{ error: 'MADE unreachable' }`

**Step 2: Wire rollback button in C2 frontend**
- Modify C2 editor component (`open-webui/src/routes/workspace/policies/[id]/+page.svelte`)
- Show "Rollback" button only when:
  - `status === 'active'` AND
  - `previous_rego` exists (check in policy object)
- On click:
  - Confirm dialog: "Rollback to previous version?"
  - POST /api/v1/policies/:id/rollback
  - On success: status → draft, editor unlocked, show success banner
  - On error: show error banner with MADE error message

**Step 3: Testing**
- Unit tests: `test_rollback_swaps_rego`, `test_rollback_only_active`, `test_rollback_no_previous`
- Integration test: `test_rollback_full_workflow` (deploy → deploy → rollback to first)
- E2E test: Rollback button flow in C2 UI

---

## C3-D: MADE 503 Test Coverage (0.5 days)

### Steps (anytime after C3-A)

**Step 1: Add test to integration suite**
- File: `open-webui/backend/tests/test_policies_integration.py`
- Add function: `test_deploy_made_503_unreachable_no_rollback`
- Scenario:
  1. Policy is draft with previous_rego (was deployed before)
  2. Mock MADE to return 503 (Service Unavailable)
  3. Call POST /api/v1/policies/:id/deploy
  4. Verify:
     - Our endpoint returns 502 (bad gateway)
     - `policy.status` stays `draft`
     - `policy.active_rego` unchanged (no rollback)
     - `policy.last_error` contains "unreachable"
     - No second call to MADE (only one attempt)

**Step 2: Verify mock setup**
- Use existing test mock pattern (already in C1 tests)
- Mock httpx.post to raise 503 or return 503 response

**Step 3: Run test**
- `pytest open-webui/backend/tests/test_policies_integration.py::test_deploy_made_503_unreachable_no_rollback -v`
- Should pass (behavior already implemented in C1, just missing test)

---

## Files Modified / Created

```
open-webui/backend/open_webui/
├── migrations/
│   ├── 0XXX_create_policy_audit_log_table.py  [NEW: C3-A]
│   └── 0XXX_alter_policies_add_current_version.py  [NEW: C3-B]
├── models/
│   ├── policy_audit_log.py                     [NEW: C3-A]
│   └── policy_versions.py                      [NEW: C3-B]
├── utils/
│   └── audit.py                                [NEW: C3-A logging helper]
├── routers/
│   └── policies.py                             [MODIFY: add logging + versions + rollback]
└── tests/
    └── test_policies_integration.py            [MODIFY: add C3-D test]

open-webui/src/routes/workspace/policies/[id]/
└── +page.svelte                                [MODIFY: wire rollback button (C3-C)]
```

---

## Implementation Order (Recommended)

1. **C3-A (Audit Logging)** — 2-3 days
   - Foundation for all other features
   - Creates audit_log table, logging helper, wires into all C1 endpoints

2. **C3-B (Versioning)** — 2-3 days (parallel or after A)
   - Depends on A indirectly (A logs, B creates versions)
   - Creates policy_versions table, modifies deploy endpoint

3. **C3-C (Rollback Completion)** — 1-2 days (can be parallel)
   - Depends on A (needs audit logging)
   - Implement rollback endpoint, wire C2 button

4. **C3-D (503 Test)** — 0.5 days (after A, can ship anytime)
   - Just adds one test function
   - Can ship as follow-up PR or bundle with C3-C

**Total estimate:** 5-8 days for one coder (sequential), 3-4 days if parallel (A+B+C).

---

## Testing Checklist

**C3-A (Audit):**
- [ ] Migrations run without error
- [ ] Audit_log table exists in DB
- [ ] Audit entries logged on create/update/compile/deploy/rollback/delete
- [ ] Audit entries contain correct before/after/made_response
- [ ] Unit tests pass
- [ ] Integration test (full lifecycle) passes

**C3-B (Versioning):**
- [ ] Migrations run without error
- [ ] Policy_versions table exists
- [ ] Policies table has current_version_id field
- [ ] Deploy creates version entries (v1, v2, v3, ...)
- [ ] Version numbers increment correctly
- [ ] Versions not created on deploy failure
- [ ] Unit + integration tests pass

**C3-C (Rollback):**
- [ ] Rollback endpoint implemented (no more 501)
- [ ] Rollback only works on active policies
- [ ] Rollback swaps active/previous rego
- [ ] Rollback sets status → draft
- [ ] Rollback button visible/hidden in C2 UI
- [ ] Rollback click workflow works (confirm → POST → update)
- [ ] Error messages show correctly
- [ ] Unit + E2E tests pass

**C3-D (503 Test):**
- [ ] New test function added
- [ ] Test verifies no rollback on MADE 503
- [ ] Test verifies policy unchanged
- [ ] Test passes (confirms C1 behavior)

---

## Deliverables

**After coder completes C3:**
1. All 4 enhancements shipped (A+B+C+D)
2. DB migrations run cleanly
3. Audit logging working on all actions
4. Versioning tracking deployed versions
5. Rollback endpoint + C2 UI complete
6. 503 test coverage added
7. All unit + integration + E2E tests passing
8. Brief implementation notes if deviations from spec

---

## Model Selection

- **Implementation:** Haiku (backend modifications, schema changes)
- **Testing:** Haiku (unit + integration tests)
- **Review:** Sonnet (multi-layer consistency check)

---

**Ready for coder implementation. Plans complete.**
