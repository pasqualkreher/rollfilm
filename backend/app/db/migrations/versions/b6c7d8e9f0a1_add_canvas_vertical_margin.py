"""add canvas top/bottom margin

Revision ID: b6c7d8e9f0a1
Revises: e5f6a7b8c9d0
Create Date: 2026-09-11 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b6c7d8e9f0a1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The page margin splits into left/right (the existing margin_mm) and
    # top/bottom (new). Every existing canvas keeps the margin it had on all
    # four sides, so nothing moves or snaps differently after the upgrade.
    op.add_column(
        "canvas_layouts",
        sa.Column("margin_y_mm", sa.Float(), nullable=False, server_default="12"),
    )
    op.execute("UPDATE canvas_layouts SET margin_y_mm = margin_mm")


def downgrade() -> None:
    op.drop_column("canvas_layouts", "margin_y_mm")
