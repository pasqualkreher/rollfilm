"""Keep the membership tags in step with albums and canvases.

A photo in an album carries "album" and "album: <album name>"; a photo
a canvas holds carries "canvas" and "canvas: <canvas name>". The tags are
derived, never edited: whenever albums, canvases or their photos change, the
caller runs `sync_membership_tags` and the whole set is recomputed from the
membership rows and diffed against what the tag links say.

Recomputing rather than patching keeps one code path for every event - adding
photos, renaming, deleting, saving a layout, resetting metadata, merging a
library, restoring a backup, and the app's own startup, which uses it to
backfill libraries from before the tags existed. The work is proportional to
the membership rows and the managed tag links, not to the library.

Only explicit membership counts: an album's tag rule (photos joining via
their tags) is left alone, because those photos already carry the tags the
rule names and feeding derived tags back into tag-driven membership would
loop.
"""
from collections import defaultdict

from sqlalchemy.orm import Session

from app.db.models import (
    Album,
    AlbumImage,
    Canvas,
    CanvasImage,
    CanvasLayout,
    ImageTag,
    LayoutItem,
    Tag,
)
from app.services.auto_tags import (
    IN_ALBUM_TAG,
    IN_CANVAS_TAG,
    album_tag,
    canvas_tag,
    membership_tag_criterion,
)


def _desired(db: Session, owner_id: int) -> dict[str, set[str]]:
    """Tag name -> the ids of the photos that should carry it. Empty albums
    and canvases have no entry: a tag with nothing on it is clutter."""
    wanted: dict[str, set[str]] = defaultdict(set)

    album_names = {
        id: name for id, name in db.query(Album.id, Album.name).filter(Album.owner_id == owner_id)
    }
    for album_id, image_id in (
        db.query(AlbumImage.album_id, AlbumImage.image_id)
        .join(Album, Album.id == AlbumImage.album_id)
        .filter(Album.owner_id == owner_id)
    ):
        wanted[album_tag(album_names[album_id])].add(image_id)
        wanted[IN_ALBUM_TAG].add(image_id)

    canvas_names = {
        id: name
        for id, name in db.query(Canvas.id, Canvas.name).filter(Canvas.owner_id == owner_id)
    }
    # A canvas "holds" a photo when it is in the filmstrip or placed on a page -
    # the same union the canvas's own images endpoint serves.
    members = (
        db.query(CanvasImage.canvas_id, CanvasImage.image_id)
        .join(Canvas, Canvas.id == CanvasImage.canvas_id)
        .filter(Canvas.owner_id == owner_id)
    )
    placed = (
        db.query(CanvasLayout.canvas_id, LayoutItem.image_id)
        .join(LayoutItem, LayoutItem.layout_id == CanvasLayout.id)
        .filter(CanvasLayout.owner_id == owner_id, LayoutItem.image_id.isnot(None))
    )
    for canvas_id, image_id in list(members) + list(placed):
        name = canvas_names.get(canvas_id)
        if name is None:
            continue
        wanted[canvas_tag(name)].add(image_id)
        wanted[IN_CANVAS_TAG].add(image_id)

    return {name: ids for name, ids in wanted.items() if ids}


def sync_membership_tags(db: Session, owner_id: int) -> None:
    """Bring the membership tags of one user in line with their albums and
    canvases. Flushes; the caller commits."""
    wanted = _desired(db, owner_id)

    managed = {
        tag.name: tag
        for tag in db.query(Tag).filter(Tag.owner_id == owner_id, membership_tag_criterion())
    }
    for name in wanted:
        if name not in managed:
            tag = Tag(owner_id=owner_id, name=name)
            db.add(tag)
            managed[name] = tag
    db.flush()

    # A tag whose album or canvas is gone (or renamed, or emptied) goes with
    # everything on it.
    stale_ids = [tag.id for name, tag in managed.items() if name not in wanted]
    if stale_ids:
        db.query(ImageTag).filter(ImageTag.tag_id.in_(stale_ids)).delete(synchronize_session=False)
        db.query(Tag).filter(Tag.id.in_(stale_ids)).delete(synchronize_session=False)

    live = {name: tag for name, tag in managed.items() if name in wanted}
    if not live:
        db.flush()
        return
    current: dict[str, set[str]] = defaultdict(set)
    by_id = {tag.id: name for name, tag in live.items()}
    for link_tag_id, image_id in db.query(ImageTag.tag_id, ImageTag.image_id).filter(
        ImageTag.tag_id.in_(list(by_id))
    ):
        current[by_id[link_tag_id]].add(image_id)

    for name, tag in live.items():
        have = current.get(name, set())
        need = wanted[name]
        for image_id in need - have:
            db.add(ImageTag(image_id=image_id, tag_id=tag.id))
        gone = have - need
        if gone:
            db.query(ImageTag).filter(
                ImageTag.tag_id == tag.id, ImageTag.image_id.in_(gone)
            ).delete(synchronize_session=False)
    db.flush()
