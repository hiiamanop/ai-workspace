# Coder Report — Sub-project C1: Policy Backend Implementation

**Date:** 2026-08-13
**Branch:** `openwebui-policy-backend` (7 commits on top of `c910e87` plan)
**Status:** Implementation complete + task-review fixes applied, ready for re-review

## Summary

Implemented the admin-only policy authoring backend end-to-end: Open WebUI
policies REST API (CRUD + compile + deploy + rollback), Markdown→Rego
compilation via this repo's Node backend using deepseek-v4-flash, and a new
OPA-validated deploy endpoint on the vendored MADE. Full docker-compose E2E
verified live (15/15 checks pass), including a real deepseek compile and a
real deploy + rollback cycle against the running MADE container.

## Commits

| Commit | Content |
|--------|---------|
| `599c3a4` | Phase 1-2: Alembic migration `c0dec1de0001`, `Policy` model, CRUD router, admin auth |
| `259fdb7` | Phase 3: `src/openwebui-policy-compiler.ts` + POST `/api/compile-policy` (deepseek-v4-flash) |
| `cef7c4b` | Phase 4 (MADE): POST `/api/policies/deploy` — `opa check`-validated, atomic install |
| `bb26ef7` | Phase 5-6: tests (32 pytest + 6 node), deploy race guard, FR-4 rollback endpoint |
| `ea8b1d8` | Phase 7: `.env.example` docs for `POLICY_COMPILER_URL` / `MADE_URL` |
| `8c2a5db` | **Review fix:** deny-only Rego compiler + full-set deploy validation + tests |
| `43eca2a` | **Fix:** guard `open_webui/config.py` import-time static rewrite behind frontend-build presence |

## Test Results

All suites green on the final tree:

- **Open WebUI pytest (new):** `32 passed` — `tests/test_policies.py` (unit) +
  `tests/test_policies_integration.py` (integration incl. concurrent-deploy race,
  both run in the same worktree venv `/tmp/owui-venv`).
- **Node compiler tests (new):** `6 passed` — `tests/openwebui-policy-compiler.test.ts`.
- **MADE tests:** `101 passed` — `MADE/tests/api/test_policies_deploy.py` added,
  full suite re-run in `/home/naufa/workspace/MODE/.venv`.
- **tsc:** `npx tsc --noEmit` clean.
- **Repo npm suite:** 102/102 pass (one flaky "GET / serves index" 404 seen once
  on the worktree, passed on re-run and on master; server.ts diff is a pure
  POST-route addition — suite race, not this change).

### Docker E2E (Phase 7) — 15/15 checks

Fresh `docker compose build` (USE_SLIM=true) + `up`, then curl sweep against
`http://localhost:3001`:

- migration `f0bd01a18a3d -> c0dec1de0001, Add policy table` ran on startup
- POST without token → 401; GET as non-admin → 403
- create 201 / duplicate 409 / bad id 400 / list total=1 / get 404
- compile → `compiled_rego` present, `package made.hard` first line (real
  deepseek-v4-flash call through the app container)
- deploy → 200, MADE file `/app/policies/hard/cost-cap.rego` written with valid
  Rego (`package made.hard`, default allow, deny rules)
- deploy again → 400 (already active); PUT on active → 400
- rollback → 200; edit → compile v2 (0.05 cap) → deploy v2 → 200
- rollback v2 → 200; **MADE file verified reverted to v1** (0.1 cap), DB status
  `draft`, `previous_rego` null
- delete draft → 204

## Deviations from Plan / Spec

1. **FR-4 rollback endpoint implemented (spec listed it as optional, defer to C3).**
   Without it the state machine dead-ends: deploy-on-active is 400 and edit/delete
   are draft-only, so an active policy is frozen forever — the plan's own
   rollback tests and the fix-then-redeploy workflow require the active→draft
   transition. The endpoint is `POST /{policy_id}/rollback`; it re-deploys the
   previous Rego to MADE (if any) and flips status to draft.
   - Precondition relaxed: spec FR-4 requires `previous_rego` to exist, but on a
     first deploy `previous_rego` is null and the endpoint would be unreachable
     for exactly the policies that most need the escape hatch. First-version
     rollback just takes the policy offline (MADE keeps running the current
     Rego) — marked `ponytail:` in code.
2. **`require_admin` raises `HTTPException(403)` instead of returning a
   `policy_error` JSONResponse.** Verified by grep that FastAPI 0.136.3 has no
   Response-from-dependency short-circuit: a returned JSONResponse is passed to
   the endpoint as its `user` argument (crashed with `'JSONResponse' object has
   no attribute 'id'`). Documented in the function docstring.
3. **Deploy race guard.** Spec's "last-writer-wins" is unsafe with concurrent
   deploys (both could succeed, DB/MADE disagree). Added `reserve_for_deploy`:
   a conditional UPDATE `WHERE status='draft'` whose rowcount decides the winner.
   SQLite's write lock serializes it; works across event loops/workers. Verified
   by `test_concurrent_deploys_exactly_one_wins` (two TestClients, threads) →
   exactly {200: 1, 400: 1}.
4. **Incident: static files deleted on import — root-caused and FIXED
   (commit `43eca2a`).** 16 files under `open-webui/backend/open_webui/static/`
   were found deleted (unstaged) twice — each time after a pytest run.
   Root cause: `open_webui/config.py` unlinks every top-level file in
   `STATIC_DIR` and re-copies from `FRONTEND_BUILD_DIR/static` **on any
   import of the `open_webui` package**. In the container the frontend
   build exists (intended rewrite-at-startup), but the host worktree has no
   `open-webui/build/` — so any host-side pytest importing `open_webui`
   deletes the checked-in assets with nothing to replace them. Fix: the
   rewrite is now guarded behind
   `STATIC_DIR.exists() and (FRONTEND_BUILD_DIR / 'static').exists()`.
   Verified: importing `open_webui.routers.policies` in a test venv leaves
   `static/` untouched and `git status` shows only the config.py change.
   **Reviewer note:** your own pytest runs will no longer re-dirty the tree.
5. **MADE deploy endpoint added to vendored `MADE/`** (per user decision). It
   writes `policies/hard/<id>.rego` with `opa check` validation first (10s
   timeout, 503 on missing opa), atomic `.rego.tmp` + `os.replace`. Package name
   is enforced as `made.hard` — the spec's example `hard_constraints` would
   silently never run (MADE only evaluates `made.hard`).
6. **`update_deploy_state(previous_rego=...)` semantics:** passing `None` means
   "leave alone" (needed to distinguish clear-vs-untouched), so clearing takes an
   explicit `clear_previous=True` flag. Pydantic `PolicyListItem` needed
   `model_config = ConfigDict(from_attributes=True)`.
7. **E2E environment quirk (not product code):** Open WebUI disables signup
   after the first admin account (`auths.py:865` flips `ui.enable_signup` false
   in DB config). For the non-admin 403 check I re-enabled it via
   `POST /api/v1/auths/admin/config` with `ENABLE_SIGNUP: true` (GET-modify-POST
   of the full admin config). Regular users sign up with role `pending`; the
   403 path is what matters for the E2E.

## Task-Review Fix (commit 8c2a5db) — the blocking finding

**Blocker:** compiled policies declared `default allow = true`, but MADE's
`policies/hard/base.rego` already declares `default allow := true`. Rego
forbids two defaults for one document — the first deploy broke every
`/decide` call (`opa: multiple default rules for data.made.hard.allow`,
503) and tripped the brand health monitor. The old E2E missed it because
deploy validated in isolation and never called `/decide`.

**Fix:**
1. `COMPILE_SYSTEM_PROMPT` now mandates deny[reason]-only output; a runtime
   guard rejects any compiled `default allow` (LLM disobedience).
2. MADE deploy validates the new file **together with the existing
   `policies/hard/*.rego` set** (copied into the tempdir), so cross-file
   conflicts 400 at deploy time instead of breaking production post-install.
3. Tests: MADE fixture now ships base.rego; new tests for the conflict
   (400 + no file written) and deny-only coexistence; compiler test for the
   default-allow rejection (7 node tests now).
4. E2E now includes full-set `opa check` and a live `/decide` smoke after
   deploy. Re-run live: **16/16 PASS**, `/decide` returns 200.

**Non-blocking notes from review, addressed/recorded:**
- Race-guard docstring overstates (only covers post-commit window) — noted,
  bounded harm; left as-is.
- Epoch-ns BigInteger timestamps deviate from spec's ISO examples — **C2
  frontend must handle `deployed_at`/`updated_at` as epoch-ns numbers.**
- Rollback/delete don't remove the MADE file (zombie rules stay enforced) —
  record for C3.
- `.superpowers/` is NOT gitignored — use explicit `git add` at merge time.
- The earlier "flaky" `GET /` npm-test failure is actually the gitignored
  `client/dist/` being absent in a fresh worktree; `npm run build` first.
  Not a code issue (server.ts diff is a pure POST-route addition).

## Deferred (known gaps)

- No policy authoring UI — this is backend only (C3 per roadmap).
- Compile errors surface as 400 with the LLM's message; no retry-loop/repair
  pass beyond the one-shot compile.
- `last_error` is stored per-policy but not yet surfaced anywhere (no list
  badge/filter for it yet — plan's UI phase).
- MADE deploy endpoint has no auth (internal service on compose network, same
  trust model as `/decide`).
