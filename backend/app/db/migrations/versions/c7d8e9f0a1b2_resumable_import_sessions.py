"""resumable import sessions: source folder + volume, per-file source path, imported flag

Revision ID: c7d8e9f0a1b2
Revises: b6c7d8e9f0a1
Create Date: 2026-09-11 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7d8e9f0a1b2"
down_revision: Union[str, None] = "b6c7d8e9f0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # All nullable / defaulted: sessions staged before this simply aren't
    # resumable from their source (no folder recorded), but stay reviewable.
    op.add_column("import_sessions", sa.Column("source_root", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_mount", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_uuid", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("volume_name", sa.String(), nullable=True))
    op.add_column("import_sessions", sa.Column("source_file_count", sa.Integer(), nullable=True))
    op.add_column(
        "import_sessions", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("import_staged_files", sa.Column("source_relpath", sa.String(), nullable=True))
    op.add_column("import_staged_files", sa.Column("source_size", sa.Integer(), nullable=True))
    op.add_column(
        "import_staged_files",
        sa.Column("imported", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("import_staged_files", "imported")
    op.drop_column("import_staged_files", "source_size")
    op.drop_column("import_staged_files", "source_relpath")
    op.drop_column("import_sessions", "updated_at")
    op.drop_column("import_sessions", "source_file_count")
    op.drop_column("import_sessions", "volume_name")
    op.drop_column("import_sessions", "volume_uuid")
    op.drop_column("import_sessions", "volume_mount")
    op.drop_column("import_sessions", "source_root")
