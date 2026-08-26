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
vendor, and restored in the response. RAG/knowledge content that is
confidential is stored and retrieved as vectors, never forwarded to an
external model as raw text.

## Non-goals (this iteration)

- Wiring every caller (Open WebUI's chat path, `chat.ts`,
  web_search/scrape ingestion) — those are follow-up phases once the MADE
  core is in place and verified.
- A UI for reviewing/editing entity mappings.
- Automatic classification of arbitrary free text into
  public/internal/confidential/restricted — classification is still supplied
  by the caller; this iteration only makes the *enforcement* real.

## Success criteria

- `POST /privacy/redact` reliably detects structured PII (email, phone,
  ID/NIK-style numbers, card numbers) and free-form entities (names, orgs,
  locations), replaces them with stable per-org placeholders, and
  `POST /privacy/restore` reverses it exactly.
- The same input, redacted twice, produces the same placeholders (mapping is
  persistent and reused, not re-randomized per call).
- MADE's hard constraints deny confidential/restricted data_classification
  for external vendors (DeepSeek included) unless `task.redacted == true`.
- RAG documents can be ingested into and queried from a vector store
  (Qdrant) without their raw confidential text ever being required by a
  caller outside MADE.

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

**Phase 2 — Vector store**
- 2.1 (S) `qdrant` service in `docker-compose.yaml` — official prebuilt
  image, no build/compile step (unlike the spaCy scare that broke the
  `made` image build earlier this session — Qdrant carries no such risk).
- 2.2 (M) `MADE/core/privacy/vector_store.py` — `qdrant-client` wrapper
  (`upsert_document`, `query_similar`), collection auto-created on startup.
- 2.3 (M) `POST /privacy/rag/ingest` / `POST /privacy/rag/query`. Embedding
  model: local `sentence-transformers` (`all-MiniLM-L6-v2`) running inside
  MADE — no external API call just to embed text, consistent with MADE
  being the boundary that holds sensitive data (decided; add
  `sentence-transformers` to `MADE/pyproject.toml`).

**Phase 3 — Policy tightening**
- 3.1 (S) Add `redacted: bool = False` to `TaskIn`/`Task`
  (`MADE/api/schemas.py`, `core/decision/engine.py`). Update
  `compliance.rego` (or a new `external_vendor.rego`) to deny
  confidential/restricted `data_classification` for external vendors
  (`deepseek` included, not just `unverified-oss`) unless `redacted: true`.
- 3.2 (S) Matching `_test.rego` cases, `opa test policies/hard/`.

**Phase 4 — Wire the primary caller (Open WebUI)**
This is where the guarantee actually starts protecting real traffic — Open
WebUI's chat path talks to DeepSeek directly and never touches this Node
app, so Phases 1-3 alone protect nothing yet.
- 4.1 (M) `openwebui-filters/confidential_redaction.py` — same
  `inlet`/`outlet` shape as `made_routing.py` (built and verified working
  this session): `inlet` calls `/privacy/redact` on `body["messages"]`,
  `outlet` calls `/privacy/restore` on the reply.
- 4.2 (S) `src/openwebui-provision-redaction.ts` — provisioning script
  mirroring `openwebui-provision.ts`. **Slots directly into the
  provisioning reconciler already built this session**
  (`src/openwebui-provisioning-reconciler.ts`) — add one more
  `provisionRedactionFilter()` call there and it gets auto-reconciled for
  free, no new infrastructure needed.
- 4.3 (S) `src/chat.ts` — same redact/restore calls, lower priority since
  Open WebUI is the primary surface, not this app's own chat page.

**Phase 5 — RAG ingestion from existing tools**
- 5.1 (M) Route `web_search`/`scrape` results through
  `/privacy/rag/ingest` instead of inlining raw results into the prompt;
  retrieval at answer-time via `/privacy/rag/query` returns only
  already-redacted snippets.

## Related docs

- [[docs/PRD.md]] — whole-app product direction; this is one pillar of it.
- [[docs/SYSTEM_DESIGN.md]] — component/request-flow design.
- [[docs/SCHEMA.md]] — new DB table and API request/response shapes.
- Plan file for this work: `~/.claude/plans/wise-squishing-backus.md`.
