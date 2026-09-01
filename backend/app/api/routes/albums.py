import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_album, get_owned_image
from app.auth import get_current_user
from app.db.models import (
    Album,
    AlbumImage,
    AlbumLayout,
    FileType,
    Image,
    ImageTag,
    LayoutItem,
    LayoutVersion,
    Tag,
    User,
)
from app.db.session import get_db
from app.services import sources as sources_service
from app.services.filesystem import resolve_image_path
from app.services.settings_store import IMMICH_MODE_FULL, ImmichConfig, get_immich_config
from app.workers.queue import (
    enqueue_immich_album_delete,
    enqueue_immich_album_remove_assets,
    enqueue_immich_album_rename,
    enqueue_immich_upload,
)

router = APIRouter(prefix="/albums", tags=["albums"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _mirrored(immich: ImmichConfig | None, album: Album) -> bool:
    """Whether this album is kept in sync with a same-named Immich album:
    every album in full mode, only flagged ones in selective mode."""
    return immich is not None and (
        immich.sync_mode == IMMICH_MODE_FULL or (immich.album_sync and album.immich_sync)
    )


def _clean_tag_filter(tags: list[str]) -> list[str]:
    """Normalize a tag rule: strip, drop empties, dedupe (order preserved)."""
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        t = tag.strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _tagged_image_ids(db: Session, owner_id: int, tag_names: list[str]):
    """Subquery of image ids carrying ANY of the given tags."""
    return (
        db.query(ImageTag.image_id)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Tag.owner_id == owner_id, Tag.name.in_(tag_names))
    )


def _membership(db: Session, album: Album):
    """Filter criterion for an album's effective members: the manually added
    photos, plus - when the album carries a tag rule - every photo with any
    of those tags."""
    manual = db.query(AlbumImage.image_id).filter(AlbumImage.album_id == album.id)
    tags = album.tag_filter_list
    if tags:
        return or_(
            Image.id.in_(manual), Image.id.in_(_tagged_image_ids(db, album.owner_id, tags))
        )
    return Image.id.in_(manual)


def _member_images_query(db: Session, album: Album):
    """All live member photos of an album (manual + tag rule)."""
    return db.query(Image).filter(
        Image.owner_id == album.owner_id,
        Image.deleted_at.is_(None),
        _membership(db, album),
    )


def _enqueue_member_uploads(db: Session, immich: ImmichConfig, album: Album) -> None:
    """Queue an Immich upload of every JPEG member (manual + tag rule), each
    added to the same-named Immich album."""
    for image in _member_images_query(db, album).filter(Image.file_type == FileType.jpeg):
        path = resolve_image_path(image)
        if path.exists():
            enqueue_immich_upload(
                immich.base_url,
                immich.api_key,
                path,
                image.taken_at,
                (album.name,),
                image_id=image.id,
            )


def _shot_count(db: Session, album: Album) -> int:
    """How many photos the album shows: one per shot, not one per file.

    Photos sitting in the Trash keep their album membership (so restoring puts
    them back) but shouldn't inflate the count, and members via the tag rule
    count too. A RAW+JPEG pair whose halves are both members is a single card
    in the album (the grid collapses the pair to its JPEG), so the RAW half
    only counts when its JPEG isn't in the album - otherwise an album of two
    shots reads "3 photos"."""
    members = _member_images_query(db, album)
    hidden_raws = members.filter(
        Image.file_type == FileType.raw,
        Image.paired_image_id.in_(members.with_entities(Image.id)),
    )
    return members.count() - hidden_raws.count()


def _to_album_out(db: Session, album: Album) -> schemas.AlbumOut:
    count = _shot_count(db, album)
    # The first few photos (in album order) feed the card's mosaic preview.
    # JPEGs only - RAWs (dark render, usually doubling a JPEG of the same
    # shot) only when the album holds no JPEG at all. Manually placed photos
    # keep their curated order; tag-rule members fill any remaining slots
    # newest first.
    covers_base = (
        db.query(AlbumImage.image_id)
        .join(Image, Image.id == AlbumImage.image_id)
        .filter(AlbumImage.album_id == album.id, Image.deleted_at.is_(None))
        .order_by(AlbumImage.position.asc())
    )

    def fill(file_filter) -> list[str]:
        ids = [row[0] for row in covers_base.filter(file_filter).limit(4)]
        if len(ids) < 4 and album.tag_filter_list:
            extra = (
                _member_images_query(db, album)
                .filter(file_filter, Image.id.notin_(ids))
                .order_by(Image.taken_at.desc(), Image.id.asc())
                .limit(4 - len(ids))
                .all()
            )
            ids += [image.id for image in extra]
        return ids

    covers = fill(Image.file_type == FileType.jpeg)
    if not covers:
        covers = fill(Image.file_type != FileType.jpeg)
    return schemas.AlbumOut(
        id=album.id,
        name=album.name,
        description=album.description,
        created_at=album.created_at,
        image_count=count,
        cover_image_ids=covers,
        immich_sync=album.immich_sync,
        tag_filter=album.tag_filter_list,
    )


@router.get("", response_model=list[schemas.AlbumOut])
def list_albums(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    albums = db.query(Album).filter(Album.owner_id == current_user.id).order_by(Album.created_at.desc()).all()
    return [_to_album_out(db, album) for album in albums]


@router.post("", response_model=schemas.AlbumOut)
def create_album(
    payload: schemas.AlbumCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tags = _clean_tag_filter(payload.tag_filter)
    album = Album(
        owner_id=current_user.id,
        name=payload.name,
        description=payload.description,
        tag_filter=json.dumps(tags) if tags else None,
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return _to_album_out(db, album)


# Registered BEFORE "/{album_id}" on purpose: routes match in declaration
# order, so declared later this path would be read as an album called
# "canvases". The layout helpers it leans on live further down with the rest
# of the canvas code.
@router.get("/canvases", response_model=list[schemas.AlbumCanvasOut])
def list_canvases(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The Canvases shelf of the Albums page: every album whose canvas opted
    in (show_in_canvases), showing its chosen version - the one last kept or
    last loaded in the canvas. One card per album, and only kept versions are
    shown: the autosaving working layout is a draft, not a publication."""
    rows = (
        db.query(AlbumLayout, Album)
        .join(Album, AlbumLayout.album_id == Album.id)
        .filter(AlbumLayout.owner_id == current_user.id, AlbumLayout.show_in_canvases.is_(True))
        .order_by(AlbumLayout.updated_at.desc())
        .all()
    )
    out: list[schemas.AlbumCanvasOut] = []
    for layout, album in rows:
        versions = sorted(layout.versions, key=lambda v: v.created_at)
        if not versions:
            continue
        # A dangling active id (its version was deleted) falls back to the
        # newest snapshot rather than dropping the card.
        active = next((v for v in versions if v.id == layout.active_version_id), versions[-1])
        try:
            doc = schemas.AlbumLayoutIn.model_validate(json.loads(active.doc))
        except ValueError:
            continue
        revs = _live_image_revs(
            db, album.owner_id, [item.image_id for item in doc.items if item.image_id]
        )
        out.append(
            schemas.AlbumCanvasOut(
                album_id=album.id,
                album_name=album.name,
                version_id=active.id,
                version_name=active.name,
                version_count=len(versions),
                created_at=active.created_at,
                page_mode=doc.page_mode,
                page_width_mm=doc.page_width_mm,
                page_height_mm=doc.page_height_mm,
                page_count=doc.page_count,
                background=doc.background,
                show_page_guide=doc.show_page_guide,
                items=[
                    schemas.LayoutItemOut(
                        **item.model_dump(),
                        available=item.image_id is None or item.image_id in revs,
                    )
                    for item in doc.items
                ],
                thumb_versions={
                    id: (str(rev) if rev else "") for id, rev in revs.items()
                },
            )
        )
    return out


@router.get("/{album_id}", response_model=schemas.AlbumOut)
def get_album(album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    album = get_owned_album(db, current_user.id, album_id)
    return _to_album_out(db, album)


@router.patch("/{album_id}", response_model=schemas.AlbumOut)
def update_album(
    album_id: str,
    payload: schemas.AlbumUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    old_name = album.name
    old_tags = album.tag_filter_list
    if payload.name is not None:
        # An album with a blank name is unopenable in the UI, and the Immich
        # mirror maps albums by name - so a rename must actually carry one.
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="An album needs a name")
        album.name = name
    if payload.description is not None:
        album.description = payload.description
    if payload.tag_filter is not None:
        tags = _clean_tag_filter(payload.tag_filter)
        album.tag_filter = json.dumps(tags) if tags else None
    db.commit()
    db.refresh(album)
    # Renaming a mirrored album must follow through to Immich, or the by-name
    # mapping breaks (future uploads would spawn a fresh album under the new
    # name while the old one lingered).
    immich = get_immich_config(db)
    if album.name != old_name and _mirrored(immich, album):
        enqueue_immich_album_rename(immich.base_url, immich.api_key, old_name, album.name)
    # A widened tag rule pulls new photos into a mirrored album - push them the
    # same way flagging the album for sync does (re-uploads dedupe over there).
    if album.tag_filter_list != old_tags and _mirrored(immich, album):
        _enqueue_member_uploads(db, immich, album)
    return _to_album_out(db, album)


@router.delete("/{album_id}", status_code=204)
def delete_album(album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    album = get_owned_album(db, current_user.id, album_id)
    immich = get_immich_config(db)
    mirrored = _mirrored(immich, album)
    name = album.name
    db.delete(album)
    db.commit()
    # Deleting an app album also deletes its Immich mirror. Only the album:
    # the photos stay in the library here and the assets stay in the Immich
    # timeline over there.
    if mirrored:
        enqueue_immich_album_delete(immich.base_url, immich.api_key, name)


@router.post("/{album_id}/images", response_model=schemas.AlbumOut)
def add_images_to_album(
    album_id: str,
    payload: schemas.AlbumAddImages,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    existing_ids = {
        row.image_id
        for row in db.query(AlbumImage).filter(AlbumImage.album_id == album.id).all()
    }
    next_position = len(existing_ids)
    added: list[Image] = []
    for image_id in payload.image_ids:
        image = get_owned_image(db, current_user.id, image_id)
        if image_id in existing_ids:
            continue
        db.add(AlbumImage(album_id=album.id, image_id=image_id, position=next_position))
        next_position += 1
        added.append(image)
    db.commit()

    # A synced album mirrors its membership to Immich: photos added later must
    # upload + join the Immich album just like the ones present when the album
    # was flagged (full mode mirrors every album).
    immich = get_immich_config(db)
    if added and _mirrored(immich, album):
        for image in added:
            if image.file_type != FileType.jpeg or image.deleted_at is not None:
                continue
            path = resolve_image_path(image)
            if path.exists():
                enqueue_immich_upload(
                    immich.base_url,
                    immich.api_key,
                    path,
                    image.taken_at,
                    (album.name,),
                    image_id=image.id,
                )
    db.refresh(album)
    return _to_album_out(db, album)


@router.post("/{album_id}/immich-sync", response_model=schemas.AlbumOut)
def set_album_immich_sync(
    album_id: str,
    payload: schemas.AlbumImmichSyncRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Flag/unflag an album for selective Immich sync. Flagging on queues a
    background upload of every JPEG in the album, each added to a same-named
    Immich album; unflagging just clears the flag."""
    album = get_owned_album(db, current_user.id, album_id)
    album.immich_sync = payload.enabled
    db.commit()

    immich = get_immich_config(db)
    if payload.enabled and immich is not None:
        _enqueue_member_uploads(db, immich, album)
    db.refresh(album)
    return _to_album_out(db, album)


@router.delete("/{album_id}/images/{image_id}", status_code=204)
def remove_image_from_album(
    album_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album = get_owned_album(db, current_user.id, album_id)
    db.query(AlbumImage).filter(
        AlbumImage.album_id == album_id, AlbumImage.image_id == image_id
    ).delete()
    db.commit()
    # Mirror the removal: take the asset out of the Immich album too (it stays
    # in the Immich timeline). Only possible when we know its asset id - photos
    # never uploaded have nothing to remove anyway.
    immich = get_immich_config(db)
    if _mirrored(immich, album):
        image = db.get(Image, image_id)
        if image is not None and image.immich_asset_id:
            enqueue_immich_album_remove_assets(
                immich.base_url, immich.api_key, album.name, [image.immich_asset_id]
            )


# --- The album's creative layout -------------------------------------------
#
# The grid is computed from the album's membership; the layout is the opposite -
# every number in it was put there by hand, so it is stored as its own document
# and never derived from anything. Coordinates are millimetres (see
# models.AlbumLayout): the canvas is a page design that should still mean
# something when it is printed.

# What a brand new canvas looks like before the user has saved anything. No row
# is written until the first save, so merely opening the canvas on every album
# in the library doesn't litter the database with empty layouts.
_DEFAULT_LAYOUT = dict(
    page_mode="pages",
    page_width_mm=297.0,
    page_height_mm=210.0,
    page_count=1,
    background="#ffffff",
    show_grid=False,
    grid_mm=10.0,
    snap=True,
    show_page_guide=False,
)


def _live_image_revs(db: Session, owner_id: int, ids: list[str]) -> dict[str, int]:
    """The placed photos that currently have pixels to show - not in the Trash,
    not on an unplugged drive - each with its edit_rev (the thumbnail URL's
    cache-buster)."""
    if not ids:
        return {}
    query = db.query(Image.id, Image.edit_rev).filter(
        Image.id.in_(ids), Image.deleted_at.is_(None)
    )
    query = sources_service.exclude_unavailable(
        query, sources_service.unavailable_source_ids(db, owner_id)
    )
    return {row[0]: row[1] for row in query.all()}


def _layout_out(db: Session, album: Album, layout: AlbumLayout | None) -> schemas.AlbumLayoutOut:
    if layout is None:
        return schemas.AlbumLayoutOut(album_id=album.id, items=[], **_DEFAULT_LAYOUT)
    # A frame whose photo is in the Trash, or on an unplugged drive, has
    # nothing to draw - but the item stays, so restoring the photo (or
    # reconnecting the drive) brings the page back exactly as it was.
    live = _live_image_revs(
        db, album.owner_id, [item.image_id for item in layout.items if item.image_id]
    )
    return schemas.AlbumLayoutOut(
        album_id=album.id,
        page_mode=layout.page_mode,
        page_width_mm=layout.page_width_mm,
        page_height_mm=layout.page_height_mm,
        page_count=layout.page_count,
        background=layout.background,
        show_grid=layout.show_grid,
        grid_mm=layout.grid_mm,
        snap=layout.snap,
        show_page_guide=layout.show_page_guide,
        show_in_canvases=layout.show_in_canvases,
        active_version_id=layout.active_version_id,
        versions=[
            schemas.LayoutVersionOut(id=v.id, name=v.name, created_at=v.created_at)
            for v in sorted(layout.versions, key=lambda v: v.created_at, reverse=True)
        ],
        updated_at=layout.updated_at,
        items=[
            schemas.LayoutItemOut(
                id=item.id,
                kind=item.kind,
                image_id=item.image_id,
                page=item.page,
                x_mm=item.x_mm,
                y_mm=item.y_mm,
                width_mm=item.width_mm,
                height_mm=item.height_mm,
                rotation=item.rotation,
                z=item.z,
                content_scale=item.content_scale,
                content_dx=item.content_dx,
                content_dy=item.content_dy,
                text=item.text,
                style=item.style_dict or None,
                available=item.image_id is None or item.image_id in live,
            )
            for item in sorted(layout.items, key=lambda i: (i.page, i.z))
        ],
    )


@router.get("/{album_id}/layout", response_model=schemas.AlbumLayoutOut)
def get_album_layout(
    album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    album = get_owned_album(db, current_user.id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    return _layout_out(db, album, layout)


@router.put("/{album_id}/layout", response_model=schemas.AlbumLayoutOut)
def save_album_layout(
    album_id: str,
    payload: schemas.AlbumLayoutIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save the whole canvas in one go.

    Replace rather than patch: the canvas is a single document the user is
    directly manipulating, and a drag can move, restack and reshape several
    items at once. A per-item protocol would have to describe all of that and
    would still let a dropped request leave the page half-moved; sending what
    the canvas holds cannot."""
    album = get_owned_album(db, current_user.id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    if layout is None:
        layout = AlbumLayout(album_id=album.id, owner_id=current_user.id)
        db.add(layout)
        db.flush()

    _apply_layout_doc(db, layout, payload, current_user.id)
    db.commit()
    db.refresh(layout)
    return _layout_out(db, album, layout)


def _apply_layout_doc(
    db: Session, layout: AlbumLayout, payload: schemas.AlbumLayoutIn, owner_id: int
) -> None:
    """Write one whole document into the working layout - the shared body of
    the save endpoint and of restoring a kept version. Caller commits."""
    layout.page_mode = payload.page_mode
    # Guard the page box: a zero or negative sheet is not a design, it's a
    # division by zero waiting in the renderer.
    layout.page_width_mm = max(10.0, payload.page_width_mm)
    layout.page_height_mm = max(10.0, payload.page_height_mm)
    layout.page_count = max(1, payload.page_count)
    layout.background = payload.background
    layout.show_grid = payload.show_grid
    layout.grid_mm = max(1.0, payload.grid_mm)
    layout.snap = payload.snap
    layout.show_page_guide = payload.show_page_guide
    layout.show_in_canvases = payload.show_in_canvases
    layout.updated_at = _utcnow()

    # Only the owner's own live photos may be placed - an id from somewhere
    # else would put a foreign photo on the page (and break the FK).
    wanted = {item.image_id for item in payload.items if item.image_id}
    known: set[str] = set()
    if wanted:
        known = {
            row[0]
            for row in db.query(Image.id)
            .filter(Image.id.in_(wanted), Image.owner_id == owner_id)
            .all()
        }

    db.query(LayoutItem).filter(LayoutItem.layout_id == layout.id).delete(
        synchronize_session=False
    )
    db.expire(layout, ["items"])
    for item in payload.items:
        if item.kind == "photo" and item.image_id not in known:
            continue
        db.add(
            LayoutItem(
                id=item.id,
                layout_id=layout.id,
                kind=item.kind,
                image_id=item.image_id if item.image_id in known else None,
                page=max(0, item.page),
                x_mm=item.x_mm,
                y_mm=item.y_mm,
                # A frame with no area can never be grabbed again to fix it.
                width_mm=max(1.0, item.width_mm),
                height_mm=max(1.0, item.height_mm),
                rotation=item.rotation,
                z=item.z,
                content_scale=max(0.01, item.content_scale),
                content_dx=item.content_dx,
                content_dy=item.content_dy,
                text=item.text,
                style=json.dumps(item.style) if item.style else None,
            )
        )


@router.delete("/{album_id}/layout", status_code=204)
def clear_album_layout(
    album_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Throw the canvas away and start over - the album's photos are untouched."""
    album = get_owned_album(db, current_user.id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    if layout is not None:
        db.delete(layout)
        db.commit()


@router.post("/{album_id}/layout/shelf", status_code=204)
def set_canvas_shelf(
    album_id: str,
    payload: schemas.CanvasShelfIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Put the album's canvas on the Canvas Shelf, or take it off - and
    nothing else. The shelf card's X calls this: hiding is not deleting, the
    canvas and its kept versions stay untouched."""
    album = get_owned_album(db, current_user.id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    if layout is None:
        raise HTTPException(status_code=404, detail="This album has no saved canvas yet")
    layout.show_in_canvases = payload.enabled
    db.commit()


# --- Kept versions of the canvas --------------------------------------------
#
# The working layout autosaves over itself; a version is the user saying "keep
# this one", under a name. Restoring replays the snapshot through the same
# code path as a save, so every guard above applies to old documents too.
# Whichever version was kept or loaded last is the "active" one - the face the
# Canvases shelf shows for this album.


def _snapshot_doc(layout: AlbumLayout) -> dict:
    """The working layout as one AlbumLayoutIn-shaped dict - what a version
    stores. show_in_canvases is deliberately absent: it belongs to the layout
    (is this album on the shelf?), not to any one design of it."""
    return dict(
        page_mode=layout.page_mode,
        page_width_mm=layout.page_width_mm,
        page_height_mm=layout.page_height_mm,
        page_count=layout.page_count,
        background=layout.background,
        show_grid=layout.show_grid,
        grid_mm=layout.grid_mm,
        snap=layout.snap,
        show_page_guide=layout.show_page_guide,
        items=[
            dict(
                id=item.id,
                kind=item.kind,
                image_id=item.image_id,
                page=item.page,
                x_mm=item.x_mm,
                y_mm=item.y_mm,
                width_mm=item.width_mm,
                height_mm=item.height_mm,
                rotation=item.rotation,
                z=item.z,
                content_scale=item.content_scale,
                content_dx=item.content_dx,
                content_dy=item.content_dy,
                text=item.text,
                style=item.style_dict or None,
            )
            for item in layout.items
        ],
    )


def _owned_layout_version(
    db: Session, owner_id: int, album_id: str, version_id: str
) -> tuple[Album, AlbumLayout, LayoutVersion]:
    album = get_owned_album(db, owner_id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    version = (
        db.query(LayoutVersion)
        .filter(LayoutVersion.id == version_id, LayoutVersion.layout_id == (layout.id if layout else ""))
        .first()
        if layout
        else None
    )
    if layout is None or version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return album, layout, version


@router.post("/{album_id}/layout/versions", response_model=schemas.AlbumLayoutOut)
def create_layout_version(
    album_id: str,
    payload: schemas.LayoutVersionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Keep the canvas as it stands now, under a name. The client saves first
    (the canvas autosaves anyway), so the stored rows ARE the current state."""
    album = get_owned_album(db, current_user.id, album_id)
    layout = db.query(AlbumLayout).filter(AlbumLayout.album_id == album.id).first()
    if layout is None:
        raise HTTPException(status_code=404, detail="This album has no saved canvas yet")
    name = payload.name.strip()[:120] or f"Version {len(layout.versions) + 1}"
    version = LayoutVersion(
        layout_id=layout.id, name=name, doc=json.dumps(_snapshot_doc(layout)), created_at=_utcnow()
    )
    db.add(version)
    db.flush()
    # What was just kept is what the shelf should show.
    layout.active_version_id = version.id
    db.commit()
    db.refresh(layout)
    return _layout_out(db, album, layout)


@router.post("/{album_id}/layout/versions/{version_id}/restore", response_model=schemas.AlbumLayoutOut)
def restore_layout_version(
    album_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Load a kept version back into the working canvas, replacing it, and
    make it the shelf's active version."""
    album, layout, version = _owned_layout_version(db, current_user.id, album_id, version_id)
    try:
        doc = schemas.AlbumLayoutIn.model_validate(json.loads(version.doc))
    except ValueError:
        raise HTTPException(status_code=500, detail="This version could not be read")
    # The shelf flag rides along in AlbumLayoutIn but is not part of a design -
    # loading an old draft must not silently pull the album off the shelf.
    doc.show_in_canvases = layout.show_in_canvases
    _apply_layout_doc(db, layout, doc, current_user.id)
    layout.active_version_id = version.id
    db.commit()
    db.refresh(layout)
    return _layout_out(db, album, layout)


@router.patch("/{album_id}/layout/versions/{version_id}", response_model=schemas.AlbumLayoutOut)
def rename_layout_version(
    album_id: str,
    version_id: str,
    payload: schemas.LayoutVersionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    album, layout, version = _owned_layout_version(db, current_user.id, album_id, version_id)
    name = payload.name.strip()[:120]
    if name:
        version.name = name
        db.commit()
    return _layout_out(db, album, layout)


@router.delete("/{album_id}/layout/versions/{version_id}", response_model=schemas.AlbumLayoutOut)
def delete_layout_version(
    album_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Forget one kept version. The working canvas is untouched; if the shelf
    was showing this one it falls back to the newest that remains."""
    album, layout, version = _owned_layout_version(db, current_user.id, album_id, version_id)
    db.delete(version)
    db.flush()
    if layout.active_version_id == version_id:
        remaining = sorted(
            (v for v in layout.versions if v.id != version_id), key=lambda v: v.created_at
        )
        layout.active_version_id = remaining[-1].id if remaining else None
    db.commit()
    db.refresh(layout)
    return _layout_out(db, album, layout)
