"""a copy session collects its cards in a folder of its own (default: <library>/Import)

Revision ID: f1e2d3c4b5a6
Revises: d2e3f4a5b6c7
Create Date: 2026-09-14 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1e2d3c4b5a6"
down_revision: Union[str, None] = "d2e3f4a5b6c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # NULL = a session from before: it collected in the hidden staging area.
    op.add_column("import_sessions", sa.Column("staging_dir", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("import_sessions") as batch:
        batch.drop_column("staging_dir")
