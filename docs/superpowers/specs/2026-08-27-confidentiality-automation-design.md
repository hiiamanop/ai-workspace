# Design — Confidentiality pipeline, made automatic

PRD: [[docs/PRD-confidentiality-automation.md]].
Plan: [[docs/superpowers/plans/2026-08-27-confidentiality-automation.md]].
Builds on: [[docs/PRD-confidentiality-pipeline.md]], [[docs/SYSTEM_DESIGN.md]],
[[docs/SCHEMA.md]].

## Current state (verified against source)

- `MADE/core/privacy/detectors.py` — `detect()` (regex: EMAIL, CARD_NUMBER
  Luhn-checked, ID_NUMBER = 16 digits, PHONE) and `detect_all()` (regex ∪
  spaCy `en_core_web_sm` PERSON/ORG/GPE, regex wins on overlap).
  `warm_up_ner()` called on FastAPI startup.
- `MADE/core/privacy/pseudonymizer.py` — `redact(text, org_id, session)` →
  `(text, count)`, `restore(text, org_id, session)`. Placeholders
  `[TYPE_n]`, stable per `(org_id, sha256(value))`, originals Fernet-
  encrypted (`MADE_MAPPING_ENCRYPTION_KEY`). `PLACEHOLDER_RE =
  r"\[([A-Z_]+)_(\d+)\]"`.
- `MADE/storage/models.py::EntityMapping` — `id, org_id (indexed),
  entity_type, placeholder, original_value_hash, original_value_encrypted,
  created_at`. Unique `(org_id, original_value_hash)`.
- `MADE/api/main.py` — `POST /privacy/redact`, `POST /privacy/restore`,
  `POST /classify` (complexity, local HF `deberta-v3-small`), `POST /decide`.
  Sessions via `with get_session(get_engine()) as session`.
- `MADE/api/schemas.py::TaskIn` — `data_classification:
  Literal["public","internal","confidential","restricted"]`,
  `redacted: bool = False`.
- `MADE/policies/hard/external_vendor.rego` — denies
  `{confidential,restricted}` for vendor ∈ `{deepseek, openai}` when
  `not input.task.redacted`.
- `openwebui-filters/confidential_redaction.py` — `inlet()` redacts user
  messages, sets `body["_privacy"] = {"data_classification":"confidential",
  "redacted":True}` **only when `count > 0`**; `outlet()` restores. Per-turn
  `_redact_cache` / `_restore_cache` dicts. `priority = -10`.
- `openwebui-filters/made_routing.py::_call_made()` — reads
  `body["_privacy"]`, defaults `("internal", False)`; on no-selection falls
  back to `_cheapest_qualifying()`.
- `src/chat.ts` — builds its `DecideRequest` with hardcoded
  `data_classification: "internal"`; never calls `/privacy/*`.
- ai-workspace has `DEEPSEEK_API_KEY`; MADE has no model-provider secret.

---

## Phase A — auto data-classification

### A.1 `MADE/core/privacy/classifier.py` (new)

`classify(text, org_id, session) -> ClassifyResult` where
`ClassifyResult = {classification, confidence: float, signals: list[str],
source: Literal["heuristic","llm","cache"]}`.

Order: **cache read → heuristic → LLM tie-break (only if inconclusive)**.

**Heuristic layer** — precedence high→low, first hit wins:

| Signal | → classification |
|--------|------------------|
| Secrets regex hit (A.2) | `restricted` |
| CARD_NUMBER or ID_NUMBER (NIK/NPWP/KK) span present | `confidential` |
| ≥2 distinct PERSON spans **and** ≥1 ORG span | `confidential` |
| Sensitivity lexicon hit (A.3) | `confidential` |
| Public-marker lexicon hit | `public` |
| EMAIL or PHONE span present, nothing above | `internal` |
| Nothing matched, text < 40 chars | `internal` |
| Nothing matched, text ≥ 40 chars | **inconclusive** → LLM |

**LLM tie-break** — `core/privacy/llm_client.py`, `httpx`, model
`MADE_CLASSIFIER_MODEL` (default `deepseek-v4-flash`), base
`MADE_CLASSIFIER_BASE_URL`, key `MADE_CLASSIFIER_API_KEY`. System prompt =
the 4-level rubric; user message = text truncated to ~4k chars. Parse for a
single enum token. **Guards** (mirror `openwebui-policy-compiler.ts`):
no key / not-in-enum / timeout (`MADE_CLASSIFIER_TIMEOUT`, default 6s) →
return `internal`, `confidence: 0.4`, `signals: ["llm-unavailable" | "llm-unparseable"]`.

**Cache** — `ClassificationCache` table (A.5), key `(org_id, sha256(text))`,
written on every non-cache result, read first.

### A.2 Secrets detectors → `detectors.py`

New regexes in `detect()` **before** the digit patterns, entity type
`SECRET`:
- Generic key: `\b(sk|pk|rk|api|key|token)[-_][A-Za-z0-9]{16,}\b` (ci prefix)
- AWS: `\bAKIA[0-9A-Z]{16}\b`
- Private key header: `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
- JWT: `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`
- `password|passwd|secret|api[_ ]?key` `[:=]` + non-space token

### A.3 Sensitivity lexicon → `MADE/core/privacy/lexicon.yaml` (new)

```yaml
confidential:
  en: [confidential, "internal only", "do not share", proprietary, "under nda",
       acquisition, merger, layoff, termination, salary, compensation, lawsuit,
       "trade secret", roadmap, unreleased]
  id: [rahasia, "internal saja", "jangan disebar", "jangan dibagikan", gaji,
       kompensasi, pesangon, phk, akuisisi, merger, "tuntutan hukum", gugatan,
       kontrak, "nota kesepahaman", sengketa]
public:
  en: ["press release", "blog post", "public announcement", "for publication"]
  id: ["siaran pers", "rilis pers", "untuk publikasi", pengumuman]
```

Whole-word / phrase match, case-insensitive. Loaded once, module global.

### A.4 API — `MADE/api/main.py` + `schemas.py`

```
POST /privacy/classify
  req  {org_id: str, text: str}
  resp {classification: str, confidence: float, signals: list[str], source: str}
```

Sync endpoint, `with get_session(get_engine())`.

### A.5 `ClassificationCache` → `MADE/storage/models.py`

Fields: `id (pk), org_id (indexed), text_hash, classification, confidence,
source, created_at`. Unique `(org_id, text_hash)`. Auto-created by
`make_engine` like `EntityMapping`.

### A.6 `restricted.rego` → `MADE/policies/hard/`

```rego
package made.hard

deny[reason] {
    input.task.data_classification == "restricted"
    {"deepseek", "openai"}[input.candidate.vendor]
    reason := sprintf("privacy: vendor '%s' not approved for restricted data (secrets detected)", [input.candidate.vendor])
}
```

`restricted_test.rego` alongside; keep `opa test policies/hard/` green.

`SECRET` spans in `pseudonymizer.redact()` → non-reversible marker
`[SECRET_REDACTED]` (no `EntityMapping` row — a secret is never stored, even
encrypted). `restore()` leaves it untouched (no trailing `_\d+`, so
`PLACEHOLDER_RE` doesn't match it).

### A.7 `confidential_redaction.py` rewrite

`inlet()`:
1. Newline-join all user-message contents → `combined`.
2. `classification = await self._classify(org_id, combined)` (own
   `_classify_cache` dict, keyed by `(org_id, combined)`).
3. If `classification in ("confidential","restricted")`: redact each user
   message; track `total_redactions`.
4. **Always** set `body["_privacy"] = {"data_classification": classification,
   "redacted": total_redactions > 0}` when confidential/restricted — even
   when `total_redactions == 0`.
5. `internal`/`public` but a span was still found → redact anyway, set
   `_privacy` with that classification.

### A.8 Blocked-request UX

`made_routing.py`: if `data_classification in ("confidential","restricted")`
and `/decide` returned no `selected_candidate_id`, **do not** fall back to
`_cheapest_qualifying()`. Instead `raise Exception(BLOCKED_MESSAGE)` from
`inlet()` — Open WebUI renders the string as an error bubble. `BLOCKED_MESSAGE`
= module constant, e.g. *"This message looks confidential and can't be safely
sent to an external model. Remove the sensitive details, or ask an admin to
configure a trusted model."*

### A.9 Tests

- `MADE/tests/test_privacy_classifier.py` — heuristic table (one per row),
  secrets regexes, lexicon EN+ID, cache hit → `source:cache`,
  LLM-unavailable / LLM-unparseable fallback.
- `MADE/tests/test_privacy_api.py` — `POST /privacy/classify` shape.
- `opa test policies/hard/` — `restricted_test.rego`, all green.
- `openwebui-filters/tests/test_confidential_redaction.py` — extend:
  confidential-no-span still sets `_privacy` (`redacted:false`); restricted
  → raises `BLOCKED_MESSAGE`; internal short text untouched. Mock the
  classify HTTP call like the existing MADE mocks.

---

## Phase B1 — Indonesian regex detectors

`detectors.py`, added to `detect()` (after EMAIL, before generic PHONE):

| Type | Pattern (sketch) | Notes |
|------|------------------|-------|
| `NPWP` | `\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}`, or bare `\b\d{15,16}\b` **with** an `npwp` keyword within ~20 chars | bare form collides with NIK/CARD — require keyword |
| `KK` | `\b\d{16}\b` **with** a `kartu keluarga`/`no. kk` keyword nearby | same shape as NIK — keyword disambiguates; else stays `ID_NUMBER` |
| `ID_PLATE` | `\b[A-Z]{1,2}\s?\d{1,4}\s?[A-Z]{1,3}\b` | require region-code prefix ∈ known set, or a `plat`/`nopol` keyword nearby |
| `PHONE` (ID) | extend `PHONE_RE` to accept `(?:\+62|62|0)8\d{7,12}` | fold into existing PHONE type |

`NIK` stays `ID_NUMBER`. Helper `_keyword_near(text, span, words, window=24)`.

Tests: `test_detectors.py` — one positive + one near-miss per new pattern;
NIK-vs-KK disambiguation; plate false-positive guard.

---

## Phase B2 — Indonesian NER

`detect_all()` gains a third span source between regex and `en_core_web_sm`:

```python
spans = detect(text)                 # regex incl. B1
for ent in _id_ner(text):            # NEW
    if not overlapping: append
for ent in _get_nlp()(text).ents:    # en_core_web_sm
    if not overlapping: append
```

`_id_ner()` — `transformers.pipeline("token-classification", model=<ckpt>,
aggregation_strategy="simple")`, map `PER/ORG/LOC/GPE` → `PERSON/ORG/GPE`.
Checkpoint picked in this phase after a quick eval on a small Indonesian PII
sample (candidates: an Indonesian XLM-R / BERT NER checkpoint). Lazy module
global `_id_nlp`, added to `warm_up_ner()`. Add the download to the MADE
Dockerfile; document the image-size delta in `CLAUDE.md`.

Tests: `test_detectors.py` — Indonesian sentence with person + org + city →
all three detected; regex NIK beats an overlapping NER span.

---

## Phase C — wire `src/chat.ts`

New `src/privacy-client.ts` — `fetch` wrappers for `/privacy/classify`,
`/privacy/redact`, `/privacy/restore` against `MADE_URL`, in-process `Map`
cache keyed by `sha256(org_id + text)`. `org_id` = the user/session id
`handleChat` already has, else `"anonymous"`.

`handleChat()`:
1. Before `DecideRequest`: `classify` latest user message → real
   `data_classification`; if confidential/restricted, `redact` it (+ prior
   user turns in trimmed history) → replace content, set `redacted`.
2. Thread both into the `DecideRequest` **and** `baseRequest` so
   `context-guard.ts::ensureCandidateFits()` re-checks don't reset to
   `"internal"`.
3. Existing `MADE returned no eligible candidate` / `requires human approval`
   branches → add the confidential-blocked message (shared `BLOCKED_MESSAGE`
   constant with Phase A, in `src/privacy-client.ts`).
4. Response: buffer the full assistant message, `restore()` once, then emit
   (placeholders can split across streaming deltas — don't restore per
   token). `ponytail:` the buffering-vs-latency note.

Tests: `tests/chat.test.ts` — confidential-input case (mocked classify →
confidential, mocked redact; assert DecideRequest carries `confidential` +
`redacted:true`, assert restore on output); blocked-branch case.

---

## Phase D — entity-mapping admin UI

### D.1 MADE endpoints (`api/main.py`, internal network only)

```
GET    /privacy/mappings?org_id=&limit=&offset=  → [{id, entity_type, placeholder, original_value (DECRYPTED), created_at}]
PATCH  /privacy/mappings/{id}   {original_value?, placeholder?}
DELETE /privacy/mappings/{id}
```

`PATCH original_value` → re-encrypt + recompute `original_value_hash`
(collision → 409). `PATCH placeholder` → must stay `[A-Z_]+_\d+` and unique
per org.

### D.2 Node proxy (`src/privacy-routes.ts`, new)

`/api/v1/privacy/mappings*` — admin check via the Open WebUI token, same
pattern as the C2 policies routes (`open_webui/routers/policies.py`), then
forward to MADE. This is the auth boundary; MADE stays unauthenticated on
the internal network.

### D.3 Open WebUI tab

`open-webui/src/routes/(app)/workspace/privacy-mappings/+page.svelte` —
mirror `workspace/policies/`: admin-only (redirect non-admins), table
(placeholder / type / original masked-with-reveal / created), inline edit +
delete-with-confirm. Add tab to `(app)/workspace/+layout.svelte` next to
Policies. Format `created_at` per whatever MADE returns (ISO `datetime`
today — confirm).

Tests: `tests/privacy-routes.test.ts` (Node) — admin ok, non-admin 403,
proxy shape. MADE `test_privacy_api.py` — list/patch/delete round-trip, hash
recompute, 409 on collision.

---

## Phase E — redaction-leak detection

### E.1 Inline leak check — `pseudonymizer.redact()`

After building `result`, re-run `detect()` (regex only) on it. Any span =
a pattern that should have been caught but survived.

```python
leftover = detect(result)
if leftover:
    _record_leak(session, org_id, [s.entity_type for s in leftover], result)
    if os.environ.get("MADE_REDACTION_LEAK_FAIL_CLOSED") == "1":
        raise RedactionLeakError(...)
```

`_record_leak` stores entity types + `sha256(result)` (**not** the text) +
count + timestamp.

### E.2 `RedactionLeak` → `MADE/storage/models.py`

Fields: `id (pk), org_id (indexed), entity_types (comma-joined), span_count,
context_hash, created_at`.
`GET /privacy/leaks?org_id=&limit=&offset=` — shown in the Phase D admin tab
as a second section ("Redaction leaks — detector gaps to fix").

### E.3 Placeholder-mangling guard — `restore()` + filter `outlet()`

After `PLACEHOLDER_RE.sub`, scan for near-miss tokens
(`\[?\s*[A-Za-z]+[\s_]+\d+\s*\]?` that didn't resolve). Log at warn with the
mangled token (safe — not PII). Optional fuzzy-restore
(`[Person 3]` → `[PERSON_3]`) behind `MADE_RESTORE_FUZZY=1`, default off.

Tests: `test_pseudonymizer.py` — monkeypatch `detect` to skip one span →
leak recorded; fail-closed env raises; mangled-placeholder near-miss logged.

---

## Cross-cutting

- **`.env.example`** — add `MADE_CLASSIFIER_API_KEY`, `MADE_CLASSIFIER_MODEL`,
  `MADE_CLASSIFIER_BASE_URL`, `MADE_CLASSIFIER_TIMEOUT`,
  `MADE_REDACTION_LEAK_FAIL_CLOSED`, `MADE_RESTORE_FUZZY`. Classifier key
  optional (heuristic-only without it).
- **`docker-compose.yaml`** — pass new env to `made`; image rebuild after B2.
- **Repo `CLAUDE.md`** — new subsection: classify endpoint, `restricted`
  semantics, Indonesian detectors, leak table, mapping admin tab. Also fix
  the stale line calling complexity classification a "length heuristic" (it
  calls `/classify`, a local HF model).
- **Provisioning reconciler** — `provisionRedactionFilter()` already
  re-pushes on content-hash change; verify it picks up the A.7 rewrite. No
  reconciler code change expected.
- **Obsidian mirror** — per `MADE/CLAUDE.md` and ai-workspace `CLAUDE.md`,
  mirror this design + plan to `Projects/MODE/` and `Projects/ai-workspace/`.
  Not done this session (MCP `obsidian` not connected here).

## Risks

- **Latency:** classify adds a MADE hop to every `inlet()`. Heuristic path
  ~1ms server-side + one HTTP hop; cache absorbs history resend; LLM path
  (~1s) only on ambiguous first-seen text. Classify only the *latest* user
  message. Measure in Phase A.
- **LLM cost:** bounded by heuristic-first + cache; worst case a user pasting
  many distinct ambiguous paragraphs.
- **False "confidential" → blocked:** over-eager lexicon blocks benign
  messages. Keep lexicon tight; `confidence` + `signals` make tuning
  observable; blocked message tells the user how to proceed.
- **NER model size** inflates MADE image + cold start (B2 documents it,
  warm-up on startup).
- **Two NER models** (EN + ID) double NER latency per redact — only runs
  when classification is confidential/restricted.
