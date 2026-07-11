"""add mist (pro-mist diffusion) edit

Revision ID: a0c1d2e3f4b5
Revises: f9b0c1d2e3a4
Create Date: 2026-07-11 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a0c1d2e3f4b5"
down_revision: Union[str, None] = "f9b0c1d2e3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("edit_mist", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("images", "edit_mist")
