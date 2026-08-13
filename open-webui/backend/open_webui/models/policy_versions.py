import time
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from open_webui.models.policies import Policy
from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, Column, Integer, Text, UniqueConstraint, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession


####################
# Policy Version DB Schema
####################


class PolicyVersion(Base):
    __tablename__ = 'policy_versions'

    __table_args__ = (
        UniqueConstraint('policy_id', 'version_number', name='uq_policy_versions_policy_id_version_number'),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    policy_id = Column(Text, nullable=False, index=True)
    version_number = Column(Integer, nullable=False)  # per-policy, starts at 1
    rego_content = Column(Text, nullable=False)  # deployed Rego, immutable
    deployed_by = Column(Text, nullable=False)
    deployed_at = Column(BigInteger, nullable=False)  # epoch ns


class PolicyVersionModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    policy_id: str
    version_number: int
    rego_content: str
    deployed_by: str
    deployed_at: int


class PolicyVersionTable:
    async def create_version(
        self,
        policy_id: str,
        rego_content: str,
        deployed_by: str,
        db: Optional[AsyncSession] = None,
    ) -> Optional[PolicyVersionModel]:
        """Create the next immutable version row and point the policy at it (C3-B FR-B1/B2).

        Both writes happen in one transaction. Called only after MADE
        accepted the Rego — failed deploys must never create version rows.
        The deploy race guard (reserve_for_deploy) serializes deploys of the
        same policy, so max+1 cannot collide.
        """
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(func.max(PolicyVersion.version_number)).where(PolicyVersion.policy_id == policy_id)
            )
            next_number = (result.scalar() or 0) + 1

            version = PolicyVersion(
                policy_id=policy_id,
                version_number=next_number,
                rego_content=rego_content,
                deployed_by=deployed_by,
                deployed_at=int(time.time_ns()),
            )
            db.add(version)
            await db.flush()  # assign version.id
            await db.execute(update(Policy).where(Policy.id == policy_id).values(current_version_id=version.id))
            await db.commit()
            return PolicyVersionModel.model_validate(version)

    async def get_versions(
        self,
        policy_id: str,
        skip: int = 0,
        limit: int = 50,
        db: Optional[AsyncSession] = None,
    ) -> tuple[list[PolicyVersionModel], int]:
        """All versions for a policy, newest first. Returns (versions, total)."""
        async with get_async_db_context(db) as db:
            count_result = await db.execute(
                select(func.count()).select_from(PolicyVersion).where(PolicyVersion.policy_id == policy_id)
            )
            total = count_result.scalar()

            stmt = (
                select(PolicyVersion)
                .where(PolicyVersion.policy_id == policy_id)
                .order_by(PolicyVersion.version_number.desc())
                .offset(skip)
                .limit(limit)
            )
            result = await db.execute(stmt)
            versions = [PolicyVersionModel.model_validate(v) for v in result.scalars().all()]
            return versions, total


PolicyVersions = PolicyVersionTable()
