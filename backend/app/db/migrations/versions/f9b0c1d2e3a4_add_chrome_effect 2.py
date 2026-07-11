"""add fuji color chrome effect / chrome fx blue

Revision ID: f9b0c1d2e3a4
Revises: e7a8b9c0d1f2
Create Date: 2026-07-11 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f9b0c1d2e3a4"
down_revision: Union[str, None] = "e7a8b9c0d1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("edit_chrome_effect", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("images", sa.Column("edit_chrome_blue", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("images", "edit_chrome_blue")
    op.drop_column("images", "edit_chrome_effect")
