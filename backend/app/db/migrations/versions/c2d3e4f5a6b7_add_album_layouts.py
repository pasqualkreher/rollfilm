"""add album_layouts + layout_items (creative canvas layout per album)

Revision ID: c2d3e4f5a6b7
Revises: c1d2e3f4a5b6
Create Date: 2026-08-31 22:00:00.000000

An album can now carry a hand-made layout beside its grid: photos and text
placed freely on either a run of fixed-size pages or one unbounded canvas.
All measurements are millimetres so the design can later be exported to print
without re-interpreting stored numbers.

Purely additive - an album without a row here simply has no canvas yet.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, None] = "c1d2e3f4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "album_layouts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("album_id", sa.String(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("page_mode", sa.String(), nullable=False, server_default="pages"),
        sa.Column("page_width_mm", sa.Float(), nullable=False, server_default="297"),
        sa.Column("page_height_mm", sa.Float(), nullable=False, server_default="210"),
        sa.Column("page_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("background", sa.String(), nullable=False, server_default="#ffffff"),
        sa.Column("show_grid", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("grid_mm", sa.Float(), nullable=False, server_default="10"),
        sa.Column("snap", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["album_id"], ["albums.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("album_id"),
    )
    op.create_index("ix_album_layouts_album_id", "album_layouts", ["album_id"])
    op.create_index("ix_album_layouts_owner_id", "album_layouts", ["owner_id"])

    op.create_table(
        "layout_items",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("layout_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False, server_default="photo"),
        sa.Column("image_id", sa.String(), nullable=True),
        sa.Column("page", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("x_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("y_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("width_mm", sa.Float(), nullable=False, server_default="60"),
        sa.Column("height_mm", sa.Float(), nullable=False, server_default="40"),
        sa.Column("rotation", sa.Float(), nullable=False, server_default="0"),
        sa.Column("z", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_scale", sa.Float(), nullable=False, server_default="1"),
        sa.Column("content_dx", sa.Float(), nullable=False, server_default="0"),
        sa.Column("content_dy", sa.Float(), nullable=False, server_default="0"),
        sa.Column("text", sa.String(), nullable=True),
        sa.Column("style", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["layout_id"], ["album_layouts.id"]),
        sa.ForeignKeyConstraint(["image_id"], ["images.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_layout_items_layout_id", "layout_items", ["layout_id"])
    op.create_index("ix_layout_items_image_id", "layout_items", ["image_id"])


def downgrade() -> None:
    op.drop_index("ix_layout_items_image_id", table_name="layout_items")
    op.drop_index("ix_layout_items_layout_id", table_name="layout_items")
    op.drop_table("layout_items")
    op.drop_index("ix_album_layouts_owner_id", table_name="album_layouts")
    op.drop_index("ix_album_layouts_album_id", table_name="album_layouts")
    op.drop_table("album_layouts")
