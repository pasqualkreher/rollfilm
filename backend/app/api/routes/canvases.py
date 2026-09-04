"""Standalone canvases: free design surfaces, independent of albums.

A canvas has a name, a membership list (the photos its filmstrip offers,
added from the library's Select mode exactly like adding to an album) and one
working layout that autosaves over itself, with kept versions on top. The
layout code here is the album-canvas code moved over: the grid was computed
from an album's membership, but a layout was always its own hand-made
document - it just no longer needs an album to hang off.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_canvas
from app.auth import get_current_user
from app.db.models import (
    Canvas,
    CanvasImage,
    CanvasLayout,
    Image,
    LayoutItem,
    LayoutVersion,
    User,
)
from app.db.session import get_db
from app.services import sources as sources_service

router = APIRouter(prefix="/canvases", tags=["canvases"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# What a brand new canvas looks like before the user has saved anything. No
# layout row is written until the first save, so merely opening a canvas
# doesn't litter the database with empty layouts.
_DEFAULT_LAYOUT = dict(
    page_mode="pages",
    page_width_mm=297.0,
    page_height_mm=210.0,
    page_count=1,
    background="#ffffff",
    show_grid=False,
    grid_mm=10.0,
    snap=True,
    margin_mm=12.0,
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


def _items_out(layout: CanvasLayout, live: dict[str, int]) -> list[schemas.LayoutItemOut]:
    """The layout's items as the API sends them, bottom to top, each flagged
    with whether its photo currently has pixels to show."""
    return [
        schemas.LayoutItemOut(
            id=item.id,
            kind=item.kind,
            image_id=item.image_id,
            missing=item.missing,
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
    ]


def _summary_out(db: Session, canvas: Canvas) -> schemas.CanvasSummaryOut:
    layout = canvas.layout
    preview = None
    if layout is not None:
        # The overview card shows the working layout itself - the draft the
        # user would land in when opening the canvas, not a kept version.
        live = _live_image_revs(
            db, canvas.owner_id, [item.image_id for item in layout.items if item.image_id]
        )
        preview = schemas.CanvasPreviewOut(
            page_mode=layout.page_mode,
            page_width_mm=layout.page_width_mm,
            page_height_mm=layout.page_height_mm,
            page_count=layout.page_count,
            background=layout.background,
            show_page_guide=layout.show_page_guide,
            items=_items_out(layout, live),
            thumb_versions={id: (str(rev) if rev else "") for id, rev in live.items()},
        )
    return schemas.CanvasSummaryOut(
        id=canvas.id,
        name=canvas.name,
        created_at=canvas.created_at,
        updated_at=layout.updated_at if layout else None,
        image_count=db.query(CanvasImage).filter(CanvasImage.canvas_id == canvas.id).count(),
        item_count=(
            db.query(LayoutItem).filter(LayoutItem.layout_id == layout.id).count()
            if layout
            else 0
        ),
        show_in_canvases=bool(layout.show_in_canvases) if layout else False,
        preview=preview,
    )


@router.get("", response_model=list[schemas.CanvasSummaryOut])
def list_canvases(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    canvases = (
        db.query(Canvas)
        .filter(Canvas.owner_id == current_user.id)
        .order_by(Canvas.created_at.desc())
        .all()
    )
    # Most recently worked-on first; never-saved canvases sort by creation.
    out = [_summary_out(db, canvas) for canvas in canvases]
    out.sort(key=lambda c: (c.updated_at or c.created_at), reverse=True)
    return out


@router.post("", response_model=schemas.CanvasSummaryOut)
def create_canvas(
    payload: schemas.CanvasCreateIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = payload.name.strip()[:120] or "Canvas"
    canvas = Canvas(owner_id=current_user.id, name=name, created_at=_utcnow())
    db.add(canvas)
    db.commit()
    db.refresh(canvas)
    return _summary_out(db, canvas)


# Registered BEFORE "/{canvas_id}" so the path isn't read as a canvas called
# "gallery". The Canvas Shelf on the Albums page and any other gallery of
# finished designs read this.
@router.get("/gallery", response_model=list[schemas.CanvasGalleryOut])
def canvases_gallery(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Every canvas that opted onto the shelf (show_in_canvases), showing its
    chosen version - the one last saved or last loaded. Only saved versions
    are shown: the working layout is whatever the editor last wrote, not a
    publication."""
    rows = (
        db.query(CanvasLayout, Canvas)
        .join(Canvas, CanvasLayout.canvas_id == Canvas.id)
        .filter(
            CanvasLayout.owner_id == current_user.id,
            CanvasLayout.show_in_canvases.is_(True),
        )
        .order_by(CanvasLayout.updated_at.desc())
        .all()
    )
    out: list[schemas.CanvasGalleryOut] = []
    for layout, canvas in rows:
        versions = sorted(layout.versions, key=lambda v: v.created_at)
        if not versions:
            continue
        # A dangling active id (its version was deleted) falls back to the
        # newest snapshot rather than dropping the card.
        active = next((v for v in versions if v.id == layout.active_version_id), versions[-1])
        try:
            doc = schemas.CanvasLayoutIn.model_validate(json.loads(active.doc))
        except ValueError:
            continue
        revs = _live_image_revs(
            db, canvas.owner_id, [item.image_id for item in doc.items if item.image_id]
        )
        out.append(
            schemas.CanvasGalleryOut(
                canvas_id=canvas.id,
                canvas_name=canvas.name,
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
                thumb_versions={id: (str(rev) if rev else "") for id, rev in revs.items()},
            )
        )
    return out


@router.get("/{canvas_id}", response_model=schemas.CanvasSummaryOut)
def get_canvas(
    canvas_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    return _summary_out(db, canvas)


@router.patch("/{canvas_id}", response_model=schemas.CanvasSummaryOut)
def rename_canvas(
    canvas_id: str,
    payload: schemas.CanvasRenameIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    name = payload.name.strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="A canvas needs a name")
    canvas.name = name
    db.commit()
    db.refresh(canvas)
    return _summary_out(db, canvas)


@router.delete("/{canvas_id}", status_code=204)
def delete_canvas(
    canvas_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Delete the canvas: its layout, kept versions and membership go with it.
    The photos themselves are untouched - they live in the library."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    db.delete(canvas)
    db.commit()


# --- Membership --------------------------------------------------------------


@router.get("/{canvas_id}/images", response_model=list[schemas.ImageOut])
def canvas_images(
    canvas_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Every photo this canvas can draw: its members (the filmstrip) plus any
    photo a frame still references - a frame keeps working even after its
    photo was removed from the membership, exactly like an album's canvas kept
    working for photos the album dropped."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    member_ids = db.query(CanvasImage.image_id).filter(CanvasImage.canvas_id == canvas.id)
    placed_ids = (
        db.query(LayoutItem.image_id)
        .join(CanvasLayout, CanvasLayout.id == LayoutItem.layout_id)
        .filter(CanvasLayout.canvas_id == canvas.id, LayoutItem.image_id.isnot(None))
    )
    images = (
        db.query(Image)
        .filter(
            Image.owner_id == current_user.id,
            Image.deleted_at.is_(None),
            Image.id.in_(member_ids.union(placed_ids)),
        )
        .order_by(Image.taken_at.desc(), Image.id)
        .all()
    )
    return [schemas.ImageOut.model_validate(image) for image in images]


@router.post("/{canvas_id}/images", response_model=schemas.CanvasSummaryOut)
def add_canvas_images(
    canvas_id: str,
    payload: schemas.CanvasImagesIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    existing = {
        row[0]
        for row in db.query(CanvasImage.image_id)
        .filter(CanvasImage.canvas_id == canvas.id)
        .all()
    }
    owned = {
        row[0]
        for row in db.query(Image.id)
        .filter(Image.id.in_(set(payload.image_ids)), Image.owner_id == current_user.id)
        .all()
    }
    now = _utcnow()
    for image_id in payload.image_ids:
        if image_id in owned and image_id not in existing:
            db.add(CanvasImage(canvas_id=canvas.id, image_id=image_id, added_at=now))
            existing.add(image_id)
    db.commit()
    return _summary_out(db, canvas)


@router.post("/{canvas_id}/images/remove", response_model=schemas.CanvasSummaryOut)
def remove_canvas_images(
    canvas_id: str,
    payload: schemas.CanvasImagesIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take photos out of the membership. Frames referencing them stay on the
    page (the canvas can still draw them) - membership is the filmstrip, not
    the design."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    db.query(CanvasImage).filter(
        CanvasImage.canvas_id == canvas.id, CanvasImage.image_id.in_(set(payload.image_ids))
    ).delete(synchronize_session=False)
    db.commit()
    return _summary_out(db, canvas)


# --- The working layout ------------------------------------------------------


def _layout_out(db: Session, canvas: Canvas, layout: CanvasLayout | None) -> schemas.CanvasLayoutOut:
    if layout is None:
        return schemas.CanvasLayoutOut(canvas_id=canvas.id, items=[], **_DEFAULT_LAYOUT)
    # A frame whose photo is in the Trash, or on an unplugged drive, has
    # nothing to draw - but the item stays, so restoring the photo (or
    # reconnecting the drive) brings the page back exactly as it was.
    live = _live_image_revs(
        db, canvas.owner_id, [item.image_id for item in layout.items if item.image_id]
    )
    return schemas.CanvasLayoutOut(
        canvas_id=canvas.id,
        page_mode=layout.page_mode,
        page_width_mm=layout.page_width_mm,
        page_height_mm=layout.page_height_mm,
        page_count=layout.page_count,
        background=layout.background,
        show_grid=layout.show_grid,
        grid_mm=layout.grid_mm,
        snap=layout.snap,
        margin_mm=layout.margin_mm,
        show_page_guide=layout.show_page_guide,
        show_in_canvases=layout.show_in_canvases,
        active_version_id=layout.active_version_id,
        versions=[
            schemas.LayoutVersionOut(id=v.id, name=v.name, created_at=v.created_at)
            for v in sorted(layout.versions, key=lambda v: v.created_at, reverse=True)
        ],
        updated_at=layout.updated_at,
        items=_items_out(layout, live),
    )


def _apply_layout_doc(
    db: Session, layout: CanvasLayout, payload: schemas.CanvasLayoutIn, owner_id: int
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
    # A margin past the middle of the sheet is no margin any more - the two
    # sides would cross and every inset computation flips sign.
    layout.margin_mm = max(
        0.0,
        min(payload.margin_mm, layout.page_width_mm / 2, layout.page_height_mm / 2),
    )
    layout.show_page_guide = payload.show_page_guide
    layout.show_in_canvases = payload.show_in_canvases
    layout.updated_at = _utcnow()

    # Only the owner's own photos may be placed - an id from somewhere else
    # would put a foreign photo on the page (and break the FK).
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
        # A placeholder ("missing" frame, no image) round-trips untouched so
        # autosave never erases the gap a permanent deletion left behind. An
        # item carrying an id that isn't the owner's live photo is refused as
        # ever - ids come from the client and may not smuggle foreign photos.
        image_id = item.image_id if item.image_id in known else None
        missing = item.kind == "photo" and image_id is None and bool(item.missing) and item.image_id is None
        if item.kind == "photo" and image_id is None and not missing:
            continue
        db.add(
            LayoutItem(
                id=item.id,
                layout_id=layout.id,
                kind=item.kind,
                image_id=image_id,
                missing=missing if item.kind == "photo" else False,
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


@router.get("/{canvas_id}/layout", response_model=schemas.CanvasLayoutOut)
def get_canvas_layout(
    canvas_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    return _layout_out(db, canvas, layout)


@router.put("/{canvas_id}/layout", response_model=schemas.CanvasLayoutOut)
def save_canvas_layout(
    canvas_id: str,
    payload: schemas.CanvasLayoutIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save the whole canvas in one go.

    Replace rather than patch: the canvas is a single document the user is
    directly manipulating, and a drag can move, restack and reshape several
    items at once. A per-item protocol would have to describe all of that and
    would still let a dropped request leave the page half-moved; sending what
    the canvas holds cannot."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    if layout is None:
        layout = CanvasLayout(canvas_id=canvas.id, owner_id=current_user.id)
        db.add(layout)
        db.flush()

    _apply_layout_doc(db, layout, payload, current_user.id)
    db.commit()
    db.refresh(layout)
    return _layout_out(db, canvas, layout)


@router.delete("/{canvas_id}/layout", status_code=204)
def clear_canvas_layout(
    canvas_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Throw the design away and start over - membership and photos untouched."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    if layout is not None:
        db.delete(layout)
        db.commit()


@router.post("/{canvas_id}/layout/shelf", status_code=204)
def set_canvas_shelf(
    canvas_id: str,
    payload: schemas.CanvasShelfIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Put the canvas on the Canvas Shelf, or take it off - and nothing else.
    The shelf card's X calls this: hiding is not deleting, the canvas and its
    kept versions stay untouched."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    if layout is None:
        raise HTTPException(status_code=404, detail="This canvas has not been saved yet")
    layout.show_in_canvases = payload.enabled
    db.commit()


# --- Saved versions ----------------------------------------------------------
#
# Saving a canvas is naming it: the editor writes the working layout and then
# keeps it as a version under the name the user gave. Saving under a name that
# already exists replaces that version, so "Save" on an unchanged name is an
# ordinary overwrite and a new name is a new branch. Restoring replays the
# snapshot through the same code path as a save, so every guard above applies
# to old documents too. Whichever version was saved or loaded last is the
# "active" one - the face the shelf shows for this canvas.


def _snapshot_doc(layout: CanvasLayout) -> dict:
    """The working layout as one CanvasLayoutIn-shaped dict - what a version
    stores. show_in_canvases is deliberately absent: it belongs to the layout
    (is this canvas on the shelf?), not to any one design of it."""
    return dict(
        page_mode=layout.page_mode,
        page_width_mm=layout.page_width_mm,
        page_height_mm=layout.page_height_mm,
        page_count=layout.page_count,
        background=layout.background,
        show_grid=layout.show_grid,
        grid_mm=layout.grid_mm,
        snap=layout.snap,
        margin_mm=layout.margin_mm,
        show_page_guide=layout.show_page_guide,
        items=[
            dict(
                id=item.id,
                kind=item.kind,
                image_id=item.image_id,
                missing=item.missing,
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
    db: Session, owner_id: int, canvas_id: str, version_id: str
) -> tuple[Canvas, CanvasLayout, LayoutVersion]:
    canvas = get_owned_canvas(db, owner_id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    version = (
        db.query(LayoutVersion)
        .filter(
            LayoutVersion.id == version_id,
            LayoutVersion.layout_id == (layout.id if layout else ""),
        )
        .first()
        if layout
        else None
    )
    if layout is None or version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return canvas, layout, version


@router.post("/{canvas_id}/layout/versions", response_model=schemas.CanvasLayoutOut)
def create_layout_version(
    canvas_id: str,
    payload: schemas.LayoutVersionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Keep the canvas as it stands now, under a name. The client writes the
    working layout first, so the stored rows ARE the current state. A name
    that matches an existing version (case-insensitively) replaces that
    version's snapshot instead of adding a second one with the same name."""
    canvas = get_owned_canvas(db, current_user.id, canvas_id)
    layout = db.query(CanvasLayout).filter(CanvasLayout.canvas_id == canvas.id).first()
    if layout is None:
        raise HTTPException(status_code=404, detail="This canvas has not been saved yet")
    name = payload.name.strip()[:120] or f"Version {len(layout.versions) + 1}"
    snapshot = json.dumps(_snapshot_doc(layout))
    version = next((v for v in layout.versions if v.name.casefold() == name.casefold()), None)
    if version is None:
        version = LayoutVersion(layout_id=layout.id, name=name, doc=snapshot, created_at=_utcnow())
        db.add(version)
        db.flush()
    else:
        version.doc = snapshot
        version.created_at = _utcnow()
    # What was just saved is what the shelf should show.
    layout.active_version_id = version.id
    db.commit()
    db.refresh(layout)
    return _layout_out(db, canvas, layout)


@router.post("/{canvas_id}/layout/versions/{version_id}/restore", response_model=schemas.CanvasLayoutOut)
def restore_layout_version(
    canvas_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Load a kept version back into the working canvas, replacing it, and
    make it the shelf's active version."""
    canvas, layout, version = _owned_layout_version(db, current_user.id, canvas_id, version_id)
    try:
        doc = schemas.CanvasLayoutIn.model_validate(json.loads(version.doc))
    except ValueError:
        raise HTTPException(status_code=500, detail="This version could not be read")
    # The shelf flag rides along in CanvasLayoutIn but is not part of a design -
    # loading an old draft must not silently pull the canvas off the shelf.
    doc.show_in_canvases = layout.show_in_canvases
    _apply_layout_doc(db, layout, doc, current_user.id)
    layout.active_version_id = version.id
    db.commit()
    db.refresh(layout)
    return _layout_out(db, canvas, layout)


@router.patch("/{canvas_id}/layout/versions/{version_id}", response_model=schemas.CanvasLayoutOut)
def rename_layout_version(
    canvas_id: str,
    version_id: str,
    payload: schemas.LayoutVersionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    canvas, layout, version = _owned_layout_version(db, current_user.id, canvas_id, version_id)
    name = payload.name.strip()[:120]
    if name:
        version.name = name
        db.commit()
    return _layout_out(db, canvas, layout)


@router.delete("/{canvas_id}/layout/versions/{version_id}", response_model=schemas.CanvasLayoutOut)
def delete_layout_version(
    canvas_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Forget one kept version. The working canvas is untouched; if the shelf
    was showing this one it falls back to the newest that remains."""
    canvas, layout, version = _owned_layout_version(db, current_user.id, canvas_id, version_id)
    db.delete(version)
    db.flush()
    if layout.active_version_id == version_id:
        remaining = sorted(
            (v for v in layout.versions if v.id != version_id), key=lambda v: v.created_at
        )
        layout.active_version_id = remaining[-1].id if remaining else None
    db.commit()
    db.refresh(layout)
    return _layout_out(db, canvas, layout)
