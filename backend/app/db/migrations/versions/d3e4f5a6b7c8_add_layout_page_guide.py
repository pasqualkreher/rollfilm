"""add album_layouts.show_page_guide (page outlines on the free canvas)

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-09-01 12:00:00.000000

The free canvas can now draw the outline of the sheets a design would be cut
into. It is a per-layout editing aid like show_grid and snap, so it is stored
with the layout rather than as a global preference: one album is a pinboard and
another is a book, and they want different aids.

Purely additive; existing layouts default to off.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "album_layouts",
        sa.Column("show_page_guide", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("album_layouts", "show_page_guide")
