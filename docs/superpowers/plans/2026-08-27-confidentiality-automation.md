# Plan — Confidentiality pipeline, made automatic

PRD: [[docs/PRD-confidentiality-automation.md]].
Design: [[docs/superpowers/specs/2026-08-27-confidentiality-automation-design.md]].
Obsidian: [[Projects/ai-workspace/2026-08-27-confidentiality-automation]].

**Status: all phases shipped 2026-08-27 (B1 → A → C → B2 → E → D).** Not yet
committed. Remaining before merge: `cd open-webui && npm i && npm run check`
+ live admin click-through of the Redaction tab; one `docker compose up
--build` end-to-end smoke.

Execution order: **B1 → A → C → B2 → E → D**. Each phase merges on its own;
`npm test`, `pytest` in `MADE/`, and `opa test MADE/policies/hard/` stay
green after every phase.

---

## Phase B1 — Indonesian regex detectors  (S)  ✅ shipped 2026-08-27

- [x] `detectors.py`: `_keyword_precedes(text, start, words, window=24)` — **left-only** (a keyword *after* the number is the next field's label: "NIK 327… NPWP 09…").
- [x] `NPWP`: `NPWP_DOTTED_RE` (unconditional) + `NPWP_BARE_RE` 15–16 digits gated on a preceding `npwp` keyword.
- [x] `KK`: `KK_RE` 16 digits gated on a preceding `kartu keluarga`/`no kk` keyword; else falls through to `ID_NUMBER`.
- [x] `ID_PLATE`: `ID_PLATE_RE` claimed only when the prefix ∈ `_ID_PLATE_PREFIXES` **or** a `plat`/`nopol` keyword precedes.
- [x] `PHONE`: existing `PHONE_RE` already matches `+62 …` and `08…` — verified by test, no change needed.
- [x] Wired into `detect()`: EMAIL → NPWP-dotted → CARD → KK → NPWP-bare → ID_NUMBER → ID_PLATE → PHONE.
- [x] `tests/core/privacy/test_detectors.py`: +7 tests (dotted NPWP, bare-NPWP keyword gate, NIK↔KK, plate via region code, plate via keyword, plate false-positive guard, ID mobile formats). **14/14 pass.**
- **Note:** full `pytest MADE/` not run here — this machine has no MADE venv (`cryptography`/`spacy` absent). `test_detectors.py` is regex-only and needs no deps; `detect_all`/pseudonymizer/NER untouched. Run the full suite in a MADE env before merge.

---

## Phase A — auto data-classification  (L)  ✅ shipped 2026-08-27

Decisions 1/2/3 confirmed by user; implemented as recommended.

- [x] **A.1** `detectors.py`: `SECRET_RES` (private-key header, AWS `AKIA`, JWT, `sk-/pk-/token_` keys, `password:`-style), claimed first in `detect()`. +tests.
- [x] **A.2** `MADE/core/privacy/lexicon.yaml` (confidential/public × en/id) + `lexicon.py` (`matches()`, compiled `\bphrase\b`, module-global).
- [x] **A.3** `classifier.py::classify()` — cache → `_heuristic()` (precedence table) → `llm_client.classify()` on inconclusive; `ClassifyResult{classification,confidence,source,signals}`. `llm_client.py` never raises (no-key/timeout/HTTP/unparseable → None → caller defaults `internal`@0.4).
- [x] `storage/models.py::ClassificationCache` (unique `(org_id, text_hash)` — stores sha256, never raw text).
- [x] **A.4** `schemas.py::PrivacyClassify{Request,Response}`; `api/main.py::POST /privacy/classify`.
- [x] **A.5** `restricted.rego` + `restricted_test.rego` (denies external vendors for `restricted` **even when redacted**). `privacy_test.rego` `test_allow_openai_for_us_restricted` → `test_no_eu_residency_deny_for_us_restricted` (premise invalidated by the new rule). `pseudonymizer.redact()`: `SECRET` → non-reversible `[SECRET_REDACTED]`, no mapping row.
- [x] **A.6** `confidential_redaction.py`: `inlet()` classifies combined user text, always redacts each user msg, sets `_privacy` whenever confidential/restricted (incl. `redacted:false`); classify-unreachable → redact-only degrade. `_classify()` + `_classify_cache`.
- [x] **A.8** `made_routing.py`: `BLOCKED_MESSAGE` constant; no-selection + `_privacy` sensitive → `raise` instead of `_cheapest_qualifying()` fallback; non-sensitive path unchanged.
- [x] `.env.example`: `MADE_CLASSIFIER_API_KEY|BASE_URL|MODEL|TIMEOUT` (all optional; `made` gets them via `env_file: .env`, no compose change).
- **Verification:** `pytest MADE/tests/{core/privacy,api/test_privacy}` 40/40; `opa test --v0-compatible policies/hard/` 25/25; `openwebui-filters` 28/28 (pinned `requirements.txt`). Full `pytest MADE/` 120 pass / 25 fail — all 25 are pre-existing `opa eval` failures (local OPA is v1, `opa_client.py` doesn't pass `--v0-compatible`; Docker pins v0.67.0). Live `docker compose` end-to-end smoke still TODO before merge.

---

## Phase C — wire `src/chat.ts`  (M)   [depends: A]  ✅ shipped 2026-08-27

- [x] `src/privacy-client.ts`: `classify`/`redact`/`restore` fetch wrappers (`fetchImpl` injectable), per-`(orgId,text)` `Map` caches, `BLOCKED_MESSAGE` (synced with `made_routing.py`), `CHAT_ORG_ID = "anonymous"` (chat page has no auth user).
- [x] `types.ts::TaskIn.redacted?: boolean` (additive, matches MADE schema).
- [x] `chat.ts`: `ChatDeps` gains `classify`/`redact`/`restore`; `handleChat()` classifies the latest user turn, redacts every user message when confidential/restricted, threads `data_classification`+`redacted` into all `decideRequest()` calls (incl. `ensureCandidateFits`'s `baseRequest`). classify failure → degrade to `internal`.
- [x] Blocked branch: no `selected_candidate_id` + sensitive → `throw BLOCKED_MESSAGE` (was generic "no eligible candidate"); same at the mid-loop exhausted-with-no-content path.
- [x] Response: `restoreReply()` on every return path; streaming — when `redacted`, `onDelta` is suppressed during generation and the restored full text is emitted as one delta (`ponytail:` — placeholders split across deltas).
- [x] `tests/chat.test.ts` +2 (confidential → decide carries `confidential`/`redacted:true`, provider sees redacted text, output restored; blocked branch). `tests/privacy-client.test.ts` +2 (cache hit, non-200 throws).
- **Verification:** `npm test` 130 pass / 1 fail — the 1 fail (`GET / serves the index page`, needs `npm run build`) **fails identically on clean `master`**. `npx tsc --noEmit` clean.

---

## Phase B2 — Indonesian NER  (M)  ✅ shipped 2026-08-27

- [x] Checkpoint: **`cahya/bert-base-indonesian-NER`** (labels PER/ORG/GPE/NOR, ~420 MB). Spot-checked live: "Budi Santoso" → PER 0.99, "PT Telkom Indonesia" → ORG 0.99, "Bandung" → GPE 1.0, "Kementerian Keuangan" → NOR 0.99. Override with `MADE_ID_NER_MODEL`. (Formal precision/recall on a labelled sample still worth doing before scaling up.)
- [x] `detectors.py`: `_get_id_nlp()` — lazy `transformers.pipeline(..., aggregation_strategy="simple")`, **fail-soft** (`_id_nlp_unavailable` flag → regex + EN-NER only, never crashes). Label map `PER/PERSON→PERSON, ORG/NOR→ORG, LOC/GPE→GPE`. Added to `warm_up_ner()`.
- [x] `detect_all()`: `_add_ner_spans()` helper runs regex → ID-NER → EN-NER, earlier wins on overlap. **Word-boundary guard** drops sub-token garbage spans (`"credential"` → `"tial"`) — a real bug the merge surfaced.
- [x] `Dockerfile`: `RUN python -c "...warm_up_ner()"` bakes the checkpoint into the image (offline at runtime via existing `HF_HUB_OFFLINE=1`).
- [x] `test_ner.py` +3 (mocked pipeline: ID person/org/city merged; regex NIK beats overlapping ID-NER span; unavailable-model is silent). `.env.example` note.
- **Verification:** `HF_HUB_OFFLINE=1 pytest MADE/tests/core/privacy tests/api/test_privacy` **40/40** with the real model loaded; full `pytest MADE/` 123 pass / 25 fail (same pre-existing `opa eval`); `opa test --v0-compatible` 25/25. End-to-end `detect_all` on a mixed ID paragraph redacts NIK + name + org + email + phone.

---

## Phase E — redaction-leak detection  (M)  ✅ shipped 2026-08-27

- [x] `storage/models.py`: `RedactionLeak` (`org_id` indexed, `entity_types` comma-joined, `span_count`, `context_hash`, `created_at`) — **hash only, never the text**.
- [x] `pseudonymizer.redact()`: `_check_for_leak()` re-runs regex-only `detect()` on the output; a surviving span → `RedactionLeak` row + (`MADE_REDACTION_LEAK_FAIL_CLOSED=1`) `raise RedactionLeakError`. Skipped on total-miss (`if not spans: return` early) — catches **partial** redactions, replacement artifacts, and post-detector-change re-redacts.
- [x] `restore()`: `MANGLED_PLACEHOLDER_RE` (known type name + loose spacing) — warn-logs any near-miss the model produced; `MADE_RESTORE_FUZZY=1` normalises `[Person 3]`→`[PERSON_3]` and recovers it. Default off. (Filter `outlet()` scan skipped — it delegates to `/privacy/restore`, MADE-side covers it. `ponytail:`)
- [x] `schemas.py::RedactionLeakOut`; `api/main.py::GET /privacy/leaks?org_id=&limit=&offset=` (newest first, capped 500).
- [x] `.env.example`: `MADE_REDACTION_LEAK_FAIL_CLOSED`, `MADE_RESTORE_FUZZY`.
- [x] `test_pseudonymizer.py` +4 (monkeypatched `detect_all` to skip the phone → leak row with `PHONE`; fail-closed raises; mangled placeholder logged; fuzzy recovers). `test_privacy.py` +1 (`GET /privacy/leaks` lists + org-scopes).
- **Verification:** `pytest core/privacy + api/test_privacy` **45/45**; full `pytest MADE/` 128 pass / 25 fail (same pre-existing `opa eval`); `opa test --v0-compatible` 25/25.

---

## Phase D — entity-mapping admin UI  (M)  ✅ shipped 2026-08-27

**Auth boundary corrected vs. the spec:** the real C2 pattern is an Open
WebUI *backend router* with `get_current_user` (not an ai-workspace Node
proxy). Followed that — `src/privacy-routes.ts` was never built.

### D.1 MADE endpoints
- [x] `pseudonymizer.py`: `list_mappings` / `update_mapping` (re-encrypt + rehash on value change, `MappingConflictError`→409, placeholder must match `PLACEHOLDER_RE`→400) / `delete_mapping`. `schemas.py::EntityMapping{Out,Update}`.
- [x] `api/main.py`: `GET /privacy/mappings`, `PATCH /privacy/mappings/{id}`, `DELETE /privacy/mappings/{id}` (204).
- [x] `tests/api/test_privacy.py` +3 (CRUD round-trip incl. corrected value flowing through `restore`; bad-placeholder 400 / collision 409 / 404; org-scoping).

### D.2 Open WebUI backend router
- [x] `open-webui/backend/open_webui/routers/privacy.py` — `require_admin` (403, mirrors `policies.py`), `httpx` forward to MADE, `org_id = user.id`. Routes: `GET/PATCH/DELETE /mappings*`, `GET /leaks`. 502 on MADE unreachable.
- [x] Registered in `main.py` (`include_router(privacy.router, prefix='/api/v1/privacy')`).

### D.3 Open WebUI tab
- [x] `src/lib/apis/privacy/index.ts` — client mirroring `apis/policies` (`ApiError`, request wrapper).
- [x] `src/routes/(app)/workspace/privacy-mappings/+page.svelte` — admin-only redirect; table (placeholder / type / original masked, click-to-reveal / created); inline edit (value + placeholder); delete-with-`ConfirmDialog`; "Redaction leaks" section from `/privacy/leaks`.
- [x] Nav tab ("Redaction") + `onMount` redirect guard in `(app)/workspace/+layout.svelte` (no count badge — skipped the `workspaceCounts` store plumbing).
- **Verification:** MADE side — `pytest tests/api/test_privacy.py tests/core/privacy` **48/48**; full `pytest MADE/` 131 pass / 25 fail (pre-existing `opa eval`); `opa test --v0-compatible` 25/25. **Open WebUI side NOT build-verified here** — `open-webui/node_modules` and a full backend venv are absent in this environment. `privacy.py` + `main.py` ast-parse clean and mirror `policies.py`; frontend mirrors the policies workspace. Needs `cd open-webui && npm i && npm run check` + a live admin click-through before merge.

---

## Final (after all phases)

- [x] Repo `CLAUDE.md`: rewrote the privacy subsection (classify endpoint + heuristic, `restricted`, `SECRET`, Indonesian regex + NER, leak table, mapping admin tab, `chat.ts` now wired); fixed the stale "length heuristic" line (it's an HF `/classify` call).
- [x] `docs/PRD-confidentiality-pipeline.md` — Phase 3.3 marked done, "Follow-up" section pointing at this work.
- [x] Obsidian: `Projects/ai-workspace/2026-08-27-confidentiality-automation.md` (product-side, full write-up incl. bugs found) + `Projects/MODE/2026-08-27-privacy-classify-and-detectors.md` (MADE-side). NOTE: this machine's vault was empty — the "add a pointer line to the existing index note" step still needs doing wherever the real note graph lives.
- [x] `npm test` 132/133 (1 pre-existing: `GET / serves the index page`, needs `npm run build`); `pytest MADE/tests/core/privacy + api/test_privacy` 48/48; full `pytest MADE/` 131/156 (25 pre-existing `opa eval` v1); `opa test --v0-compatible` 25/25; `openwebui-filters` 28/28; `npx tsc --noEmit` clean; MADE app boots with all 6 `/privacy/*` routes.
- [ ] **Left for the user:** `cd open-webui && npm i && npm run check` + live admin click-through; `docker compose up --build` end-to-end smoke (needs real `.env` secrets; the MADE image build now also pulls the ~420 MB Indonesian NER checkpoint).

## Pre-existing issue worth a separate fix

`core/epm/opa_client.py` and `api/main.py`'s `deploy_policy` shell `opa` without
`--v0-compatible`. Fine against the Docker-pinned `opa v0.67.0`, but breaks on
any v1 OPA (25 test failures on a dev machine with current OPA). Either inject
`--v0-compatible` or migrate `policies/hard/*.rego` to Rego v1 syntax.
