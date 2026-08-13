"""Add current_version_id to policies (C3-B)

Revision ID: c0dec2de0003
Revises: c0dec2de0002
Create Date: 2026-08-13 00:00:00.000000

Points a policy at its latest policy_versions row (nullable for drafts).
Plain column, no FK constraint: SQLite's ALTER TABLE ADD COLUMN cannot add
FKs, FK enforcement is off by default anyway, and the C1 policy table set
no FK precedent.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c0dec2de0003'
down_revision: Union[str, None] = 'c0dec2de0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('policy', sa.Column('current_version_id', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('policy', 'current_version_id')
