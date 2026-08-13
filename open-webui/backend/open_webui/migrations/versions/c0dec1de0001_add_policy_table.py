"""Add policy table

Revision ID: c0dec1de0001
Revises: f0bd01a18a3d
Create Date: 2026-08-13 00:00:00.000000

Admin-authored governance policies (C1 backend): Markdown source, compiled
Rego, deployment state for MADE, with previous-version backup for rollback.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c0dec1de0001'
down_revision: Union[str, None] = 'f0bd01a18a3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'policy',
        sa.Column('id', sa.Text(), nullable=False, primary_key=True),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('markdown_content', sa.Text(), nullable=False),
        sa.Column('compiled_rego', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='draft'),
        sa.Column('active_rego', sa.Text(), nullable=True),
        sa.Column('previous_rego', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=False),
        sa.Column('created_at', sa.BigInteger(), nullable=False),
        sa.Column('deployed_at', sa.BigInteger(), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('updated_at', sa.BigInteger(), nullable=False),
    )
    op.create_index('idx_policy_status', 'policy', ['status'])
    op.create_index('idx_policy_created_by', 'policy', ['created_by'])


def downgrade() -> None:
    op.drop_index('idx_policy_created_by', table_name='policy')
    op.drop_index('idx_policy_status', table_name='policy')
    op.drop_table('policy')
