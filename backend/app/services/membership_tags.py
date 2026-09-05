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

One tag rides on the diff rather than on the membership rows: a virtual copy
that leaves its last canvas (frame deleted, taken off the filmstrip, canvas
deleted) is tagged "canvas artifact", because the canvas is what minted the
copy and without the canvas tags nothing would say so. A copy back on any
canvas drops the tag again. It has to be a transition, not a recomputation -
"was once on a canvas" is not something the membership rows remember.
"""
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db.models import (
    Album,
    AlbumImage,
    Canvas,
    CanvasImage,
    CanvasLayout,
    Image,
    ImageTag,
    LayoutItem,
    Tag,
)
from app.services.auto_tags import (
    CANVAS_ARTIFACT_TAG,
    IN_ALBUM_TAG,
    IN_CANVAS_TAG,
    album_tag,
    canvas_tag,
    membership_tag_criterion,
)
from app.services.tag_cleanup import prune_unused_tags


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
    # The app's sessions don't autoflush: the membership rows the caller just
    # added or re-pointed are still pending, and the queries below would read
    # the table as it was before them - tagging nothing for a photo that was
    # just placed. Write them out first.
    db.flush()
    _adopt_placed_copies(db, owner_id)
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

    # Who was on a canvas before this run - read before the stale links go,
    # so a canvas emptied or deleted still shows who it used to hold.
    on_canvas_before: set[str] = set()
    if IN_CANVAS_TAG in managed:
        on_canvas_before = {
            image_id
            for (image_id,) in db.query(ImageTag.image_id).filter(
                ImageTag.tag_id == managed[IN_CANVAS_TAG].id
            )
        }
    on_canvas_after = wanted.get(IN_CANVAS_TAG, set())

    # A tag whose album or canvas is gone (or renamed, or emptied) goes with
    # everything on it.
    stale_ids = [tag.id for name, tag in managed.items() if name not in wanted]
    if stale_ids:
        db.query(ImageTag).filter(ImageTag.tag_id.in_(stale_ids)).delete(synchronize_session=False)
        db.query(Tag).filter(Tag.id.in_(stale_ids)).delete(synchronize_session=False)

    live = {name: tag for name, tag in managed.items() if name in wanted}
    if not live:
        _sync_canvas_artifacts(db, owner_id, on_canvas_before - on_canvas_after, on_canvas_after)
        prune_unused_tags(db, owner_id)
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
    _sync_canvas_artifacts(db, owner_id, on_canvas_before - on_canvas_after, on_canvas_after)
    # Whatever this run emptied (a "canvas artifact" nobody carries any
    # more, an "edit" tag whose last photo was trashed) goes too.
    prune_unused_tags(db, owner_id)
    db.flush()


def _adopt_placed_copies(db: Session, owner_id: int) -> None:
    """Every virtual copy placed on a canvas becomes one of that canvas's
    photos (a CanvasImage row). The canvas mints copies to edit placed photos,
    and a copy has no home but the canvas that made it: as a member it stays
    on the filmstrip when its frame is taken off the page, ready to go back,
    and only removing it from the strip (or deleting the canvas) lets it go -
    which is when it becomes a "canvas artifact". Runs on every sync so
    copies placed before this rule existed are adopted too. Flushes."""
    placed = (
        db.query(CanvasLayout.canvas_id, LayoutItem.image_id)
        .join(LayoutItem, LayoutItem.layout_id == CanvasLayout.id)
        .join(Image, Image.id == LayoutItem.image_id)
        .filter(
            CanvasLayout.owner_id == owner_id,
            Image.virtual_of_image_id.isnot(None),
            Image.deleted_at.is_(None),
        )
        .distinct()
        .all()
    )
    if not placed:
        return
    canvas_ids = {canvas_id for canvas_id, _ in placed}
    members = set(
        db.query(CanvasImage.canvas_id, CanvasImage.image_id)
        .filter(CanvasImage.canvas_id.in_(canvas_ids))
        .all()
    )
    now = datetime.now(timezone.utc)
    for canvas_id, image_id in placed:
        if (canvas_id, image_id) not in members:
            db.add(CanvasImage(canvas_id=canvas_id, image_id=image_id, added_at=now))
            members.add((canvas_id, image_id))
    db.flush()


def _sync_canvas_artifacts(db: Session, owner_id: int, left: set[str], held: set[str]) -> None:
    """Tag the virtual copies among `left` (photos that just lost their last
    canvas) "canvas artifact", and take the tag off every photo in `held`
    (photos some canvas holds right now). Plain photos that leave a canvas
    are left alone: they were in the library before the canvas and belong
    there without it."""
    tag = (
        db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == CANVAS_ARTIFACT_TAG).first()
    )

    orphaned: set[str] = set()
    if left:
        orphaned = {
            image_id
            for (image_id,) in db.query(Image.id).filter(
                Image.id.in_(left),
                Image.owner_id == owner_id,
                Image.virtual_of_image_id.isnot(None),
            )
        }
    if orphaned:
        if tag is None:
            tag = Tag(owner_id=owner_id, name=CANVAS_ARTIFACT_TAG)
            db.add(tag)
            db.flush()
        already = {
            image_id
            for (image_id,) in db.query(ImageTag.image_id).filter(
                ImageTag.tag_id == tag.id, ImageTag.image_id.in_(orphaned)
            )
        }
        for image_id in orphaned - already:
            db.add(ImageTag(image_id=image_id, tag_id=tag.id))

    # Read the (few) tagged copies rather than pushing every canvas photo
    # into one IN list - this runs on every canvas autosave.
    if tag is not None and held:
        tagged = {
            image_id
            for (image_id,) in db.query(ImageTag.image_id).filter(ImageTag.tag_id == tag.id)
        }
        back = tagged & held
        if back:
            db.query(ImageTag).filter(
                ImageTag.tag_id == tag.id, ImageTag.image_id.in_(back)
            ).delete(synchronize_session=False)
