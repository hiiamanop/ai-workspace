# Schema — Confidentiality pipeline

See [[docs/SYSTEM_DESIGN.md]] for how these fit together.

## `EntityMapping` (new SQLModel table, `MADE/storage/models.py`)

Same SQLite DB as the existing `DecisionRecord`/`ScoreCacheRecord` tables
(`storage/db.py`'s `make_engine`), no new engine.

| column                    | type      | notes                                                        |
|----------------------------|-----------|---------------------------------------------------------------|
| `id`                       | str (PK)  | `uuid4`                                                        |
| `org_id`                   | str       | scopes mapping reuse — see unique constraint below             |
| `entity_type`               | str       | `"PERSON" \| "ORG" \| "GPE" \| "EMAIL" \| "PHONE" \| "ID_NUMBER" \| "CARD_NUMBER"` |
| `placeholder`               | str       | e.g. `"[PERSON_3]"` — unique per `(org_id, entity_type)` counter |
| `original_value_encrypted`  | str       | Fernet-encrypted original text, keyed by `MADE_MAPPING_ENCRYPTION_KEY` |
| `created_at`                | datetime  | UTC                                                             |

Unique constraint on `(org_id, original_value_encrypted)` — since encryption
with a fixed key is deterministic-enough per identical plaintext only if
using a mode that supports it; simplest correct approach is to also store a
`original_value_hash` (SHA-256, unkeyed, not reversible) column and put the
uniqueness/lookup constraint on `(org_id, original_value_hash)` instead,
using the encrypted column purely for restore. Add:

| `original_value_hash`      | str       | SHA-256 hex of the original value — lookup key, not secret |

Unique constraint: `(org_id, original_value_hash)`.

## Qdrant collection

One collection, e.g. `made_rag`. Vector size/distance depends on the chosen
embedding model (pick one already reachable — e.g. reuse whatever the
`CLASSIFIER_MODEL`/DeepSeek embeddings endpoint provides, or a small local
sentence-transformers model; decide at implementation time, not in this
doc). Payload per point:

```json
{
  "org_id": "string",
  "source": "string",
  "classification": "public | internal | confidential | restricted",
  "content_hash": "sha256 hex of the redacted text (dedupe key)",
  "redacted_text": "string (already safe to forward to a model)"
}
```

Raw (pre-redaction) text is never stored in Qdrant — only the redacted text
and metadata.

## API shapes (`MADE/api/schemas.py`, `MADE/api/main.py`)

```
POST /privacy/redact
  in:  { org_id: str, text: str }
  out: { redacted_text: str, redaction_count: int }

POST /privacy/restore
  in:  { org_id: str, text: str }
  out: { restored_text: str }

POST /privacy/rag/ingest
  in:  { org_id: str, source: str, text: str, classification: DataClassification }
  out: { document_id: str }

POST /privacy/rag/query
  in:  { org_id: str, query: str, top_k: int = 5 }
  out: { results: [{ document_id: str, score: float, redacted_text: str, source: str }] }
```

## `TaskIn`/`Task` addition (existing schema, one new field)

```
redacted: bool = False
```

Read by the new/updated `compliance.rego` deny rule: confidential/restricted
`data_classification` + external vendor + `redacted != true` → deny.
