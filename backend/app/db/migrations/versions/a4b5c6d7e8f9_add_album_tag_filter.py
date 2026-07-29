"""add albums.tag_filter (tag-rule album membership)

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-07-29 12:00:00.000000

An album can now carry a list of tag names (stored as JSON): photos with any
of those tags count as members automatically, alongside the manually added
ones. NULL = a plain manual album, exactly as before.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("albums", sa.Column("tag_filter", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("albums", "tag_filter")
