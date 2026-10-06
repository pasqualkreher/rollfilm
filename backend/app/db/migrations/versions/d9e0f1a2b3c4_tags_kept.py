"""tags.kept: a tag from an imported keyword list stays without photos

Revision ID: d9e0f1a2b3c4
Revises: c8e9f0a1b2d3
Create Date: 2026-10-06 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, None] = "c8e9f0a1b2d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tags",
        sa.Column("kept", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("tags", "kept")
