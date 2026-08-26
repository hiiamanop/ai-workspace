# PRD — Confidentiality pipeline for MADE

## Problem

`ai-workspace` used to route confidential work to a local Ollama model as its
only privacy control: nothing sensitive ever left the machine because the
model itself never left the machine. That control is gone now that the app
is full-API (DeepSeek): every message, regardless of sensitivity, leaves the
process boundary as plain text.

MADE already has the shape of a real policy control for this
(`TaskIn.data_classification`, and `compliance.rego`/`privacy.rego` hard
constraints that deny specific vendors for confidential/restricted data) but
it's inert — `ai-workspace` hardcodes `data_classification: "internal"` on
every request, so the constraints never evaluate against real data, and the
deny lists don't cover the vendor actually in use (DeepSeek).

## Goal

Move the confidentiality guarantee from "which vendor" to "what data" —
confidential/restricted content gets redacted (structured PII + named
entities replaced with stable placeholders) before it can reach an external
vendor, and restored in the response.

**No vector store in this PRD.** Redaction (detect → placeholder → restore)
is pure text processing — it needs a SQL table for the entity mapping, not
a vector DB. A vector store would only matter for a *separate*, not-yet-
requested feature (RAG over confidential documents), and even then Open
WebUI already has its own native Knowledge/RAG (`VECTOR_DB` — Chroma by
default, also pgvector/mariadb-vector/oracle23ai). Standing up a second
vector store (originally planned as Qdrant) was speculative — decided to
drop it from scope entirely rather than build it ahead of a real need. See
[[docs/PRD-openwebui-integrations.md]] for the full survey this decision
came from. If confidential-document RAG becomes a real requirement later,
revisit then — as its own scoped piece of work, not bundled into redaction.

## Non-goals (this iteration)

- Wiring every caller (Open WebUI's chat path, `chat.ts`,
  web_search/scrape ingestion) — those are follow-up phases once the MADE
  core is in place and verified.
- A UI for reviewing/editing entity mappings.
- Automatic classification of arbitrary free text into
  public/internal/confidential/restricted — classification is still supplied
  by the caller; this iteration only makes the *enforcement* real.
- A vector store / RAG-over-confidential-documents — dropped from scope
  entirely (not deferred to a later phase here); see the "No vector store"
  note above.

## Success criteria

- `POST /privacy/redact` reliably detects structured PII (email, phone,
  ID/NIK-style numbers, card numbers) and free-form entities (names, orgs,
  locations), replaces them with stable per-org placeholders, and
  `POST /privacy/restore` reverses it exactly.
- The same input, redacted twice, produces the same placeholders (mapping is
  persistent and reused, not re-randomized per call).
- MADE's hard constraints deny confidential/restricted data_classification
  for external vendors (DeepSeek included) unless `task.redacted == true`.

## Task breakdown

Sized T-shirt-style (S = under an hour of focused work, M = a few hours,
L = a session on its own). Ordered so each phase is independently useful
and testable before the next starts — matches [[docs/SYSTEM_DESIGN.md]]'s
phase numbering.

**Phase 1 — MADE privacy core (no caller wired yet, pure backend)**
- 1.1 (S) `MADE/core/privacy/detectors.py` — regex detectors: email, phone,
  ID/NIK-style number, card number. Unit tests for each pattern.
- 1.2 (M) spaCy NER pass (`en_core_web_sm`) for PERSON/ORG/GPE, merged with
  regex spans (regex wins on overlap). Add `spacy` + the model download to
  `MADE/pyproject.toml` — confirmed installable in a clean `.venv` this
  session (`uv pip install spacy && python -m spacy download en_core_web_sm`
  both succeeded), so no dependency surprises expected here.
- 1.3 (S) `EntityMapping` table in `MADE/storage/models.py` — same
  `storage/db.py` SQLite engine as `DecisionRecord`. Unique on
  `(org_id, original_value_hash)`.
- 1.4 (M) `MADE/core/privacy/pseudonymizer.py` — `redact()`/`restore()`,
  Fernet encryption keyed by a new required `MADE_MAPPING_ENCRYPTION_KEY`.
- 1.5 (S) `POST /privacy/redact` / `POST /privacy/restore` in
  `MADE/api/main.py` + `api/schemas.py`.
- 1.6 (S) pytest: redact/restore round-trip, mapping stability across
  repeated calls with the same input.

**Phase 2 — Policy tightening** ✅ done
- 2.1 `redacted: bool = False` added to `TaskIn`/`Task`
  (`MADE/api/schemas.py`, `core/decision/engine.py`). New
  `external_vendor.rego` denies confidential/restricted
  `data_classification` for external vendors (`deepseek`, `openai`) unless
  `redacted: true`. Verified live: `POST /decide` with confidential+deepseek
  denies without `redacted`, allows with it.
- 2.2 21/21 `opa test policies/hard/` pass (6 new cases); one pre-existing
  test (`privacy_test.rego`'s EU-residency check) updated to pass
  `redacted: true` so it isolates the region-specific rule it's actually
  testing, now that the broader external-vendor rule also applies to its
  input.
- **Bonus bug found while wiring this up:** `POST /decide`
  (`MADE/api/main.py`) and the experiment harness
  (`MADE/core/experiment/harness.py`) both built their internal `Task`
  without passing through the request's `complexity` field at all — every
  decision silently used the default `"medium"`, so the HF complexity
  classifier's output never actually influenced model routing despite
  looking like it did (the raw request was logged correctly, just never
  consumed). Fixed in both places alongside adding `redacted`; regression
  test added that proves complexity changes which candidate wins (not just
  that the field is accepted).

**Phase 3 — Wire the primary caller (Open WebUI)** ✅ (3.1, 3.2 done; 3.3 deferred)
This is where the guarantee actually starts protecting real traffic — Open
WebUI's chat path talks to DeepSeek directly and never touches this Node
app, so Phases 1-2 alone protect nothing yet.
- 3.1 (M) ✅ `openwebui-filters/confidential_redaction.py` — same
  `inlet`/`outlet` shape as `made_routing.py`: `inlet` calls
  `/privacy/redact` on user messages and sets `body["_privacy"]` when it
  redacts anything (consumed by `made_routing.py`'s `_call_made()`),
  `outlet` calls `/privacy/restore` on every message. `Valves.priority =
  -10` so it runs before `made_routing.py` (default `0`). 8 tests in
  `openwebui-filters/tests/test_confidential_redaction.py`, all passing.
- 3.2 (S) ✅ `src/openwebui-provision-redaction.ts` — `provisionRedactionFilter()`,
  simpler than `provisionFilter()` (no `OPENWEBUI_URL`/token valve needed —
  this Filter never calls Open WebUI's own API, only MADE's). Wired into
  `reconcileOnce()` in `src/openwebui-provisioning-reconciler.ts`. TS tests
  in `tests/openwebui-provision-redaction.test.ts` and updated
  `tests/openwebui-provisioning-reconciler.test.ts`.
- 3.3 (S) deferred — `src/chat.ts` same redact/restore calls, lower
  priority since Open WebUI is the primary surface, not this app's own
  chat page.

## Related docs

- [[docs/PRD.md]] — whole-app product direction; this is one pillar of it.
- [[docs/SYSTEM_DESIGN.md]] — component/request-flow design.
- [[docs/SCHEMA.md]] — new DB table and API request/response shapes.
- Plan file for this work: `~/.claude/plans/wise-squishing-backus.md`.
