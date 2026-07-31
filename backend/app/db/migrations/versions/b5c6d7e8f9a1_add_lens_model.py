"""add images.lens_model (lens read from EXIF)

Revision ID: b5c6d7e8f9a1
Revises: a4b5c6d7e8f9
Create Date: 2026-07-31 12:00:00.000000

The lens name (EXIF LensModel / XMP Lens / decoded LensID) is now read at
import time and filterable in the library. Existing rows are backfilled once
in the background on app start (see maintenance.backfill_lens_metadata).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b5c6d7e8f9a1"
down_revision: Union[str, None] = "a4b5c6d7e8f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("lens_model", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("images", "lens_model")
