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

from core.privacy.detectors import detect_all
from storage.models import EntityMapping

PLACEHOLDER_RE = re.compile(r"\[([A-Z_]+)_(\d+)\]")


class MissingEncryptionKeyError(RuntimeError):
    pass


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
        placeholder = _get_or_create_placeholder(session, org_id, span.entity_type, span.value)
        result = result[: span.start] + placeholder + result[span.end :]

    return result, len(spans)


def restore(text: str, org_id: str, session: Session) -> str:
    fernet = _get_fernet()

    def _replace(match: re.Match) -> str:
        placeholder = match.group(0)
        mapping = session.exec(
            select(EntityMapping).where(
                EntityMapping.org_id == org_id,
                EntityMapping.placeholder == placeholder,
            )
        ).first()
        if mapping is None:
            return placeholder  # unknown placeholder — leave it as-is
        return fernet.decrypt(mapping.original_value_encrypted.encode()).decode()

    return PLACEHOLDER_RE.sub(_replace, text)
