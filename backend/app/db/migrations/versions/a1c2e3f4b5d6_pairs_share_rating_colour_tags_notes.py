"""a RAW+JPEG pair carries the same stars, colour label, tags and notes on both files

Revision ID: a1c2e3f4b5d6
Revises: f2e3d4c5b6a7
Create Date: 2026-10-01 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1c2e3f4b5d6"
down_revision: Union[str, None] = "f2e3d4c5b6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# A pair, seen from `images` (the row being written) to its partner `p`: linked
# both ways, same owner, and on the same side of the Trash - a half that was
# thrown away is no longer part of the pair.
_PARTNER = """
    p.id = images.paired_image_id
    AND p.paired_image_id = images.id
    AND p.owner_id = images.owner_id
    AND (p.deleted_at IS NULL) = (images.deleted_at IS NULL)
"""

# The app-managed tags (app/services/auto_tags.py) describe one file - "edit",
# "album: x" - and are kept in step by their own code; they are not shared.
_HAND_TAG = """
    lower(t.name) NOT IN ('edit', 'edit copy', 'virtual copy', 'canvas artifact', 'album', 'canvas')
    AND lower(t.name) NOT LIKE 'album: %'
    AND lower(t.name) NOT LIKE 'canvas: %'
"""


def unify_pairs(bind) -> None:
    """Stars, colours and tags used to reach the partner only when the view
    merged pairs (tags never did), so existing pairs can disagree. From now on
    every change is written to both halves; this brings the old rows in line
    without losing anything a user set: the higher rating wins, a colour beats
    no colour (two different colours: the JPEG's, the half the merged grid
    shows), each half gets the other's hand-given tags, and notes are copied
    to the half without any (two different notes: both, the JPEG's first)."""
    # Notes first, while both halves still hold their own text: the pair's
    # note is computed once per pair from the two originals.
    pairs = bind.execute(sa.text("""
        SELECT j.id, r.id, j.description, r.description
        FROM images j JOIN images r
          ON r.id = j.paired_image_id AND r.paired_image_id = j.id
         AND r.owner_id = j.owner_id
         AND (r.deleted_at IS NULL) = (j.deleted_at IS NULL)
        WHERE (j.file_type != 'raw' AND r.file_type = 'raw'
               OR (j.file_type = 'raw') = (r.file_type = 'raw') AND j.id < r.id)
          AND COALESCE(j.description, '') != COALESCE(r.description, '')
    """)).fetchall()
    for first_id, second_id, first, second in pairs:
        note = "\n\n".join(text for text in (first, second) if text and text.strip())
        bind.execute(
            sa.text("UPDATE images SET description = :note WHERE id IN (:a, :b)"),
            {"note": note or None, "a": first_id, "b": second_id},
        )
    bind.execute(sa.text(f"""
        UPDATE images SET rating = (SELECT p.rating FROM images p WHERE {_PARTNER})
        WHERE EXISTS (
            SELECT 1 FROM images p
            WHERE {_PARTNER} AND COALESCE(p.rating, 0) > COALESCE(images.rating, 0)
        )
    """))
    bind.execute(sa.text(f"""
        UPDATE images SET color_label = (SELECT p.color_label FROM images p WHERE {_PARTNER})
        WHERE COALESCE(color_label, 'none') = 'none'
        AND EXISTS (
            SELECT 1 FROM images p
            WHERE {_PARTNER} AND COALESCE(p.color_label, 'none') != 'none'
        )
    """))
    bind.execute(sa.text(f"""
        UPDATE images SET color_label = (SELECT p.color_label FROM images p WHERE {_PARTNER})
        WHERE file_type = 'raw'
        AND EXISTS (
            SELECT 1 FROM images p
            WHERE {_PARTNER} AND p.file_type != 'raw'
            AND COALESCE(p.color_label, 'none') != 'none'
            AND p.color_label != images.color_label
        )
    """))
    bind.execute(sa.text(f"""
        INSERT INTO image_tags (image_id, tag_id)
        SELECT images.id, it.tag_id
        FROM images
        JOIN images p ON {_PARTNER}
        JOIN image_tags it ON it.image_id = p.id
        JOIN tags t ON t.id = it.tag_id
        WHERE {_HAND_TAG}
        AND NOT EXISTS (
            SELECT 1 FROM image_tags mine
            WHERE mine.image_id = images.id AND mine.tag_id = it.tag_id
        )
    """))


def upgrade() -> None:
    unify_pairs(op.get_bind())


def downgrade() -> None:
    pass
