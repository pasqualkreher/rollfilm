"""add blacks/whites tonal + lens distortion edits

Revision ID: a3c4d5e6f7b8
Revises: f2b3c4d5e6a7
Create Date: 2026-07-11 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a3c4d5e6f7b8"
down_revision: Union[str, None] = "f2b3c4d5e6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = ("edit_blacks", "edit_whites", "edit_distortion")


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("images", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("images", name)
