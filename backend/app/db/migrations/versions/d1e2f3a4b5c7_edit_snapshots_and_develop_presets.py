"""edit_snapshots and develop_presets

Revision ID: d1e2f3a4b5c7
Revises: c0d1e2f3a4b6
Create Date: 2026-10-13 12:00:00.000000

Two tables for the editor. edit_snapshots keeps named moments of one photo's
edit (the whole PATCH /edits payload as one JSON blob, so restoring replays
it through the normal save) and goes with its photo. develop_presets moves
the editor presets out of the browser's storage into the library, each with
the sections of the edit it carries.

Purely additive; nothing existing changes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d1e2f3a4b5c7"
down_revision: Union[str, None] = "c0d1e2f3a4b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "edit_snapshots",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "image_id", sa.String(), sa.ForeignKey("images.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("edits", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_edit_snapshots_image_id", "edit_snapshots", ["image_id"])
    op.create_table(
        "develop_presets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("group_name", sa.String(), nullable=True),
        sa.Column("sections", sa.String(), nullable=False),
        sa.Column("adjustments", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("owner_id", "name"),
    )
    op.create_index("ix_develop_presets_owner_id", "develop_presets", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_develop_presets_owner_id", table_name="develop_presets")
    op.drop_table("develop_presets")
    op.drop_index("ix_edit_snapshots_image_id", table_name="edit_snapshots")
    op.drop_table("edit_snapshots")
