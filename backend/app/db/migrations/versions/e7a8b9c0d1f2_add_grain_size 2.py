"""add grain size

Revision ID: e7a8b9c0d1f2
Revises: d6f7a8b9c0e1
Create Date: 2026-07-11 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e7a8b9c0d1f2"
down_revision: Union[str, None] = "d6f7a8b9c0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("edit_grain_size", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("images", "edit_grain_size")
