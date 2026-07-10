"""add color mixer + vignette edits to images

Revision ID: f2b3c4d5e6a7
Revises: e1f2a3b4c5d6
Create Date: 2026-07-10 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2b3c4d5e6a7"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Per-hue HSL mixer, stored as a small JSON blob (null = neutral) so we don't
    # need 24 columns; see services/thumbnails.apply_adjustments.
    op.add_column("images", sa.Column("edit_color_mix", sa.Text(), nullable=True))
    # Vignette: -100 darkens the corners, +100 lightens them (0 = off).
    op.add_column("images", sa.Column("edit_vignette", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("images", "edit_vignette")
    op.drop_column("images", "edit_color_mix")
