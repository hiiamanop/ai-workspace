# PRD — Confidentiality pipeline, made automatic

Follow-up to [[docs/PRD-confidentiality-pipeline.md]] (Phases 1–3 shipped).
This is "point 1" from the 2026-08-27 roadmap discussion: close the pipeline
so it protects real traffic **without a human setting flags** and **without
English-only blind spots**.

## Problem

The confidentiality guarantee is real but shallow:

1. **Classification is a side effect of redaction, not a decision.**
   `confidential_redaction.py`'s `inlet()` marks a request
   `data_classification: "confidential"` *only if `detect_all()` happened to
   find a PII span*. Sensitive prose with no detectable entity —
   "our Q3 revenue fell 40%", "the acquisition closes Friday", a pasted
   internal memo — is classified `"internal"` and sent to DeepSeek verbatim.
2. **`"restricted"` is never assigned by anything.** The enum exists; no
   caller ever produces it. Credentials / API keys / private keys pasted
   into chat get the same treatment as a phone number.
3. **Detection is English-only.** `detect_all()` runs `en_core_web_sm`.
   Indonesian names, organisations, and locations are missed by NER;
   NPWP, KK, Indonesian plates, and `08xx` phone formats are missed by
   regex. For an Indonesian userbase this is the common case, not the edge.
4. **`src/chat.ts` is not wired at all** (Phase 3.3, deferred) — the
   bespoke chat page still hardcodes `"internal"` and never calls
   `/privacy/*`.
5. **No operational safety net.** No way for an admin to inspect or correct
   the placeholder↔original mappings, and nothing verifies that redaction
   actually removed what it claimed to.

## Goal

Make `data_classification` an **automatic decision MADE makes about the
data**, the same way model-tier selection is a decision MADE makes — then
make the detection underneath it good enough for Indonesian content, wire
the second caller, and add the audit surface that makes the whole thing
trustworthy in production.

After this work, a user pasting a sensitive Indonesian document into either
chat surface is protected with no configuration, no model-picker choice,
and no flag — or is told clearly why the request was blocked.

## Non-goals

- Per-org classification lexicons / tuning UI — one global rule set to start.
- Training a custom classifier model — heuristic + cheap-LLM fallback only.
- RAG over confidential documents — still out of scope (see
  [[docs/PRD-confidentiality-pipeline.md]]'s "No vector store" note).
- A second (local / trusted) model vendor — separate roadmap item; this PRD
  only makes the *block* correct when confidential data can't be sent.
- Retroactive re-classification of already-stored conversations.

## Success criteria

- `POST /privacy/classify {org_id, text}` returns one of
  `public|internal|confidential|restricted` deterministically for the
  heuristic-covered cases, and via a cheap-LLM tie-break for the rest, with
  the LLM result validated against the enum and cached per `(org_id, hash)`.
- `confidential_redaction.py` redacts whenever classification is
  `confidential`/`restricted` — **not** only when a regex/NER span was
  found — and threads the real classification to `made_routing.py`.
- Confidential data with **no redactable span** fails closed: `POST /decide`
  denies it for external vendors and the user sees a specific message, not a
  generic error.
- `restricted` (credentials / secrets detected) is **always** denied for
  external vendors, redacted or not.
- `detect_all()` covers Indonesian structured PII (NIK, NPWP, KK, plate,
  `08xx`/`+62` phone) and Indonesian PERSON/ORG/GPE via an Indonesian NER
  model, merged with the English pass (regex > ID-NER > EN-NER on overlap).
- `src/chat.ts` runs the same classify → redact → decide → restore flow as
  the Open WebUI filter, including the blocked-request branch.
- An admin can list, reveal, edit, and delete entity mappings for an org
  from an Open WebUI workspace tab, and can see a log of redaction leaks
  (spans that survived a redact pass).

## Phases

Each phase is independently shippable and testable. See
[[docs/superpowers/specs/2026-08-27-confidentiality-automation-design.md]]
for design and
[[docs/superpowers/plans/2026-08-27-confidentiality-automation.md]] for the
task-level plan.

| Phase | What | Size | Depends on |
|-------|------|------|-----------|
| **A** | `POST /privacy/classify` (hybrid heuristic + LLM), filter wiring, `restricted.rego`, blocked-request UX | L | B1 (soft) |
| **B1** | Indonesian regex detectors (NIK context, NPWP, KK, plate, phone) | S | — |
| **B2** | Indonesian NER model, merged into `detect_all()` | M | — |
| **C** | Wire `src/chat.ts` (Phase 3.3) | M | A |
| **D** | Entity-mapping admin UI (MADE endpoints → Node proxy → Open WebUI tab) | M | — |
| **E** | Redaction-leak detection + placeholder-mangling guard | M | B |

**Recommended order:** B1 → A → C → B2 → E → D. B1 is cheap and improves
A's heuristic signal; A is the keystone; C rides on A; B2 is heavier and can
land after; E wants the detector set stable first; D is pure ops, last.

## Key open decisions (resolve before building the phase they gate)

1. **Confidential-but-unredactable → block or allow?** *(gates A)*
   Recommendation: **block**, fail closed, with a specific user-facing
   message ("This message looks confidential and can't be safely sent to an
   external model. Rephrase without the sensitive details, or an admin can
   configure a trusted model."). Rationale: matches the existing
   `external_vendor.rego` philosophy — the gate is the guarantee, not a
   courtesy. Alternative (allow, treat "ran redaction, found nothing" as
   satisfying the gate) weakens the guarantee to nothing for exactly the
   content that most needs it.

2. **Where does the LLM tie-break run?** *(gates A)*
   Recommendation: **inside MADE** (`core/privacy/classifier.py`), new
   `MADE_CLASSIFIER_API_KEY` / `MADE_CLASSIFIER_MODEL` /
   `MADE_CLASSIFIER_BASE_URL` env vars, `httpx` (already a dep). Keeps
   "MADE decides" coherent and lets `src/chat.ts` reuse it for free.
   Cost is bounded: heuristic resolves the common cases, the LLM only fires
   on genuine ambiguity, and results are cached per `(org_id, hash(text))`.
   Tradeoff: MADE gains a model-provider secret it didn't have (the
   "zero LLM secrets" rule in the repo `CLAUDE.md` is scoped to Open WebUI,
   not MADE — but worth stating explicitly). Alternative: a local HF
   zero-shot model (no secret, consistent with the complexity classifier)
   — rejected for now because zero-shot classification into a 4-level
   sensitivity rubric is markedly less reliable than a cheap instruct model.

3. **`restricted` semantics.** *(gates A)*
   Recommendation: `restricted` = credentials/secrets pattern detected
   (API keys, private keys, JWT, `password:` lines) → **hard block for
   external vendors even if redacted** (new `restricted.rego`).
   `confidential` = everything else sensitive → redact + existing
   `external_vendor.rego` gate. Without this distinction `restricted` is
   just a synonym for `confidential` and not worth assigning.

4. **Indonesian NER model choice.** *(gates B2)*
   Candidates: a `transformers` token-classification model (an Indonesian
   BERT / XLM-R NER checkpoint — `transformers` + `torch` already MADE
   deps), or Stanza `id`. Decision belongs in B2's spec once one is
   benchmarked on a small Indonesian PII sample. Note the Docker image / cold
   start cost (~0.5–1 GB model download) — mirror the complexity classifier's
   warm-up-on-startup pattern.

5. **Mapping-admin auth.** *(gates D)*
   MADE has no auth today and these endpoints return **decrypted PII**.
   Recommendation: do not expose them publicly on MADE — proxy through the
   ai-workspace Node backend (`/api/v1/privacy/mappings*`) which does the
   Open WebUI admin check, exactly like the C2 Policies workspace. MADE
   endpoints bind to the internal Docker network only.

## Related docs

- [[docs/PRD.md]] — whole-app direction.
- [[docs/PRD-confidentiality-pipeline.md]] — Phases 1–3, the foundation this builds on.
- [[docs/SYSTEM_DESIGN.md]], [[docs/SCHEMA.md]] — existing pipeline shapes.
- [[docs/superpowers/specs/2026-08-27-confidentiality-automation-design.md]] — design.
- [[docs/superpowers/plans/2026-08-27-confidentiality-automation.md]] — plan.
