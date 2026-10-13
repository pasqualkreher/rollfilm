"""images.missing_since: a photo whose file was not found stays, marked

Revision ID: b9c0d1e2f3a4
Revises: d9e0f1a2b3c4
Create Date: 2026-10-12 21:00:00.000000

The library sync used to remove the row of every managed file it could not
find - with the photo's stars, tags, albums and edits. A drive that was not
mounted, a folder moved in Finder, a permissions hiccup: all of them looked
like "deleted". Now the row stays and carries the moment it went missing;
the next sync that finds the file again clears it, and removing the entries
is a step the user takes (maintenance.remove_missing_images).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b9c0d1e2f3a4"
down_revision: Union[str, None] = "d9e0f1a2b3c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("missing_since", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_images_missing_since", "images", ["missing_since"])


def downgrade() -> None:
    op.drop_index("ix_images_missing_since", table_name="images")
    op.drop_column("images", "missing_since")
