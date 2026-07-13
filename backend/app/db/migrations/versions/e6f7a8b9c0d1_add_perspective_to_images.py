"""add perspective (keystone) to images

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-07-13 00:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e6f7a8b9c0d1'
down_revision: Union[str, None] = 'd5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('images', sa.Column('edit_persp_h', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('images', sa.Column('edit_persp_v', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('images', 'edit_persp_v')
    op.drop_column('images', 'edit_persp_h')
