"""make album and canvas names unique per user

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-09-04 18:00:00.000000

Every photo in an album now carries an "album: <name>" tag, every photo
a canvas holds an "canvas: <name>" tag - so a name has to point at exactly one
album or canvas. The API refuses duplicates from here on; libraries that
already hold two albums (or canvases) sharing a name get the later ones
numbered: "Trip", "Trip (2)", "Trip (3)". Names compare case-insensitively.

The tags themselves are not written here: the app recomputes them from the
membership rows at every startup (see app/services/membership_tags.py).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _dedupe(table: str) -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(f"SELECT id, owner_id, name FROM {table} ORDER BY created_at, id")
    ).fetchall()
    taken: dict[int, set[str]] = {}
    for row_id, owner_id, name in rows:
        owner_names = taken.setdefault(owner_id, set())
        base = (name or "").strip() or ("Album" if table == "albums" else "Canvas")
        candidate = base
        n = 2
        while candidate.lower() in owner_names:
            candidate = f"{base} ({n})"
            n += 1
        owner_names.add(candidate.lower())
        if candidate != name:
            bind.execute(
                sa.text(f"UPDATE {table} SET name = :name WHERE id = :id"),
                {"name": candidate, "id": row_id},
            )


def upgrade() -> None:
    _dedupe("albums")
    _dedupe("canvases")


def downgrade() -> None:
    # The numbered names are as good as any; nothing to undo.
    pass
