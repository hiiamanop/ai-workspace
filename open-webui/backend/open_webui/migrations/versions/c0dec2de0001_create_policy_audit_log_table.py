"""Create policy audit log table (C3-A)

Revision ID: c0dec2de0001
Revises: c0dec1de0001
Create Date: 2026-08-13 00:00:00.000000

Immutable append-only trail of every governance action on a policy
(create/update/compile/deploy/rollback/delete) for the C3-A audit feature.
Timestamps are BigInteger epoch-ns, matching the C1 policy table convention.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c0dec2de0001'
down_revision: Union[str, None] = 'c0dec1de0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'policy_audit_log',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False, primary_key=True),
        sa.Column('policy_id', sa.Text(), nullable=False),
        sa.Column('action', sa.Text(), nullable=False),  # create|update|compile|deploy|rollback|delete
        sa.Column('user_id', sa.Text(), nullable=False),
        sa.Column('timestamp', sa.BigInteger(), nullable=False),  # epoch ns
        sa.Column('before', sa.Text(), nullable=True),  # JSON snapshot
        sa.Column('after', sa.Text(), nullable=True),  # JSON snapshot
        sa.Column('made_response', sa.Text(), nullable=True),  # JSON snapshot
        sa.Column('compile_success', sa.Boolean(), nullable=True),
        sa.Column('compile_error', sa.Text(), nullable=True),
    )
    op.create_index('idx_policy_audit_log_policy_id', 'policy_audit_log', ['policy_id'])
    op.create_index('idx_policy_audit_log_timestamp', 'policy_audit_log', ['timestamp'])


def downgrade() -> None:
    op.drop_index('idx_policy_audit_log_timestamp', table_name='policy_audit_log')
    op.drop_index('idx_policy_audit_log_policy_id', table_name='policy_audit_log')
    op.drop_table('policy_audit_log')
