"""Reversible pseudonymization: detect → stable placeholder → restore.

Placeholders are stable per (org_id, original value) — the same input,
redacted twice, produces the same placeholder, because entity mappings are
persisted and looked up by a hash of the original value before minting a
new one. Original values are stored encrypted (Fernet, symmetric) so the
mapping table isn't itself a plaintext record of everyone's PII.
"""
import hashlib
import os
import re
from functools import lru_cache

from cryptography.fernet import Fernet
from sqlmodel import Session, func, select

from core.privacy.detectors import detect, detect_all
from storage.models import EntityMapping, RedactionLeak

PLACEHOLDER_RE = re.compile(r"\[([A-Z_]+)_(\d+)\]")

_KNOWN_TYPES = "EMAIL|PHONE|PERSON|ORG|GPE|CARD_NUMBER|ID_NUMBER|NPWP|KK|ID_PLATE|SECRET"
# A placeholder a model has mangled: right type name, but spacing/casing/
# brackets no longer match PLACEHOLDER_RE ("[Person 3]", "PHONE_1").
MANGLED_PLACEHOLDER_RE = re.compile(rf"\[?\s*({_KNOWN_TYPES})[\s_]+(\d+)\s*\]?", re.IGNORECASE)


class MissingEncryptionKeyError(RuntimeError):
    pass


class RedactionLeakError(RuntimeError):
    pass


class MappingConflictError(RuntimeError):
    """A placeholder or original-value edit would collide with another row."""


@lru_cache(maxsize=1)
def _get_fernet() -> Fernet:
    key = os.environ.get("MADE_MAPPING_ENCRYPTION_KEY")
    if not key:
        raise MissingEncryptionKeyError(
            "MADE_MAPPING_ENCRYPTION_KEY is not set — required to encrypt entity mappings at rest"
        )
    return Fernet(key.encode())


def _hash_value(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _next_counter(session: Session, org_id: str, entity_type: str) -> int:
    count = session.exec(
        select(func.count()).where(
            EntityMapping.org_id == org_id,
            EntityMapping.entity_type == entity_type,
        )
    ).one()
    return count + 1


def _get_or_create_placeholder(session: Session, org_id: str, entity_type: str, value: str) -> str:
    value_hash = _hash_value(value)
    existing = session.exec(
        select(EntityMapping).where(
            EntityMapping.org_id == org_id,
            EntityMapping.original_value_hash == value_hash,
        )
    ).first()
    if existing:
        return existing.placeholder

    fernet = _get_fernet()
    counter = _next_counter(session, org_id, entity_type)
    placeholder = f"[{entity_type}_{counter}]"
    mapping = EntityMapping(
        org_id=org_id,
        entity_type=entity_type,
        placeholder=placeholder,
        original_value_hash=value_hash,
        original_value_encrypted=fernet.encrypt(value.encode()).decode(),
    )
    session.add(mapping)
    session.commit()
    return placeholder


def redact(text: str, org_id: str, session: Session) -> tuple[str, int]:
    spans = detect_all(text)
    if not spans:
        return text, 0

    # Replace back-to-front so earlier spans' offsets stay valid.
    result = text
    for span in sorted(spans, key=lambda s: s.start, reverse=True):
        if span.entity_type == "SECRET":
            # Non-reversible: a credential is never stored, not even encrypted,
            # so there is no mapping row and restore() leaves the marker as-is.
            placeholder = "[SECRET_REDACTED]"
        else:
            placeholder = _get_or_create_placeholder(session, org_id, span.entity_type, span.value)
        result = result[: span.start] + placeholder + result[span.end :]

    _check_for_leak(result, org_id, session)
    return result, len(spans)


def _check_for_leak(result: str, org_id: str, session: Session) -> None:
    """A regex-detectable span surviving redaction is a detector gap. Records
    it (hash only, never the text) and — if MADE_REDACTION_LEAK_FAIL_CLOSED=1
    — refuses to hand back the leaky output."""
    leftover = detect(result)
    if not leftover:
        return
    types = [s.entity_type for s in leftover]
    session.add(RedactionLeak(
        org_id=org_id,
        entity_types=",".join(sorted(set(types))),
        span_count=len(types),
        context_hash=hashlib.sha256(result.encode()).hexdigest(),
    ))
    session.commit()
    if os.environ.get("MADE_REDACTION_LEAK_FAIL_CLOSED") == "1":
        raise RedactionLeakError(
            f"redaction left {len(types)} detectable span(s): {sorted(set(types))}"
        )


def restore(text: str, org_id: str, session: Session) -> str:
    fernet = _get_fernet()

    def _lookup(placeholder: str) -> str | None:
        mapping = session.exec(
            select(EntityMapping).where(
                EntityMapping.org_id == org_id,
                EntityMapping.placeholder == placeholder,
            )
        ).first()
        if mapping is None:
            return None
        return fernet.decrypt(mapping.original_value_encrypted.encode()).decode()

    def _replace(match: re.Match) -> str:
        return _lookup(match.group(0)) or match.group(0)

    result = PLACEHOLDER_RE.sub(_replace, text)

    # A model sometimes reformats a placeholder ("[PERSON_3]" -> "[Person 3]"),
    # which PLACEHOLDER_RE then misses and the user sees a raw marker.
    def _fuzzy(match: re.Match) -> str:
        canonical = f"[{match.group(1).upper()}_{match.group(2)}]"
        original = _lookup(canonical)
        if original is None:
            return match.group(0)
        print(f"privacy restore: recovered mangled placeholder {match.group(0)!r} -> {canonical}")
        return original

    fuzzy_on = os.environ.get("MADE_RESTORE_FUZZY") == "1"
    for m in MANGLED_PLACEHOLDER_RE.finditer(result):
        if PLACEHOLDER_RE.fullmatch(m.group(0)):
            continue  # already a well-formed placeholder we just failed to map
        print(f"privacy restore: possible mangled placeholder in model output: {m.group(0)!r}")
    if fuzzy_on:
        result = MANGLED_PLACEHOLDER_RE.sub(_fuzzy, result)

    return result


# --- Admin: inspect / correct the mapping table (Phase D) ---


def list_mappings(session: Session, org_id: str, limit: int = 100, offset: int = 0):
    """(EntityMapping, decrypted original) pairs for an org, newest first."""
    rows = session.exec(
        select(EntityMapping)
        .where(EntityMapping.org_id == org_id)
        .order_by(EntityMapping.created_at.desc())
        .limit(min(limit, 500))
        .offset(offset)
    ).all()
    fernet = _get_fernet()
    return [(r, fernet.decrypt(r.original_value_encrypted.encode()).decode()) for r in rows]


def update_mapping(
    session: Session,
    org_id: str,
    mapping_id: str,
    *,
    original_value: str | None = None,
    placeholder: str | None = None,
) -> tuple[EntityMapping, str] | None:
    row = session.exec(
        select(EntityMapping).where(
            EntityMapping.id == mapping_id, EntityMapping.org_id == org_id
        )
    ).first()
    if row is None:
        return None

    if placeholder is not None:
        if not PLACEHOLDER_RE.fullmatch(placeholder):
            raise ValueError("placeholder must look like [TYPE_N]")
        if _row_clash(session, org_id, mapping_id, EntityMapping.placeholder == placeholder):
            raise MappingConflictError(f"placeholder {placeholder} is already used")
        row.placeholder = placeholder

    if original_value is not None:
        new_hash = _hash_value(original_value)
        if _row_clash(session, org_id, mapping_id, EntityMapping.original_value_hash == new_hash):
            raise MappingConflictError("another mapping already holds that value")
        row.original_value_hash = new_hash
        row.original_value_encrypted = _get_fernet().encrypt(original_value.encode()).decode()

    session.add(row)
    session.commit()
    session.refresh(row)
    decrypted = _get_fernet().decrypt(row.original_value_encrypted.encode()).decode()
    return row, decrypted


def delete_mapping(session: Session, org_id: str, mapping_id: str) -> bool:
    row = session.exec(
        select(EntityMapping).where(
            EntityMapping.id == mapping_id, EntityMapping.org_id == org_id
        )
    ).first()
    if row is None:
        return False
    session.delete(row)
    session.commit()
    return True


def _row_clash(session: Session, org_id: str, mapping_id: str, condition) -> bool:
    return (
        session.exec(
            select(EntityMapping).where(
                EntityMapping.org_id == org_id,
                EntityMapping.id != mapping_id,
                condition,
            )
        ).first()
        is not None
    )
