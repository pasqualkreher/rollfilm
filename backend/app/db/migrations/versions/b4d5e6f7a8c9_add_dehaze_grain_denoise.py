"""add dehaze / grain / denoise effect edits

Revision ID: b4d5e6f7a8c9
Revises: a3c4d5e6f7b8
Create Date: 2026-07-11 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b4d5e6f7a8c9"
down_revision: Union[str, None] = "a3c4d5e6f7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = ("edit_dehaze", "edit_grain", "edit_denoise")


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("images", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("images", name)
