"""Create policy versions table (C3-B)

Revision ID: c0dec2de0002
Revises: c0dec2de0001
Create Date: 2026-08-13 00:00:00.000000

Immutable changelog of successfully deployed Rego (C3-B). One row per
successful deploy; version numbers are per-policy and start at 1.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c0dec2de0002'
down_revision: Union[str, None] = 'c0dec2de0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'policy_versions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False, primary_key=True),
        sa.Column('policy_id', sa.Text(), nullable=False),
        sa.Column('version_number', sa.Integer(), nullable=False),
        sa.Column('rego_content', sa.Text(), nullable=False),
        sa.Column('deployed_by', sa.Text(), nullable=False),
        sa.Column('deployed_at', sa.BigInteger(), nullable=False),  # epoch ns
        sa.UniqueConstraint('policy_id', 'version_number', name='uq_policy_versions_policy_id_version_number'),
    )
    op.create_index('idx_policy_versions_policy_id', 'policy_versions', ['policy_id'])


def downgrade() -> None:
    op.drop_index('idx_policy_versions_policy_id', table_name='policy_versions')
    op.drop_table('policy_versions')
