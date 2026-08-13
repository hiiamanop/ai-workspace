# Plan: C1 — Policy Backend Implementation

**Date:** 2026-08-13  
**Spec:** `docs/superpowers/specs/2026-08-13-openwebui-policy-backend-design.md`  
**Complexity:** High (Python backend + API integration + error handling)  
**Phases:** 1 (all backend, C2/C3 deferred)

---

## Overview

Implement Open WebUI backend for policy CRUD, compilation (LLM), and deployment (MADE) with auto-rollback on errors. Admin-only access. Fully tested before C2 frontend.

---

## Step-by-Step Implementation

### Phase 1: Database & Model

**Step 1: Create DB migration for policies table**
- File: `open-webui/backend/open_webui/migrations/0XXX_create_policies_table.py`
- Table: `policies` (id, name, markdown_content, compiled_rego, status, active_rego, previous_rego, created_by, created_at, deployed_at, last_error, updated_at)
- Indexes: `status`, `created_by`
- Run migration on next docker compose up

**Step 2: Define Policy model**
- File: `open-webui/backend/open_webui/models/policies.py`
- Class: `Policy(Base)` with all fields from schema (section 3.3 of spec)
- Add helper methods: `is_draft()`, `is_active()`, `can_edit()` (returns True if draft)
- Add timestamp tracking: `created_at`, `updated_at`

---

### Phase 2: Router & CRUD Endpoints

**Step 3: Create policies router**
- File: `open-webui/backend/open_webui/routers/policies.py`
- Implement all 7 endpoints:
  1. `POST /api/v1/policies` — create (201 or 409 if duplicate)
  2. `GET /api/v1/policies` — list (with optional filters: status, limit, offset)
  3. `GET /api/v1/policies/:id` — retrieve one
  4. `PUT /api/v1/policies/:id` — update markdown (only if draft)
  5. `DELETE /api/v1/policies/:id` — delete (only if draft)
  6. `POST /api/v1/policies/:id/compile` — trigger compile
  7. `POST /api/v1/policies/:id/deploy` — deploy to MADE (with rollback logic)
- Optional: `POST /api/v1/policies/:id/rollback` (stub for C3, returns 501 Not Implemented)

**Step 4: Add admin-only auth middleware**
- Check `request.user.role == "admin"` on all endpoints
- Reuse Open WebUI's existing auth decorators
- Return 403 if not admin

**Step 5: Add policy retrieval helper**
- Function: `get_policy_or_404(policy_id, db)` — fetch policy, raise 404 if not found
- Used by all endpoints that take `:id`

---

### Phase 3: LLM Compilation Integration

**Step 6: Call Node backend for compilation**
- In compile endpoint (`POST /api/v1/policies/:id/compile`):
  1. Read policy.markdown_content from DB
  2. Call our Node backend: `POST http://localhost:3000/api/compile-policy`
  3. Parse response, extract `rego` field
  4. Save to `policy.compiled_rego` in DB
  5. Return compiled_rego + warnings
- Error handling:
  - Node backend unreachable → 503 Service Unavailable
  - LLM compile error → 400 + error details
  - Network timeout → 503

**Step 7: Ensure Node backend has compile endpoint**
- File: `src/openwebui-policy-compiler.ts` (coder must implement)
- Endpoint: `POST /api/compile-policy`
- Input: `{ markdown: string }`
- Output: `{ rego: string, warnings?: string[] }`
- Process:
  - Call Claude LLM with system prompt: "You are a Rego/OPA expert. Compile the following policy description to OPA Rego code. Only output the Rego, no explanation."
  - Extract Rego block from Claude response
  - Basic validation: contains "package", no obvious syntax errors
  - Return Rego + any warnings
  - On error: return 400 + `{ error: string }`

---

### Phase 4: MADE Integration & Deployment

**Step 8: Deploy to MADE (with rollback)**
- Endpoint: `POST /api/v1/policies/:id/deploy`
- Precondition check: policy status must be "draft"
- Process:
  1. Read `policy.compiled_rego` from DB (must exist)
  2. If policy.active_rego is not null:
     - Save `policy.active_rego` → `policy.previous_rego` (backup current)
  3. Call MADE: `POST /api/policies/deploy` with `{ policy_id, rego_content: policy.compiled_rego }`
  4. **If MADE succeeds (200):**
     - Set `policy.active_rego = policy.compiled_rego`
     - Set `policy.status = "active"`
     - Set `policy.deployed_at = now()`
     - Set `policy.last_error = null`
     - Return 200 + success message
  5. **If MADE fails (4xx/5xx):**
     - **ROLLBACK** if `policy.previous_rego` exists:
       - Call MADE again: `POST /api/policies/deploy` with `{ policy_id, rego_content: policy.previous_rego }`
       - Set `policy.status = "draft"` (revert to draft)
       - Set `policy.last_error = MADE error message`
       - Return 400 + "Deployment failed, rolled back to previous"
     - **NO ROLLBACK** if no `previous_rego`:
       - Set `policy.status = "draft"` (stays draft)
       - Set `policy.last_error = MADE error message`
       - Return 400 + "Deployment failed, fix and retry"
  6. **If MADE unreachable (network error):**
     - Do NOT attempt rollback (state unknown)
     - Return 502 + "MADE unreachable"
     - Policy status unchanged

**Step 9: Verify MADE endpoint**
- Before implementing: confirm MADE's actual endpoint URL and schema
- Adjust step 8 if needed (e.g., if endpoint is `PUT /policies/hard/:id` instead of `POST /api/policies/deploy`)
- Test with mock MADE response first

---

### Phase 5: Error Handling & Edge Cases

**Step 10: Handle all error scenarios**
- Duplicate policy ID on create → 409
- Update/delete non-draft policy → 400 "Can't edit/delete active policy"
- Deploy with no compiled_rego → 400 "Compile first"
- Compile call to Node backend fails → 503
- MADE unreachable on deploy → 502
- LLM compile too vague → 400 "Markdown is too vague..."
- All error responses include `{ error: string, details?: string }`

**Step 11: Ensure idempotency**
- Deploy same policy twice → second call returns 400 "Policy already active" (don't change status)
- Compile same policy twice → overwrites previous compiled_rego (ok, same LLM call)

---

### Phase 6: Testing

**Step 12: Unit tests (pytest)**
- File: `open-webui/backend/tests/test_policies.py`
- Test CRUD operations:
  - `test_create_policy_draft` ✅ POST creates with status=draft
  - `test_create_duplicate_409` ✅ POST duplicate ID returns 409
  - `test_list_policies` ✅ GET returns all policies
  - `test_list_filter_by_status` ✅ GET with ?status=draft filters
  - `test_get_policy` ✅ GET :id retrieves one
  - `test_get_policy_404` ✅ GET nonexistent returns 404
  - `test_update_draft_ok` ✅ PUT markdown on draft succeeds
  - `test_update_active_400` ✅ PUT on active returns 400
  - `test_delete_draft_ok` ✅ DELETE draft succeeds
  - `test_delete_active_400` ✅ DELETE active returns 400
  - `test_delete_404` ✅ DELETE nonexistent returns 404
- Test compile:
  - `test_compile_calls_node_backend` ✅ compile endpoint hits /api/compile-policy
  - `test_compile_saves_rego` ✅ successful compile saves to DB
  - `test_compile_node_error_503` ✅ Node backend down returns 503
  - `test_compile_llm_error_400` ✅ LLM compile fails returns 400
- Test deploy:
  - `test_deploy_success` ✅ deploy succeeds, status→active, deployed_at set
  - `test_deploy_already_active_400` ✅ deploy active policy returns 400
  - `test_deploy_made_error_rollback` ✅ MADE error → rollback to previous_rego, status→draft
  - `test_deploy_first_time_no_rollback` ✅ first deploy fails → no rollback, stays draft
  - `test_deploy_made_unreachable_502` ✅ MADE down → 502, no rollback
  - `test_deploy_saves_active_rego` ✅ successful deploy saves active_rego + deployed_at
- Test access control:
  - `test_non_admin_403` ✅ non-admin user gets 403 on all endpoints
  - `test_admin_allowed` ✅ admin user allowed

**Step 13: Integration tests**
- File: `open-webui/backend/tests/test_policies_integration.py`
- Mock MADE endpoint (use `responses` library or `unittest.mock`)
- Test full flows:
  - `test_create_compile_deploy_flow` ✅ create → compile → deploy → MADE receives Rego
  - `test_deploy_fail_rollback_recovery` ✅ deploy fails → rollback → admin fixes Markdown → redeploy succeeds
  - `test_concurrent_deploys` ✅ two admins deploy same policy (second gets 400 "already active")

**Step 14: Manual testing with mocked MADE**
- Set up local MADE mock (return 200 for success, 400 for simulated error)
- Test all endpoints with curl/Postman
- Verify DB state after each operation

---

### Phase 7: Integration with codebase

**Step 15: Wire into Open WebUI's router initialization**
- File: `open-webui/backend/open_webui/main.py` (or equivalent)
- Import policies router
- Register: `app.include_router(policies_router, prefix="/api/v1")`
- Ensure migrations run on startup

**Step 16: Update .env.example**
- Add (if needed): `OPENWEBUI_ADMIN_EMAIL` (already in CLAUDE.md for provisioning)
- Confirm MADE_URL is configured (used by deploy endpoint)

**Step 17: Verify Docker build**
- Test `docker compose up` after all changes
- Policies DB table created
- Router registered and endpoints respond
- curl test: `POST http://localhost:3001/api/v1/policies` → 401 (no auth) or 403 (non-admin)

---

## Files Modified / Created

```
open-webui/backend/open_webui/
├── migrations/
│   └── 0XXX_create_policies_table.py          [NEW]
├── models/
│   └── policies.py                             [NEW]
├── routers/
│   └── policies.py                             [NEW]
└── main.py                                     [MODIFY: register router]

src/
└── openwebui-policy-compiler.ts                [NEW: LLM compile endpoint]

open-webui/backend/tests/
├── test_policies.py                            [NEW: unit tests]
└── test_policies_integration.py                [NEW: integration tests]

.env.example                                    [MODIFY: add MADE_URL if missing]
```

---

## Testing Checklist (for coder)

- [ ] Migrations run without error
- [ ] Policy model loads correctly from DB
- [ ] All 7 CRUD endpoints respond (at least 403 for non-admin)
- [ ] Admin user can create, list, retrieve policies
- [ ] Compile endpoint calls Node backend, saves Rego
- [ ] Deploy endpoint calls MADE, updates status
- [ ] Rollback logic works on MADE error
- [ ] 404s returned for nonexistent policies
- [ ] Unit tests pass: `pytest open-webui/backend/tests/test_policies.py -v`
- [ ] Integration tests pass with mocked MADE
- [ ] Manual curl tests verify all error scenarios
- [ ] tsc --noEmit clean (if TypeScript touched)

---

## Deliverables

**After coder completes C1:**
1. All 7 endpoints implemented + tested
2. Admin-only access control enforced
3. Rollback logic verified (mock MADE)
4. Full test suite (unit + integration)
5. Brief implementation notes if deviations from spec

**Next phases:**
- **C2:** Frontend (Markdown editor, Rego preview, review UI in SvelteKit)
- **C3:** MADE sync enhancements (version history, audit logs, manual rollback)

---

## Assumptions & Risks

**Assumptions:**
- MADE's policy deployment endpoint exists and is reachable at `POST /api/policies/deploy` (verify before coding)
- Our Node backend has `/api/compile-policy` ready (will implement in parallel)
- Open WebUI's auth middleware can be reused for admin check
- Migrations follow Open WebUI's pattern (Alembic or SQLAlchemy)

**Risks:**
- MADE endpoint interface differs from spec → adjust spec + code
- LLM compile produces invalid Rego → add Rego validator before deploy
- MADE deployment is async (takes time) → spec assumes sync, may need revision
- High volume of policy deploys → MADE rate limiting (defer to C3 if issues arise)

---

## Model Selection

- **Implementation:** Haiku (focused coding, faster iteration)
- **Testing:** Haiku (unit + integration tests, straightforward)
- **Review:** Sonnet (task review + any re-review)

---

**Ready for coder implementation. Spec + Plan complete.**
