"""an import session can keep its collection folder as a backup

Revision ID: b7d8e9f0a1c2
Revises: a1c2e3f4b5d6
Create Date: 2026-10-03 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7d8e9f0a1c2"
down_revision: Union[str, None] = "a1c2e3f4b5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing sessions keep moving their photos into the library as before.
    op.add_column(
        "import_sessions",
        sa.Column("keep_backup", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    with op.batch_alter_table("import_sessions") as batch:
        batch.drop_column("keep_backup")
