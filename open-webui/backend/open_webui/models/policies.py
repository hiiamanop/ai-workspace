import time
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, Text, BigInteger, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession


####################
# Policy DB Schema
####################


class Policy(Base):
    __tablename__ = 'policy'

    id = Column(Text, primary_key=True, unique=True)
    name = Column(Text, nullable=False)
    markdown_content = Column(Text, nullable=False)
    compiled_rego = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default='draft')  # 'draft' | 'active'
    active_rego = Column(Text, nullable=True)
    previous_rego = Column(Text, nullable=True)
    created_by = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    deployed_at = Column(BigInteger, nullable=True)
    last_error = Column(Text, nullable=True)
    updated_at = Column(BigInteger, nullable=False)


class PolicyModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    markdown_content: str
    compiled_rego: Optional[str] = None
    status: str = 'draft'
    active_rego: Optional[str] = None
    previous_rego: Optional[str] = None
    created_by: str
    created_at: int  # timestamp in epoch ns
    deployed_at: Optional[int] = None
    last_error: Optional[str] = None
    updated_at: int

    @property
    def is_draft(self) -> bool:
        return self.status == 'draft'

    @property
    def is_active(self) -> bool:
        return self.status == 'active'

    @property
    def can_edit(self) -> bool:
        return self.is_draft


class PolicyListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    status: str
    created_by: str
    created_at: int
    deployed_at: Optional[int] = None


class PolicyListResponse(BaseModel):
    policies: list[PolicyListItem]
    total: int


####################
# Forms
####################


class PolicyForm(BaseModel):
    id: str
    name: str
    markdown_content: str


class PolicyUpdateForm(BaseModel):
    markdown_content: str


class PolicyTable:
    async def insert_new_policy(
        self, user_id: str, form_data: PolicyForm, db: Optional[AsyncSession] = None
    ) -> Optional[PolicyModel]:
        async with get_async_db_context(db) as db:
            now = int(time.time_ns())
            policy = Policy(
                **form_data.model_dump(),
                created_by=user_id,
                created_at=now,
                updated_at=now,
            )
            db.add(policy)
            await db.commit()
            return PolicyModel.model_validate(policy)

    async def get_policies(
        self,
        status: Optional[str] = None,
        skip: int = 0,
        limit: int = 50,
        db: Optional[AsyncSession] = None,
    ) -> PolicyListResponse:
        async with get_async_db_context(db) as db:
            stmt = select(Policy).order_by(Policy.updated_at.desc())
            if status:
                stmt = stmt.filter(Policy.status == status)

            # Count BEFORE pagination
            count_result = await db.execute(select(func.count()).select_from(stmt.subquery()))
            total = count_result.scalar()
            result = await db.execute(stmt.offset(skip).limit(limit))
            policies = result.scalars().all()
            return PolicyListResponse(
                policies=[PolicyListItem.model_validate(p) for p in policies],
                total=total,
            )

    async def get_policy_by_id(self, id: str, db: Optional[AsyncSession] = None) -> Optional[PolicyModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Policy).filter(Policy.id == id))
            policy = result.scalars().first()
            return PolicyModel.model_validate(policy) if policy else None

    async def update_policy_markdown(
        self, id: str, form_data: PolicyUpdateForm, db: Optional[AsyncSession] = None
    ) -> Optional[PolicyModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Policy).filter(Policy.id == id))
            policy = result.scalars().first()
            if not policy:
                return None
            policy.markdown_content = form_data.markdown_content
            policy.updated_at = int(time.time_ns())
            await db.commit()
            return PolicyModel.model_validate(policy)

    async def delete_policy_by_id(self, id: str, db: Optional[AsyncSession] = None) -> bool:
        try:
            async with get_async_db_context(db) as db:
                await db.execute(delete(Policy).filter(Policy.id == id))
                await db.commit()
                return True
        except Exception:
            return False

    async def save_compiled_rego(
        self, id: str, compiled_rego: str, db: Optional[AsyncSession] = None
    ) -> Optional[PolicyModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Policy).filter(Policy.id == id))
            policy = result.scalars().first()
            if not policy:
                return None
            policy.compiled_rego = compiled_rego
            policy.updated_at = int(time.time_ns())
            await db.commit()
            return PolicyModel.model_validate(policy)

    async def reserve_for_deploy(self, id: str, db: Optional[AsyncSession] = None) -> bool:
        """Atomically claim a draft policy for deployment (draft stays draft).

        The conditional UPDATE is the deploy lock: with SQLite's write lock,
        only one concurrent deploy of the same policy can pass this, so a
        second one gets 400 instead of clobbering MADE. Crash mid-deploy
        leaves status='draft' — retryable, no stuck states.
        """
        async with get_async_db_context(db) as db:
            result = await db.execute(
                update(Policy)
                .where(Policy.id == id, Policy.status == 'draft')
                .values(updated_at=int(time.time_ns()))
            )
            await db.commit()
            return result.rowcount > 0

    async def update_deploy_state(
        self,
        id: str,
        *,
        status: Optional[str] = None,
        active_rego: Optional[str] = None,
        previous_rego: Optional[str] = None,
        deployed_at: Optional[int] = None,
        last_error: Optional[str] = None,
        clear_error: bool = False,
        clear_previous: bool = False,
        db: Optional[AsyncSession] = None,
    ) -> Optional[PolicyModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Policy).filter(Policy.id == id))
            policy = result.scalars().first()
            if not policy:
                return None
            if status is not None:
                policy.status = status
            if active_rego is not None:
                policy.active_rego = active_rego
            if previous_rego is not None:
                policy.previous_rego = previous_rego
            if clear_previous:
                policy.previous_rego = None
            if deployed_at is not None:
                policy.deployed_at = deployed_at
            if last_error is not None:
                policy.last_error = last_error
            if clear_error:
                policy.last_error = None
            policy.updated_at = int(time.time_ns())
            await db.commit()
            return PolicyModel.model_validate(policy)


Policies = PolicyTable()
