"""add flip and straighten to images

Revision ID: d5e6f7a8b9c0
Revises: b1c2d3e4f5a6
Create Date: 2026-07-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default so this is safe against a non-empty images table (this runs
    # against real libraries that may already have committed photos).
    op.add_column('images', sa.Column('edit_flip_h', sa.Boolean(), nullable=False, server_default='0'))
    op.add_column('images', sa.Column('edit_flip_v', sa.Boolean(), nullable=False, server_default='0'))
    op.add_column('images', sa.Column('edit_straighten', sa.Float(), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('images', 'edit_straighten')
    op.drop_column('images', 'edit_flip_v')
    op.drop_column('images', 'edit_flip_h')
