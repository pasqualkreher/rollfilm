"""source roots created by an in-place import are not scanned at startup

Revision ID: d1e2f3a4b5c6
Revises: c8e9f0a1b2c3
Create Date: 2026-09-14 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, None] = "c8e9f0a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing roots keep scanning at startup as before.
    op.add_column(
        "source_roots",
        sa.Column("auto_scan", sa.Boolean(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    with op.batch_alter_table("source_roots") as batch:
        batch.drop_column("auto_scan")
