"""drop the short-lived import_sessions.destination column where it was applied

Revision ID: f2e3d4c5b6a7
Revises: f1e2d3c4b5a6
Create Date: 2026-09-14 12:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2e3d4c5b6a7"
down_revision: Union[str, None] = "f1e2d3c4b5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # An earlier build of revision f1e2d3c4b5a6 added `destination` instead of
    # `staging_dir`; a database that ran that build has both to fix up.
    bind = op.get_bind()
    columns = {row[1] for row in bind.execute(sa.text("PRAGMA table_info(import_sessions)"))}
    if "destination" in columns:
        with op.batch_alter_table("import_sessions") as batch:
            batch.drop_column("destination")
    if "staging_dir" not in columns:
        op.add_column("import_sessions", sa.Column("staging_dir", sa.String(), nullable=True))


def downgrade() -> None:
    pass
