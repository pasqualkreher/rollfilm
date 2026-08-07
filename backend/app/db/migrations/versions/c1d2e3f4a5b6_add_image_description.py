"""add images.description (free-text note written in the lightbox)

Revision ID: c1d2e3f4a5b6
Revises: d7e8f9a0b1c3
Create Date: 2026-08-07 10:00:00.000000

A per-photo description the user types in the detail view. Lives in the
database only - the original file is never rewritten, same as every other
edit in this app.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, None] = "d7e8f9a0b1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("description", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("images", "description")
