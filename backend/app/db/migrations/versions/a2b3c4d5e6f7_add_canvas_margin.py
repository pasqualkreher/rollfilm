"""add canvas page margin

Revision ID: a2b3c4d5e6f7
Revises: f5a6b7c8d9e0
Create Date: 2026-09-04 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 12mm matches the margin the auto-layout has always used, so existing
    # canvases keep flowing photos exactly where they used to.
    op.add_column(
        "canvas_layouts",
        sa.Column("margin_mm", sa.Float(), nullable=False, server_default="12"),
    )


def downgrade() -> None:
    op.drop_column("canvas_layouts", "margin_mm")
