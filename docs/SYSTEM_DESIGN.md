# System design — Confidentiality pipeline

See [[docs/PRD-confidentiality-pipeline.md]] for problem/goals (part of the
overall [[docs/PRD.md]] direction), [[docs/SCHEMA.md]] for exact shapes.

## Components

```
                         ┌─────────────────────────────┐
                         │            MADE              │
                         │                               │
  caller (chat.ts,       │  POST /privacy/redact ───┐   │
  Open WebUI filter,      │  POST /privacy/restore   │   │
  future callers) ───────▶│                          │   │
                         │   core/privacy/            │   │
                         │    detectors.py  (regex +  │   │
                         │                   spaCy NER)│   │
                         │    pseudonymizer.py ───────┼───┼──▶ storage: EntityMapping
                         │                              │   │
                         │  POST /decide (existing) ────┼───┤
                         │    core/decision/engine.py   │   │
                         │    policies/hard/*.rego      │   │
                         │      (compliance.rego: deny   │   │
                         │       external vendor for     │   │
                         │       confidential/restricted  │   │
                         │       unless task.redacted)    │   │
                         └─────────────────────────────┘
```

`core/privacy/` is new. Everything else in the diagram (decision engine,
rego policies, storage/db.py's SQLite engine) already exists and is reused,
not rebuilt.

## Request flow (once callers are wired — Phase 3)

1. Caller has an outgoing message that may contain confidential content.
2. Caller calls `POST /privacy/redact {org_id, text}`. MADE detects spans
   (regex ∪ NER), looks up or creates stable placeholders per span via
   `EntityMapping` (keyed on `(org_id, original_value)`), returns
   `redacted_text` + count.
3. Caller builds its `DecideRequest` with `task.redacted = redaction_count > 0`
   (or `true` unconditionally once wired) and the real
   `task.data_classification` — no longer hardcoded `"internal"`.
4. `POST /decide` runs as today, except now `compliance.rego`'s external-
   vendor rule can actually fire: confidential/restricted data classified
   as *not* redacted is denied for any vendor outside the trusted set.
5. Caller sends the **redacted** text to the selected model provider.
   Nothing confidential ever reaches the external API — the placeholders are
   inert tokens like `[PERSON_3]`.
6. Response comes back containing those same placeholders (the model just
   echoes/reasons over opaque tokens). Caller calls
   `POST /privacy/restore {org_id, text}` before showing/streaming it to the
   user; MADE substitutes originals back in.

## Enforcement boundary

The rego deny rule is the actual gate, not the redaction call itself — a
caller that skips redaction and sends `task.redacted: false` (or omits it)
with confidential/restricted data gets denied by `POST /decide` for any
external vendor, the same way `context.rego` denies candidates whose context
window is too small today. Redaction is how a caller satisfies the gate, not
a courtesy step a caller could bypass.

## Where this doesn't reach yet (Phase 3, not built in this iteration)

- `src/chat.ts` still hardcodes `data_classification: "internal"` and never
  calls `/privacy/*`. Confidential-marked requests from this app's own chat
  UI aren't protected until that phase lands.
- Open WebUI's primary chat path talks to DeepSeek directly (never through
  this Node app), so it needs its own Filter (`inlet`/`outlet`, same shape as
  `openwebui-filters/made_routing.py`) calling `/privacy/redact` and
  `/privacy/restore`. Not built in this iteration.

No vector store / RAG-over-confidential-documents is planned here — see
[[docs/PRD-confidentiality-pipeline.md]]'s "No vector store" note.
