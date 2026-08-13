# Implementation Report — C3 Policy Enhancements (Audit, Versioning, Rollback, Tests)

## Summary

All 4 sub-features shipped on `open-webui/backend/` only (C2's `open-webui/src/` untouched):
- **C3-A Audit logging**: `policy_audit_log` table (migration `c0dec2de0001`), `PolicyAuditLog` model + never-raising `log_policy_action()` helper, wired into all 6 mutation endpoints, plus `GET /{id}/audit` reader (included — a trail without a reader is dead weight).
- **C3-B Versioning**: `policy_versions` table (`c0dec2de0002`) + `policy.current_version_id` (`c0dec2de0003`), `PolicyVersion` model with max+1 numbering in one transaction, version row created only on successful deploy, plus `GET /{id}/versions` reader (included, same rationale).
- **C3-C Rollback**: already fully implemented in C1 — verified against spec FR-C1 and left intact. Added the missing integration tests (full deploy→deploy→rollback workflow; first-version/no-previous and only-active cases were already covered by C1's `test_rollback_first_version_keeps_made_untouched` / `test_rollback_not_active_400`). The C2 editor's rollback button is the C2 worktree's deliverable (excluded per scope).
- **C3-D 503 coverage**: `test_deploy_made_503_unreachable_no_rollback` added to the integration suite — and it surfaced a real gap (see deviations): C1 only mapped network-level errors to 502; an HTTP 503 *response* from MADE was treated as a rejection and triggered a rollback attempt. Fixed in `made_deploy` + `last_error` signal on the 502 path.

**Test results: 50 passed, 0 failed** (baseline was 32; 18 new). `git status --porcelain` clean after runs.

## Commits (branch `openwebui-policy-enhancements`)

- `599c866` feat(open-webui): add C3-A audit and C3-B versioning schema (3 migrations)
- `28de1f8` feat(open-webui): add policy audit-log and version models (C3-A/C3-B)
- `648d11b` feat(open-webui): wire audit logging, versioning, and reader endpoints into policy router
- `eace41c` test(open-webui): C3-A audit, C3-B versioning, C3-C rollback workflow, C3-D 503 coverage

Branch head: `eace41c` (pushed to origin).

## Test Results

```
pytest tests/ -q --import-mode=importlib   (WEBUI_SECRET_KEY=test VECTOR_DB=none, /tmp/owui-venv)
50 passed, 3 warnings in 4.99s
```
(3 warnings are pre-existing: sqlalchemy declarative_base deprecation + alembic path_separator.)

Migration verification (not just tests):
- Scratch DB via the exact production startup path (`import open_webui.config` → alembic upgrade head): single head `c0dec2de0003`, both tables, `policy.current_version_id INTEGER`, all indexes/unique constraint present.
- Same path exercised again during a real uvicorn boot attempt (`open_webui.main:app`): migrations applied to the boot DB before the app failed on the venv's missing vector backend (chromadb not installed in `/tmp/owui-venv` — the full app can't boot with `VECTOR_DB=none`; unrelated to this change, the Docker image has a vector backend).

## What was NOT verified live

- No Docker rebuild / live HTTP E2E: the compose stack is currently down (no containers running), and bringing it up means building the 6.5 GB open-webui image plus searxng/scrapling/made. The only thing a live run would add beyond what's verified is the container boot + HTTP round trip; the migration-apply-on-startup path it would exercise was already run against two fresh DBs via the same code path. Deferred: `docker compose build open-webui && docker compose up -d open-webui` from the main repo root, then check logs for `c0dec2de0003` on the existing `open-webui-data` volume.

## Deviations from Plan

1. **Stale-plan corrections (C3-C)**: rollback already implemented in C1 (no 501 to replace). Kept C1's relaxed first-version behavior (rollback with no `previous_rego` takes the policy offline with 200 instead of the plan's 400) — the E2E and the spec's own rollback flow depend on it. Documented in `routers/policies.py` (existing ponytail comment) and this report.
2. **C3-D was NOT test-only — one real bug fixed** (2 hunks, ~6 lines):
   - `made_deploy` treated any non-200 as a rejection; a MADE 503 response therefore went down the rollback path (second MADE call, 400, "rolled_back"), exactly the risky behavior FR-D1 forbids. Now any 5xx status maps to `('unreachable', None)` → our 502 with no rollback attempt. 4xx behavior unchanged (existing tests confirm).
   - The 502 path now writes `last_error='MADE unreachable'` (previously the policy was left fully untouched). FR-D1's own assertion ("last_error contains 'MADE unreachable'") requires it; the error is now visible on `GET /policies`.
3. **Plan's `utils/audit.py` helper location is taken** — `open_webui/utils/audit.py` is Open WebUI's upstream ASGI audit middleware (loguru-based). To avoid clobbering it, `log_policy_action` lives in `models/policy_audit_log.py` next to the table, matching C1's `PolicyTable` service-class pattern.
4. **Timestamps are BigInteger epoch-ns**, not SQL `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` as in the plan's SQL sketch — task instruction to match C1 conventions, and consistent with the `policy` table.
5. **`current_version_id` has no FK constraint** — SQLite's `ALTER TABLE ADD COLUMN` cannot add FKs, and C1's table set no FK precedent (spec's FK is physically impossible on SQLite; documented in migration + model comments).
6. **Audit reader deliberately has no policy-exists check** — the trail must stay readable after deletion (that's the point of a governance trail; `GET /{id}/audit` on a deleted policy returns its entries, `GET /{id}/versions` still 404s).
7. Plan's rollback unit-test names (`rollback_swaps_rego`, `rollback_only_active`, `rollback_no_previous`) map to existing C1 tests (`test_rollback_restores_previous_version`, `test_rollback_not_active_400`, `test_rollback_first_version_keeps_made_untouched`) — not duplicated; the genuinely missing full-workflow test was added.

## Known Issues / Gotchas for Reviewer

- **Version-row atomicity is two commits**: deploy success commits `update_deploy_state` first, then `create_version` (version row + `current_version_id` in one commit). If the second commit fails, the policy is active with no version row — benign and self-healing (next deploy recomputes max+1 from scratch). Marked ponytail in code; a single-transaction version would require merging the two methods.
- **Audit never raises**: `log_policy_action` swallows DB errors (logs them). Audit loss is possible under DB failure, by design — the operation must not fail because of its audit trail. Tests verify entries exist, so logic bugs still fail tests.
- **Audit/version readers are admin-only** (consistent with every policy route; added to the 403 sweep test).
- **The 503→502 behavior change also affects rollback**: a MADE 503 during rollback now returns 502 "policy stays active" (was 400 "MADE rejected rollback") — consistent with FR-C1's unreachable handling, no test regressions.
- C2's rollback button (`open-webui/src/routes/workspace/policies/[id]/+page.svelte`) remains C2's deliverable; API contract it needs: `POST /{id}/rollback` → 200 `{status: draft, message}`; 400 `{error}`; 502 `{error: "MADE unreachable", details}`. First-version rollback returns 200 with a "MADE keeps running the current Rego" message — the UI should not present that as a MADE rollback.

## Next Steps for Researcher

- Watch the two deliberately-chosen semantics: (a) 5xx→unreachable mapping, (b) audit endpoint surviving policy deletion.
- If live E2E is wanted before merge: rebuild open-webui per above and confirm migrations on the real volume.
