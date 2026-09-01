"""add layout_versions (named canvas snapshots) and the Canvases shelf flags

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-09-01 12:00:00.000000

A canvas can now be kept as a named version ("the draft I liked on Tuesday")
while the working layout keeps autosaving over itself. Each version stores the
whole document as one JSON blob - nobody queries inside a snapshot, and a blob
survives future layout columns without another migration here.

album_layouts grows two flags for the Canvases shelf on the Albums page:
show_in_canvases (opt-in, chosen inside the canvas) and active_version_id (the
version the shelf shows - last kept or last loaded; a plain id on purpose, the
two tables would otherwise reference each other in a circle).

Purely additive; existing layouts stay off the shelf with no versions.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e4f5a6b7c8d9"
down_revision: Union[str, None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "layout_versions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("layout_id", sa.String(), sa.ForeignKey("album_layouts.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("doc", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_layout_versions_layout_id", "layout_versions", ["layout_id"])
    op.add_column(
        "album_layouts",
        sa.Column("show_in_canvases", sa.Boolean(), nullable=False, server_default="0"),
    )
    op.add_column("album_layouts", sa.Column("active_version_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("album_layouts", "active_version_id")
    op.drop_column("album_layouts", "show_in_canvases")
    op.drop_index("ix_layout_versions_layout_id", table_name="layout_versions")
    op.drop_table("layout_versions")
