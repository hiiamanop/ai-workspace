# Implementation Report — C2 Policy Frontend (SvelteKit UI)

**Fix wave (final review, 2026-08-13):** applied L1–L5 from `final-review.md` in commit `265b586` — L1 limit param on `fetchPolicies` (+ test), L2 `onDestroy` flush of pending edits, L3 `resetPolicyStatuses()` on mount, L4 list ConfirmDialog `on:cancel`, L5 id-guarded `currentPolicy` writes. Vitest 27/27, build exit 0, svelte-check unchanged at baseline 8323.

## Summary

Admin-facing policy authoring UI for Open WebUI: list view (`/workspace/policies`), split-pane editor (`/workspace/policies/[id]`) with live compile + autosave + deploy/rollback/delete, and a new-policy page (`/workspace/policies/new`), all backed by C1's `/api/v1/policies*` endpoints. Admin-only "Policies" tab added to the workspace nav. 24 new unit tests (26 total suite) pass; production vite build passes; zero new svelte-check errors.

## Commits (branch `openwebui-policy-frontend`)

- `08467be` feat(open-webui): add policy authoring API client, helpers, and stores
- `d8ae37f` feat(open-webui): add policy workspace routes (list, editor, new)
- `3e802c4` feat(open-webui): add admin-only Policies tab to workspace nav
- `705473f` docs: note policy authoring UI (C2) in repo CLAUDE.md
- `e08ba6d` fix(open-webui): keep editor visible during post-deploy refetch

## Files

- `open-webui/src/lib/apis/policies/index.ts` — API client + types + ApiError (status 0 = network failure; parsed `{error, details?}` bodies, incl. deploy-400 `{message, rolled_back}` reachable via `err.body`)
- `open-webui/src/lib/utils/policies.ts` — `filterPolicies`, `formatEpochNs[Time]`, `debounce` (pure, node-testable)
- `open-webui/src/lib/stores/policies.ts` — plan-mandated status stores
- `open-webui/src/routes/(app)/workspace/policies/{+page.svelte, new/+page.svelte, [id]/+page.svelte}`
- `open-webui/src/lib/stores/index.ts` + `(app)/workspace/+layout.svelte` — Policies nav tab + count + non-admin guard
- Tests: `src/lib/apis/policies/index.test.ts` (13), `src/lib/utils/policies.test.ts` (11)
- Root `CLAUDE.md` — C2 notes paragraph

## Test Results

- `npm run test:frontend` (`npx vitest run`): **26 pass / 0 fail** (24 new + 2 pre-existing `shortcuts.test.ts`)
- `npm run check` (svelte-check): my files contribute **0 errors**. The vendored open-webui's check is red on pristine master too: baseline 8324 errors (files I never touched — auth/+page.svelte, katex-extension.ts, etc.). 8324 with my changes = identical. So "check must pass" is not achievable on this vendored tree; I verified zero delta instead.
- `npm run build` (vite prod): **exit 0**, policy routes present in built chunks (`build/_app/immutable/nodes/4{3,4,5}.*`)
- E2E: see below

## E2E verification

The running docker stack turned out to be pre-C1 images (app lacked `/api/compile-policy` → 404; made lacked `/api/policies/deploy` → 404), so a live E2E against the C1 backend required rebuilding. Built `app`, `made`, and `open-webui` images from this worktree (all three include C1; open-webui includes C2) and ran an isolated stack on ports 3002/8002/3011 with a fresh data volume (admin created via first signup), on a dedicated network. **Result: 13/13 checks passed** — signin; list `{policies,total}` shape; unauthenticated 401; create 201 with epoch-ns `created_at`; duplicate 409; get; compile 200 with `package made.hard` prefix; deploy 200 → `status: active` (real MADE + real `opa check`); update-active 400; deploy-active 400; rollback 200 → `status: draft`; delete 204; get-deleted 404; SPA route `/workspace/policies` serves 200.

**One caveat:** the `.env` `DEEPSEEK_API_KEY` is invalid (DeepSeek returns 401 `Authentication Fails`), so the live-LLM compile leg can't run against the real provider. The chain open-webui → app → provider was verified up to the provider (the 401 is DeepSeek's own response, proving the plumbing), and the compile leg was then exercised end-to-end through a local stub compiler (returns a canned `package made.hard` deny-rule Rego for markdown containing "top-secret", mimicking the node backend's `{rego, warnings}` contract). Save→compile→deploy→rollback all then ran against real MADE + real OPA. The LLM→Rego conversion itself is C1's concern and is covered by C1's unit tests (mocked `complete` deps).

**E2E finding for C1/C3 (out of C2 scope):** `DELETE /api/v1/policies/:id` removes only the Open WebUI DB row — a policy's deployed `.rego` file stays in MADE's `policies/hard/` and keeps governing `/decide` calls after delete. Rollback-without-previous_rego deliberately keeps MADE's file running ("MADE keeps running the current Rego", per the C1 comment), so only the delete path leaves an orphaned active policy that no longer appears anywhere in the UI. Backend fix candidate for C3 (delete → also remove the MADE file, or at least warn).

Note: the machine crashed at 100% disk during an earlier build attempt (coordinator recovered it; build caches were pruned). All subsequent builds were disk-watched (`df` before/after; peak ~6% used).

## Deviations from Plan

1. **Route prefix** (mandated): all routes live under `workspace/policies`, navigation uses `/workspace/policies...` consistently (plan text said `/policies/:id` in places).
2. **"First compile" is the create call** (mandated): `new/+page.svelte` POSTs create `{id: crypto.randomUUID(), name, markdown_content}` then redirects to the real editor route; the editor's live compile handles the first compile. Deploy is disabled until `compiled_rego` exists (mirrors backend's "Compile first" 400).
3. **Save-before-compile** (discovered, not in plan): C1's compile endpoint compiles the policy's **saved** markdown (no request body), so the 500ms compile debounce runs save→compile. A failed save skips compile (avoids a preview that doesn't match the textarea). Autosave on blur (1000ms) and Ctrl+S/Cmd+S still exist per spec.
4. **Rollback shown whenever active** (not only when `previous_rego` exists): C1 deliberately relaxed the previous_rego precondition (first-deploy rollback takes the policy offline); the plan's Step 10 visibility rule would hide a working action.
5. **Policy rename not supported**: C1's PUT accepts only `markdown_content`, so the editor shows the name as read-only text instead of the plan's editable input (would be local-only and silently lost).
6. **No /403 page exists** in this Open WebUI; non-admins are redirected to `/` early (matching the workspace layout's own guard) and a 403 from the backend shows an inline banner.
7. **Error-retry handling**: 500s show a banner + Retry button; network failures in the *list* view auto-retry every 5s; the *editor* keeps the current view on refetch failure (auto-reloading could clobber typed content) and surfaces the failure via the deploy/rollback banners.
8. **Status enum**: plan's per-action status strings ('compiling'/'deploying'/'rolling') collapsed into `'idle'|'working'|'success'|'error'`.
9. **Tablet 40/60 split** dropped: side-by-side is 50/50 from md (768px) up, stacks below (spec's 40/60 vs 50/50 nuance wasn't worth the CSS).
10. **Rego syntax highlighting skipped** (spec marked it optional; plan said plain `<pre>` acceptable).
11. **Component-test infra not added**: open-webui has vitest (node env) but no @testing-library/svelte/jsdom. Per instruction not to add heavy new test infra, logic was extracted into testable pure modules; rendering behavior is covered by E2E/manual only.
12. **i18n**: pages use plain English strings (new i18n keys weren't parsed); matches the admin-utility nature of these pages.

## Known issues / deferred

- The main repo stack (as brought up by the coordinator) runs stale pre-C1 images for app/made/open-webui — C1+deploy functionality is only in the newly built images. Not a code issue, but anyone testing needs `docker compose build app made open-webui`.
- `workspaceActions` "New Policy" button registers only while the list page is mounted (layout clears actions on route change) — matches how the nav's split-create works for other sections.
- Deploy while a compile is in flight: the compile response may land after the deploy refetch (compiled_rego is the same either way; cosmetic only).
- Rename, version history, diff, audit trail remain backend/C3 concerns.

## Next steps for researcher

- Review the save-before-compile flow (deviation 3) — it's the biggest behavioral interpretation.
- E2E: 13/13 passed (see above); the compile leg used a stub compiler because the `.env` DeepSeek key is invalid (401) — flag to the user that the key needs rotating.
- Watch the `e08ba6d` refetch guard when reviewing deploy/rollback error paths.
- The orphaned-MADE-policy-on-delete finding above is a C1/C3 backend candidate, not a C2 bug.
