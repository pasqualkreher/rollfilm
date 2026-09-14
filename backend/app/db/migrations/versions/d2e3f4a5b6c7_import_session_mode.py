"""an import session copies into the library or references the originals in place

Revision ID: d2e3f4a5b6c7
Revises: d1e2f3a4b5c6
Create Date: 2026-09-14 10:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d2e3f4a5b6c7"
down_revision: Union[str, None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Every session so far copied its files into the library.
    op.add_column(
        "import_sessions",
        sa.Column("mode", sa.String(), nullable=False, server_default="copy"),
    )


def downgrade() -> None:
    with op.batch_alter_table("import_sessions") as batch:
        batch.drop_column("mode")
