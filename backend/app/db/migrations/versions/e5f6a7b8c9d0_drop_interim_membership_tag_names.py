"""drop the interim "in album" / "in canvas" membership tag names

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-09-04 20:00:00.000000

The membership tags were briefly written as "in album", "in album: <name>",
"in canvas" and "in canvas: <name>" before settling on "album", "album: <name>",
"canvas" and "canvas: <name>". A library that ran that interim build keeps the
old rows as ordinary-looking tags nothing maintains any more; this drops them
(links included). The current names are recomputed from the album and canvas
memberships at the next startup, so nothing is lost.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LEGACY = (
    "name = 'in album' OR name = 'in canvas' "
    "OR name LIKE 'in album: %' OR name LIKE 'in canvas: %'"
)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(f"DELETE FROM image_tags WHERE tag_id IN (SELECT id FROM tags WHERE {_LEGACY})")
    )
    bind.execute(sa.text(f"DELETE FROM tags WHERE {_LEGACY}"))


def downgrade() -> None:
    # The interim names are gone for good; the current ones are derived anyway.
    pass
