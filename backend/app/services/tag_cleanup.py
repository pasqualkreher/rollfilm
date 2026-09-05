"""Tags nobody carries go away on their own.

A tag exists because a photo carries it. Once the last photo drops it (retagged,
reset, trashed for good, left an album or canvas) the row would only linger in
the filter list and the autocomplete, so every path that removes tag links
calls `prune_unused_tags` and the empty rows go with the links. The app's own
tags ("edit", "virtual copy", the membership tags...) are no exception: they
are created again the moment a photo needs one.
"""
from sqlalchemy.orm import Session

from app.db.models import ImageTag, Tag


def prune_unused_tags(db: Session, owner_id: int) -> list[str]:
    """Delete this user's tags with no photo on them. Flushes first so links
    the caller just removed count as gone; returns the names dropped."""
    db.flush()
    used = db.query(ImageTag.tag_id).distinct().subquery()
    unused = (
        db.query(Tag)
        .filter(Tag.owner_id == owner_id, Tag.id.notin_(used.select()))
        .all()
    )
    names = sorted(tag.name for tag in unused)
    for tag in unused:
        db.delete(tag)
    if unused:
        db.flush()
    return names
