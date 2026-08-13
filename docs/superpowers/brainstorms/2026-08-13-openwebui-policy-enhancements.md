# Brainstorm: Sub-project C3 (Policy Enhancements — Audit, Versioning, Rollback, Tests)

**Date:** 2026-08-13  
**Scope:** Backend + frontend enhancements after C2 ships  
**Depends on:** C1 backend (shipped) + C2 frontend (WIP)

---

## Problem Statement

C1 shipped basic deploy workflow, C2 adds UI. But several governance + reliability features are missing:

1. **No audit trail:** Admin deploys policy, forgets who did it or when
2. **No version history:** Can't see what changed between versions
3. **Manual rollback incomplete:** Endpoint stubbed (501), UI doesn't expose it
4. **MADE 503 untested:** "OPA missing" error scenario verified live but no automated test
5. **No diff view:** Can't see what changed before approving deploy

**Goal:** Ship these enhancements to make policy governance audit-worthy + reliable.

---

## Four Independent Sub-Features

(Each can be scoped/prioritized separately)

### C3-A: Audit Logging

**What:** Log every policy action (create/update/compile/deploy/rollback/delete) with user + timestamp + old→new state.

**Implementation approaches:**

**Approach A1: Minimal (just MADE deploy)** — Log only deploy events to MADE
- New table: `policy_deploys` (policy_id, deployed_by, deployed_at, rego_content, made_response)
- Log on every `POST /api/v1/policies/:id/deploy` (success or failure)
- No UI yet, just data for later analysis

**Approach A2: Full audit trail** — Log all policy mutations (create/update/delete/compile too)
- New table: `policy_audit_log` (policy_id, action: create|update|compile|deploy|rollback|delete, user_id, timestamp, changes: {before, after}, made_response)
- Denormalize policy changes into log (Markdown diff, status changes)
- Optional UI: show audit trail in admin view (list of who did what when)

**Approaches trade off:**
- A1 is minimal (only deploy logged), A2 is comprehensive (all actions)
- A1 faster to ship, A2 better governance

**Recommendation:** **A2 (Full audit trail)** — if we're doing governance, audit trail is table stakes. Storage cost minimal (SQLite, policies are small). Ship A2.

---

### C3-B: Policy Versioning

**What:** Keep history of all deployed versions, enable viewing/comparing.

**Implementation approaches:**

**Approach B1: Version snapshots (separate table)**
- New table: `policy_versions` (id, policy_id, version_number, rego_content, status: current|superseded, deployed_by, deployed_at)
- On each successful deploy:
  1. Mark previous `policy_versions` rows with status=superseded
  2. Create new row with version_number++ and status=current
- Optional UI: sidebar showing "v1, v2, v3, ..." with click-to-view
- Allows seeing what was deployed at what time

**Approach B2: Immutable changelog (append-only)**
- Don't version the Policy model itself, keep only latest Markdown in policies table
- `policy_versions` table: only record successful deploys (immutable log)
- Less state management (policy table simpler), versions are read-only

**Approaches trade off:**
- B1 tracks all states (drafts + deployed), B2 only tracks deployed
- B1 more complex, B2 simpler and sufficient for audit

**Recommendation:** **B2 (Immutable changelog)** — simpler, sufficient. Policy table stays clean (only latest draft), versions table records deploy history.

---

### C3-C: Manual Rollback UI + Completion

**What:** Implement the stubbed rollback endpoint + add UI button in C2 frontend.

**Current state:** C1 has `POST /api/v1/policies/:id/rollback` stub (returns 501).

**Implementation:**

**Backend (complete endpoint):**
- Preconditions: policy must be `active`, `previous_rego` must exist
- Process:
  1. Call MADE: `POST /api/policies/deploy` with `previous_rego`
  2. On success:
     - Swap: `active_rego ↔ previous_rego` (so next rollback restores current)
     - Set `status = draft` (previous version is now editable)
     - Log to audit trail
     - Return 200 + "Rolled back to previous version"
  3. On failure: return 400 + MADE error
- Endpoint becomes fully functional (not 501)

**Frontend (C2 enhancement):**
- Show "Rollback" button only when:
  - Status is `active` AND
  - `previous_rego` exists (backend confirms via GET)
- On click:
  - Confirm dialog: "Rollback to previous version? Current will be editable again."
  - POST to `/rollback`
  - On success: status badge changes active→draft, editor unlocked
  - On error: show MADE error message

**Scope:** Low complexity, high value (incident response feature).

---

### C3-D: MADE 503 Test Coverage

**What:** Automate the "MADE missing OPA" error scenario (currently verified live, not tested).

**Current state (C1):** Test mocks MADE success/error, but not the 503 scenario (deploy fails because MADE's OPA is missing/down).

**Implementation:**

**Backend test:**
- New test: `test_deploy_made_503_no_rollback` in `test_policies_integration.py`
- Mock MADE response: 503 Service Unavailable (or 500 Internal Server Error)
- Verify:
  1. Our endpoint returns 502 (MADE unreachable)
  2. No rollback attempted (policy status unchanged)
  3. No error call to MADE happens (idempotent, no retry logic)
  4. last_error saved with 503 message

**Scope:** Quick to add (one test function, 20 lines).

---

## Prioritization Matrix

| Feature | Value | Effort | Risk | Priority |
|---------|-------|--------|------|----------|
| **A2: Audit log** | High (governance) | Medium | Low | 🔴 P1 |
| **B2: Version snapshots** | High (incident recovery) | Medium | Low | 🔴 P1 |
| **C: Manual rollback** | High (incident response) | Low | Low | 🟠 P2 |
| **D: 503 test** | Medium (coverage) | Low | Low | 🟡 P3 |

**Recommendation order:**
1. **Phase 1:** A2 (audit) + B2 (versioning) — ship together, they're related (audit logs trigger version snapshots)
2. **Phase 2:** C (rollback UI) — depends on A2/B2 done (need audit trail for audit trail visible to user)
3. **Phase 3:** D (503 test) — nice-to-have, can ship anytime after

---

## Four Approaches for C3 Overall

### Approach 1: "Ship All at Once" — A2 + B2 + C + D in one big PR

**Pros:** Single review, coherent feature set
**Cons:** Large diff, higher risk, longer review cycle, blocks if any piece breaks

### Approach 2: "Two Phases" — (A2+B2+C) then (D) — split by value

**Pros:** Audit + versioning + rollback ship together, 503 test separate, smaller diffs
**Cons:** Still large first PR

### Approach 3: "Four Independent Tasks" — A2, B2, C, D as separate specs/plans/PRs

**Pros:** Minimal diff per task, fast review, easy to ship incrementally, clear ownership
**Cons:** Four separate code reviews, potential merge conflicts if all WIP

### Approach 4: "Defer to C4/C5" — Ship only A2+B2 in C3, defer C+D

**Pros:** Smallest C3 scope, fastest ship
**Cons:** Leaves rollback incomplete, 503 test still missing

---

## Recommendation

**Go with Approach 3: Four Independent Tasks**

**Why:**
- Each sub-feature is self-contained (audit log, versioning, rollback, test)
- Smaller diffs = faster review = lower risk
- Can parallelize if multiple coders, or ship sequentially if one coder
- Defer doesn't feel right (rollback is important for incident response)

**Order:**
1. **C3-A:** Audit logging (foundation, other features build on it)
2. **C3-B:** Version snapshots (pairs naturally with audit logging)
3. **C3-C:** Manual rollback (depends on A done, but can start spec/plan in parallel)
4. **C3-D:** 503 test (can ship standalone anytime)

---

## Estimated Effort (per sub-feature)

| Feature | Backend | Frontend | Testing | Total |
|---------|---------|----------|---------|-------|
| **A2: Audit** | 1-2 days | 0.5 day (optional UI) | 0.5 day | ~2 days |
| **B2: Versioning** | 1 day | 0.5 day (sidebar) | 0.5 day | ~2 days |
| **C: Rollback** | 0.5 day | 0.5 day (button) | 0.5 day | ~1.5 days |
| **D: 503 test** | 0.5 day | - | 0.25 day | ~0.75 day |
| **TOTAL** | 3.5 days | 1.5 days | 1.5 days | ~6.5 days |

(Estimate assumes one coder; parallel would be faster)

---

## Design Decisions for C3

**Audit Log Storage:**
- Table: `policy_audit_log` (see A2 spec for schema)
- Store full `before`/`after` state (denormalized), not just diffs
- Include MADE responses (for debugging failed deploys)
- Retention: keep all (no cleanup), SQLite is small enough

**Version Immutability:**
- Once deployed, a version never changes (append-only changelog)
- Prevents accidental data loss (can always look back at what was deployed)
- Enables deterministic replay (audit trail + versions = reproducible state)

**Rollback Behavior:**
- Rollback swaps active/previous (not restore to arbitrary version)
- Simpler logic, matches C1's auto-rollback semantics
- If need fine-grained version restore, defer to C4

**MADE 503 Handling:**
- We return 502 (bad gateway), not 500 (internal error)
- Semantically correct: MADE is external service, its fault
- No retry logic (admin must retry manually)
- Match existing C1 behavior (already implemented, just missing test)

---

## Next: Spec + Plan for C3-A, C3-B, C3-C

After brainstorm approval, write:
1. **Spec for C3-A (Audit Logging)** — table schema, log on every action, optional UI
2. **Spec for C3-B (Versioning)** — immutable changelog, version sidebar UI
3. **Spec for C3-C (Rollback completion)** — endpoint completion, button UI, pre-conditions
4. **Individual plans** for each

C3-D (503 test) is so small, can be included in C3-A spec (just one test function).

Ship as separate PRs (or one combined PR if small enough after specs/plans).
