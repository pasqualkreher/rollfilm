"""make import_staged_files.sha256 nullable (hash moves to analysis)

Revision ID: d7e8f9a0b1c3
Revises: c6d7e8f9a0b2
Create Date: 2026-08-01 14:00:00.000000

The staging copy is now a dumb native kernel copy at full media speed; the
sha256 is computed by the background analysis right after the file lands
(reading from the page cache), together with EXIF/thumbnail/dedup. Until that
analysis runs, the row's sha256 is NULL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7e8f9a0b1c3"
down_revision: Union[str, None] = "c6d7e8f9a0b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("import_staged_files") as batch:
        batch.alter_column("sha256", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("import_staged_files") as batch:
        batch.alter_column("sha256", existing_type=sa.String(), nullable=False)
