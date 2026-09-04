"""rename the "canvas edit" auto tag to "virtual copy"

Revision ID: c3d4e5f6a7b8
Revises: a2b3c4d5e6f7
Create Date: 2026-09-04 15:00:00.000000

The app's name for a second library entry sharing another photo's file is now
"virtual copy" everywhere (Save copy offers one, not just the canvas), so the
auto-managed tag follows. Existing libraries get their tag rows renamed here;
a library that already has a hand-made "virtual copy" tag has the old tag's
photos folded into it instead, so no photo loses the marker.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "a2b3c4d5e6f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _rename(old: str, new: str) -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, owner_id FROM tags WHERE name = :old"), {"old": old}).fetchall()
    for old_id, owner_id in rows:
        existing = bind.execute(
            sa.text("SELECT id FROM tags WHERE owner_id = :owner AND name = :new"),
            {"owner": owner_id, "new": new},
        ).scalar()
        if existing is None:
            bind.execute(sa.text("UPDATE tags SET name = :new WHERE id = :id"), {"new": new, "id": old_id})
            continue
        # Fold the old tag's links into the existing one, skipping photos that
        # already carry it, then drop the old tag.
        bind.execute(
            sa.text(
                "UPDATE image_tags SET tag_id = :new_id WHERE tag_id = :old_id "
                "AND image_id NOT IN (SELECT image_id FROM image_tags WHERE tag_id = :new_id)"
            ),
            {"new_id": existing, "old_id": old_id},
        )
        bind.execute(sa.text("DELETE FROM image_tags WHERE tag_id = :old_id"), {"old_id": old_id})
        bind.execute(sa.text("DELETE FROM tags WHERE id = :old_id"), {"old_id": old_id})


def upgrade() -> None:
    _rename("canvas edit", "virtual copy")


def downgrade() -> None:
    _rename("virtual copy", "canvas edit")
