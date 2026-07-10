"""add global colour tint (hue shift) to the mixer

Revision ID: d6f7a8b9c0e1
Revises: c5e6f7a8b9d0
Create Date: 2026-07-11 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d6f7a8b9c0e1"
down_revision: Union[str, None] = "c5e6f7a8b9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("edit_color_tint", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("images", "edit_color_tint")
