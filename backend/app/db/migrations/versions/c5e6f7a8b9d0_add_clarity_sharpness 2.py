"""add clarity + sharpness detail edits

Revision ID: c5e6f7a8b9d0
Revises: b4d5e6f7a8c9
Create Date: 2026-07-11 11:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c5e6f7a8b9d0"
down_revision: Union[str, None] = "b4d5e6f7a8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = ("edit_clarity", "edit_sharpness")


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("images", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("images", name)
