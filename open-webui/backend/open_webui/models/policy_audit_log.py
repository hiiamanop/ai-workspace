import json
import logging
import time
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import BigInteger, Boolean, Column, Integer, Text, func, select
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

# Actions a policy audit entry can record (C3-A).
AUDIT_ACTIONS = ('create', 'update', 'compile', 'deploy', 'rollback', 'delete')


####################
# Policy Audit DB Schema
####################


class PolicyAuditLog(Base):
    __tablename__ = 'policy_audit_log'

    id = Column(Integer, primary_key=True, autoincrement=True)
    policy_id = Column(Text, nullable=False, index=True)
    action = Column(Text, nullable=False)  # one of AUDIT_ACTIONS
    user_id = Column(Text, nullable=False)
    timestamp = Column(BigInteger, nullable=False, index=True)  # epoch ns, matching C1
    before = Column(Text, nullable=True)  # JSON snapshot
    after = Column(Text, nullable=True)  # JSON snapshot
    made_response = Column(Text, nullable=True)  # JSON snapshot (deploy/rollback)
    compile_success = Column(Boolean, nullable=True)
    compile_error = Column(Text, nullable=True)


class PolicyAuditLogModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    policy_id: str
    action: str
    user_id: str
    timestamp: int
    before: Optional[dict] = None  # parsed from TEXT JSON storage
    after: Optional[dict] = None
    made_response: Optional[dict] = None
    compile_success: Optional[bool] = None
    compile_error: Optional[str] = None

    @field_validator('before', 'after', 'made_response', mode='before')
    @classmethod
    def _parse_json_fields(cls, v):
        return json.loads(v) if isinstance(v, str) else v


def _json_dumps(value) -> Optional[str]:
    """Serialize a dict snapshot to JSON text (or None)."""
    return json.dumps(value, default=str) if value is not None else None


async def log_policy_action(
    policy_id: str,
    action: str,
    user_id: str,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    made_response: Optional[dict] = None,
    compile_success: Optional[bool] = None,
    compile_error: Optional[str] = None,
    db: Optional[AsyncSession] = None,
) -> None:
    """Append one immutable audit entry (C3-A FR-A1).

    Never raises: audit logging is secondary to the operation it records, so
    a DB failure here must not turn a successful deploy into a 500.
    """
    try:
        async with get_async_db_context(db) as db:
            entry = PolicyAuditLog(
                policy_id=policy_id,
                action=action,
                user_id=user_id,
                timestamp=int(time.time_ns()),
                before=_json_dumps(before),
                after=_json_dumps(after),
                made_response=_json_dumps(made_response),
                compile_success=compile_success,
                compile_error=compile_error,
            )
            db.add(entry)
            await db.commit()
    except Exception as exc:
        log.error('policy-audit: failed to record %s for %s: %s', action, policy_id, exc)


class PolicyAuditLogTable:
    async def get_for_policy(
        self,
        policy_id: str,
        action: Optional[str] = None,
        skip: int = 0,
        limit: int = 50,
        db: Optional[AsyncSession] = None,
    ) -> tuple[list[PolicyAuditLogModel], int]:
        """Audit entries for a policy, newest first. Returns (entries, total)."""
        async with get_async_db_context(db) as db:
            filters = [PolicyAuditLog.policy_id == policy_id]
            if action:
                filters.append(PolicyAuditLog.action == action)

            count_result = await db.execute(
                select(func.count()).select_from(PolicyAuditLog).where(*filters)
            )
            total = count_result.scalar()

            stmt = (
                select(PolicyAuditLog)
                .where(*filters)
                .order_by(PolicyAuditLog.timestamp.desc(), PolicyAuditLog.id.desc())
                .offset(skip)
                .limit(limit)
            )
            result = await db.execute(stmt)
            entries = [PolicyAuditLogModel.model_validate(e) for e in result.scalars().all()]
            return entries, total


PolicyAuditLogs = PolicyAuditLogTable()
