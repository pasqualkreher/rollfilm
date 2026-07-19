"""add processed flag to import_staged_files (background analysis: the copy
phase creates rows unprocessed, a worker fills in analysis and flips this)

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-07-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default '1': every row staged before this column existed was
    # fully analyzed synchronously at staging time.
    op.add_column(
        'import_staged_files',
        sa.Column('processed', sa.Boolean(), nullable=False, server_default='1'),
    )


def downgrade() -> None:
    op.drop_column('import_staged_files', 'processed')
