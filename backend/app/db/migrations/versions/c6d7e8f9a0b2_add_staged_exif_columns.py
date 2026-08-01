"""add denormalized EXIF columns to import_staged_files

Revision ID: c6d7e8f9a0b2
Revises: b5c6d7e8f9a1
Create Date: 2026-08-01 12:00:00.000000

The review grid's /files poll used to json.loads every staged file's
exif_json on every poll - real CPU per second on multi-thousand imports. The
fields the grid needs (capture date, camera, dimensions) now live in columns
written at analysis time; exif_json remains the full record used at commit.
Existing staged rows (an import session open across the upgrade) fall back to
exif_json in the API layer, so no backfill is needed for these short-lived
rows.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c6d7e8f9a0b2"
down_revision: Union[str, None] = "b5c6d7e8f9a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("import_staged_files", sa.Column("taken_at", sa.String(), nullable=True))
    op.add_column("import_staged_files", sa.Column("camera_make", sa.String(), nullable=True))
    op.add_column("import_staged_files", sa.Column("camera_model", sa.String(), nullable=True))
    op.add_column("import_staged_files", sa.Column("width", sa.Integer(), nullable=True))
    op.add_column("import_staged_files", sa.Column("height", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("import_staged_files", "height")
    op.drop_column("import_staged_files", "width")
    op.drop_column("import_staged_files", "camera_model")
    op.drop_column("import_staged_files", "camera_make")
    op.drop_column("import_staged_files", "taken_at")
