import hashlib
import io
import itertools
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from PIL import Image as PILImage
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from sqlalchemy import String, case, func, or_, select, type_coerce
from sqlalchemy.orm import Session, aliased, selectinload

from app import schemas
from app.api.deps import get_owned_image
from app.auth import get_current_user
from app.config import settings
from app.db.models import (
    Album,
    AlbumImage,
    ColorLabel,
    FileType,
    Image,
    ImageTag,
    Tag,
    User,
)
from app.db.session import SessionLocal, engine, get_db
from app.services import (
    auto_develop,
    develop,
    embeddings,
    geocode,
    immich as immich_service,
    segmentation,
    sources as sources_service,
    thumbnails,
    trash as trash_service,
)
from app.services.filesystem import library_relative_path, resolve_image_path
from app.services.hashing import perceptual_hash
from app.services.immich_sync import immich_album_names as _immich_album_names
from app.services.borg_backup import run_backup_soon
from app.services.immich_sync import run_immich_sync_soon
from app.services.settings_store import get_auto_develop_groups, get_immich_config
from app.workers.queue import (
    enqueue_immich_upload,
    enqueue_post_import,
    schedule_embedding_backfill,
    store_immich_asset_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/images", tags=["images"])


def _try_regenerate_derivatives(image: Image) -> None:
    """Rotation/crop metadata is already committed by the time this runs -
    if the source file is missing, corrupt, or LibRaw chokes on it, that's a
    thumbnail-rebuild problem to retry later (see the Settings "Rebuild all
    thumbnails" action), not a reason to fail the edit the user just made."""
    try:
        thumbnails.regenerate_for_image(image)
        # Pre-render the 100%-zoom/export full.jpg in the background so the
        # common "edit, then export" flow doesn't pay the full RAW render at
        # export time.
        thumbnails.warm_full_cache(image.id)
    except Exception:
        logger.exception("Failed to regenerate thumbnails for image %s after edit", image.id)


def _apply_to_pair(
    db: Session,
    owner_id: int,
    image: Image,
    rating: int | None,
    color_label: ColorLabel | None,
) -> None:
    """Mirror a rating/color change onto this image's RAW+JPEG partner, so users
    can cull the merged pair by only touching the JPEG. No-op when the image has
    no partner (or it isn't owned by the caller), and no-op across the Trash:
    while one half is deleted the pair is suspended everywhere else too, so
    rating the survivor must not reach into a photo the user threw away."""
    if not image.paired_image_id:
        return
    partner = db.get(Image, image.paired_image_id)
    if partner is None or partner.owner_id != owner_id:
        return
    if (partner.deleted_at is None) != (image.deleted_at is None):
        return
    if rating is not None:
        partner.rating = rating
    if color_label is not None:
        partner.color_label = color_label


def _get_or_create_tag(db: Session, owner_id: int, name: str) -> Tag:
    tag = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == name).first()
    if tag is None:
        tag = Tag(owner_id=owner_id, name=name)
        db.add(tag)
        db.flush()
    return tag


def _add_tag_to_image(db: Session, owner_id: int, image: Image, name: str) -> None:
    name = name.strip()
    if not name:
        return
    tag = _get_or_create_tag(db, owner_id, name)
    exists = db.query(ImageTag).filter(ImageTag.image_id == image.id, ImageTag.tag_id == tag.id).first()
    if not exists:
        db.add(ImageTag(image_id=image.id, tag_id=tag.id))


def _remove_tag_from_image(db: Session, owner_id: int, image: Image, name: str) -> None:
    tag = db.query(Tag).filter(Tag.owner_id == owner_id, Tag.name == name).first()
    if tag is None:
        return
    db.query(ImageTag).filter(ImageTag.image_id == image.id, ImageTag.tag_id == tag.id).delete()


def _has_any_edit(image: Image) -> bool:
    """True when the photo carries any non-destructive edit - geometry or develop.
    Mirrors the has_edit check in save_edits so the auto-managed "edit" tag and
    the edit_rev cache-buster stay consistent across every edit path."""
    return bool(
        (image.edit_rotation or 0) % 360
        or image.edit_crop_width is not None
        or image.edit_flip_h
        or image.edit_flip_v
        or image.edit_straighten
        or image.edit_persp_h
        or image.edit_persp_v
        or image.edit_distortion
        or image.edit_adjustments is not None
    )


def _sync_edit_state(db: Session, owner_id: int, image: Image) -> None:
    """After a develop/geometry change, refresh the edit_rev cache-buster and the
    auto-managed "edit" tag from the image's current state (drops both back to
    the un-edited baseline when nothing is left)."""
    if _has_any_edit(image):
        image.edit_rev = (image.edit_rev or 0) + 1
        _add_tag_to_image(db, owner_id, image, "edit")
    else:
        image.edit_rev = 0
        _remove_tag_from_image(db, owner_id, image, "edit")
    # The library changed - schedule an incremental Borg backup (debounced; a
    # no-op unless the user has configured one). Covers all bulk develop paths.
    run_backup_soon()


def _filtered_images_query(
    db: Session,
    current_user: User,
    view_mode: str,
    album_id: str | None,
    rating_min: int | None,
    color_label: ColorLabel | None,
    camera_model: str | None,
    lens_model: str | None,
    focal_min: float | None,
    focal_max: float | None,
    country: str | None,
    date_from: datetime | None,
    date_to: datetime | None,
    tags: list[str] | None,
):
    """The library listing's filter set, shared by the list endpoint and the
    count endpoint so the total the scrollbar is sized from can never drift
    from what scrolling actually returns."""
    query = db.query(Image).filter(
        Image.owner_id == current_user.id, Image.deleted_at.is_(None)
    )

    if album_id:
        # Manually added photos, plus - when the album carries a tag rule -
        # every photo with any of those tags (same membership the album card's
        # count is computed from, see routes/albums._membership).
        manual_ids = db.query(AlbumImage.image_id).filter(AlbumImage.album_id == album_id)
        album = db.get(Album, album_id)
        rule_tags = album.tag_filter_list if album is not None else []
        if rule_tags:
            tagged_ids = (
                db.query(ImageTag.image_id)
                .join(Tag, Tag.id == ImageTag.tag_id)
                .filter(Tag.owner_id == current_user.id, Tag.name.in_(rule_tags))
            )
            query = query.filter(
                or_(Image.id.in_(manual_ids), Image.id.in_(tagged_ids))
            )
        else:
            query = query.filter(Image.id.in_(manual_ids))
    if rating_min is not None:
        query = query.filter(Image.rating >= rating_min)
    if color_label is not None:
        query = query.filter(Image.color_label == color_label)
    if camera_model:
        query = query.filter(Image.camera_model == camera_model)
    if lens_model:
        query = query.filter(Image.lens_model == lens_model)
    # Focal range from the filter slider. The bounds the client sends back are
    # the facet values, which are rounded to 0.1mm - widen by half that so a
    # stored 8.83 still matches its displayed "8.8" endpoint.
    if focal_min is not None:
        query = query.filter(Image.focal_length >= focal_min - 0.05)
    if focal_max is not None:
        query = query.filter(Image.focal_length <= focal_max + 0.05)
    if country == geocode.NO_LOCATION:
        query = query.filter(Image.gps_lat.is_(None))
    elif country:
        query = query.filter(Image.gps_country == country)
    if date_from:
        query = query.filter(Image.taken_at >= date_from)
    if date_to:
        query = query.filter(Image.taken_at <= date_to)
    if tags:
        # AND semantics: keep only photos carrying *every* selected tag, so each
        # extra tag narrows the results further (like the other filters).
        wanted = [t for t in tags if t]
        if wanted:
            matching_ids = (
                db.query(ImageTag.image_id)
                .join(Tag, Tag.id == ImageTag.tag_id)
                .filter(Tag.owner_id == current_user.id, Tag.name.in_(wanted))
                .group_by(ImageTag.image_id)
                .having(func.count(func.distinct(Tag.name)) == len(wanted))
            )
            query = query.filter(Image.id.in_(matching_ids))

    if view_mode == "jpeg_only":
        query = query.filter(Image.file_type == FileType.jpeg)
    elif view_mode == "raw_only":
        query = query.filter(Image.file_type == FileType.raw)
    # "combined" (RAW+JPEG): no type filter - both files of a pair are shown,
    # each still carrying paired_image_id so the UI can badge them as a pair
    # without hiding either one (hiding one would make it impossible to
    # select/deselect independently, e.g. during import review).

    # Hide photos indexed from an external source that isn't currently connected
    # (unplugged drive / unmounted NAS) - the index stays, they reappear when it
    # reconnects.
    return sources_service.exclude_unavailable(
        query, sources_service.unavailable_source_ids(db, current_user.id)
    )


@router.get("", response_model=list[schemas.ImageOut])
def list_images(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = Query(None),
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = _filtered_images_query(
        db, current_user, view_mode, album_id, rating_min, color_label,
        camera_model, lens_model, focal_min, focal_max, country, date_from, date_to, tags,
    )
    # Newest capture first. The extra keys make the order total: burst shots
    # share the same capture second and photos without any capture date all
    # sort together - without deterministic tie-breakers their relative order
    # is whatever the query planner felt like, so photos jump around between
    # requests and pagination can duplicate/skip rows at page boundaries.
    query = query.order_by(
        Image.taken_at.desc(), Image.original_filename.asc(), Image.id.asc()
    )
    # The response's paired_image_id is Image.visible_paired_image_id, which
    # reads the partner's deleted_at - one extra query for the page instead of
    # one lazy load per row.
    return (
        query.options(selectinload(Image.paired_image))
        .offset(offset)
        .limit(limit)
        .all()
    )


# The per-image thumbnail cache-buster is the server-owned `edit_rev` counter,
# bumped on every edit save (edits/rotate/crop). The library index sends
# String(edit_rev) and the frontend's editVersion() just echoes it - no per-field
# version string is recomputed on either side any more.


@router.get("/index")
def library_index(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The whole filtered library as one slim, ordered list: for each photo
    just what a grid tile needs (id, aspect ratio, date, badge/selection state,
    thumbnail cache-buster - see LibraryIndexImage in the frontend types). The
    grid lays out every photo up front (exact scrollbar, jump anywhere) and
    fetches only thumbnails on demand.

    Serialized by hand instead of via response_model: a big library is tens of
    thousands of rows and per-row pydantic + encoder overhead multiplied out to
    seconds. `thumb_version` is sent as "" for never-edited photos (the vast
    majority) - the client substitutes its own default-version constant."""
    query = _filtered_images_query(
        db, current_user, view_mode, album_id, rating_min, color_label,
        camera_model, lens_model, focal_min, focal_max, country, date_from, date_to, tags,
    )
    # file_type, color_label and taken_at are asked for as plain strings rather
    # than as their mapped types. The database already holds exactly what this
    # response needs - the enum values as text, the timestamp as
    # "YYYY-MM-DD HH:MM:SS.ffffff" - and the mapped columns made every row pay
    # for decoding that into Enum/datetime objects only to have the lines below
    # encode them straight back. On a 50k-photo library that round trip alone
    # was most of the endpoint's time (measured: 412ms -> 221ms for a
    # byte-identical response).
    #
    # type_coerce, not literal_column: it reuses the real column expression, so
    # this cannot come apart if the filter chain ever aliases the table - it
    # only overrides how the RESULT is read back.
    # A pair only counts as a pair while both halves are in the library: with
    # one of them in the Trash the survivor must stop badging itself "RAW+JPG"
    # and stop standing in for a file the user just deleted (see
    # Image.visible_paired_image_id, the same rule the ImageOut routes apply).
    # Asked for as a correlated subquery rather than a join so it can't disturb
    # the filter chain above - every row here is already deleted_at IS NULL, so
    # the partner's own deleted_at being null is the whole test.
    partner = aliased(Image)
    partner_deleted = (
        select(type_coerce(partner.deleted_at, String))
        .where(partner.id == Image.paired_image_id)
        .correlate(Image)
        .scalar_subquery()
    )
    rows = (
        query.with_entities(
            Image.id, Image.original_filename, type_coerce(Image.file_type, String),
            Image.width, Image.height, type_coerce(Image.taken_at, String),
            Image.rating, type_coerce(Image.color_label, String),
            Image.immich_sync, Image.paired_image_id, Image.source_root_id,
            Image.edit_rev, partner_deleted,
        )
        .order_by(Image.taken_at.desc(), Image.original_filename.asc(), Image.id.asc())
        .all()
    )

    # Unpacked positionally rather than by attribute: at this row count the
    # attribute lookups are themselves a measurable share of the loop.
    images = [
        {
            "id": id_,
            "original_filename": filename,
            "file_type": file_type,
            "width": width,
            "height": height,
            # Stored with a space separator and always six fractional digits;
            # the API has always sent ISO-8601 seconds (datetime.isoformat()
            # omits a zero microsecond part), so cut at the seconds and swap the
            # separator. Sub-second capture times are not something the grid can
            # show - it groups by month or day.
            "taken_at": f"{taken_at[:10]}T{taken_at[11:19]}" if taken_at else None,
            "rating": rating,
            "color_label": color_label,
            "immich_sync": bool(immich_sync),
            "paired_image_id": paired_image_id if partner_deleted_at is None else None,
            "source_root_id": source_root_id,
            "thumb_version": str(edit_rev) if edit_rev else "",
        }
        for (
            id_, filename, file_type, width, height, taken_at, rating, color_label,
            immich_sync, paired_image_id, source_root_id, edit_rev, partner_deleted_at,
        ) in rows
    ]
    return Response(
        content=json.dumps({"images": images}, separators=(",", ":")),
        media_type="application/json",
    )


@router.get("/geo")
def geo_index(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every geotagged photo as one slim row (id, lat, lon, pairing) - the map
    clusters these client-side per zoom level, so it needs the full set, not a
    page. Hand-serialized for the same reason as /images/index."""
    query = _filtered_images_query(
        db, current_user, "combined", None, None, None, None, None, None, None, None, None, None, None
    )
    rows = (
        query.with_entities(
            Image.id, Image.gps_lat, Image.gps_lon, Image.paired_image_id, Image.original_filename
        )
        .filter(Image.gps_lat.isnot(None), Image.gps_lon.isnot(None))
        .order_by(Image.taken_at.desc(), Image.original_filename.asc(), Image.id.asc())
        .all()
    )
    images = [
        {
            "id": r.id,
            "lat": r.gps_lat,
            "lon": r.gps_lon,
            "paired_image_id": r.paired_image_id,
            "original_filename": r.original_filename,
        }
        for r in rows
    ]
    return Response(
        content=json.dumps({"images": images}, separators=(",", ":")),
        media_type="application/json",
    )


@router.get("/count", response_model=schemas.ImageCountOut)
def count_images(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """How many photos the current filter set matches in total. The library
    sizes its scrollbar from this - the scroll range covers the whole
    (filtered) library, not just the pages fetched so far."""
    query = _filtered_images_query(
        db, current_user, view_mode, album_id, rating_min, color_label,
        camera_model, lens_model, focal_min, focal_max, country, date_from, date_to, tags,
    )
    return schemas.ImageCountOut(count=query.count())


@router.get("/facets", response_model=schemas.LibraryFacets)
def list_facets(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Distinct values for the filter dropdowns, each with a photo count.
    Cross-filtered: every facet is computed under all the *other* active
    filters but never its own - picking a camera immediately narrows the lens
    and focal-length options to what that camera actually shot, while the
    camera list itself keeps its alternatives selectable. Regions are
    reverse-geocoded lazily here for any geotagged photo not yet resolved, so
    they populate without a separate maintenance pass."""
    base = db.query(Image).filter(Image.owner_id == current_user.id, Image.deleted_at.is_(None))
    base = sources_service.exclude_unavailable(
        base, sources_service.unavailable_source_ids(db, current_user.id)
    )

    # Backfill any geotagged photos missing a country (e.g. imported before this
    # feature, or restored from a backup), then commit before counting. Runs on
    # the unfiltered library so a filtered view can't leave stragglers.
    missing = base.filter(Image.gps_lat.isnot(None), Image.gps_country.is_(None)).all()
    if missing and geocode.annotate_images(missing):
        db.commit()

    def scoped(*, without: str) -> "Query":
        """The current filter set with one dimension (the facet's own) lifted."""
        return _filtered_images_query(
            db, current_user, view_mode, album_id, rating_min, color_label,
            None if without == "camera" else camera_model,
            None if without == "lens" else lens_model,
            None if without == "focal" else focal_min,
            None if without == "focal" else focal_max,
            None if without == "country" else country,
            date_from, date_to, tags,
        )

    cameras = [
        schemas.Facet(value=value, count=count)
        for value, count in (
            scoped(without="camera")
            .with_entities(Image.camera_model, func.count(Image.id))
            .filter(Image.camera_model.isnot(None), Image.camera_model != "")
            .group_by(Image.camera_model)
            .order_by(func.count(Image.id).desc())
            .all()
        )
    ]
    lenses = [
        schemas.Facet(value=value, count=count)
        for value, count in (
            scoped(without="lens")
            .with_entities(Image.lens_model, func.count(Image.id))
            .filter(Image.lens_model.isnot(None), Image.lens_model != "")
            .group_by(Image.lens_model)
            .order_by(func.count(Image.id).desc())
            .all()
        )
    ]
    # Focal lengths grouped to 0.1mm (matches the filter's tolerance) and sorted
    # numerically - the slider's stops; values formatted for display ("23", not
    # "23.0").
    focal_expr = func.round(Image.focal_length, 1)
    focal_lengths = [
        schemas.Facet(
            value=str(int(value)) if float(value).is_integer() else str(value),
            count=count,
        )
        for value, count in (
            scoped(without="focal")
            .with_entities(focal_expr, func.count(Image.id))
            .filter(Image.focal_length.isnot(None), Image.focal_length > 0)
            .group_by(focal_expr)
            .order_by(focal_expr.asc())
            .all()
        )
    ]
    region_base = scoped(without="country")
    regions = [
        schemas.Facet(value=value, count=count)
        for value, count in (
            region_base.with_entities(Image.gps_country, func.count(Image.id))
            .filter(Image.gps_country.isnot(None))
            .group_by(Image.gps_country)
            .order_by(func.count(Image.id).desc())
            .all()
        )
    ]
    no_location = region_base.filter(Image.gps_lat.is_(None)).count()
    return schemas.LibraryFacets(
        cameras=cameras,
        lenses=lenses,
        focal_lengths=focal_lengths,
        regions=regions,
        no_location_count=no_location,
    )


@router.get("/trash", response_model=list[schemas.ImageOut])
def list_trash(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Managed photos only: deleted source-root photos are also soft-deleted
    # rows, but they act as permanent scan-exclusion markers, not as trash
    # entries (there is no file of ours to delete or bring back).
    return (
        db.query(Image)
        .options(selectinload(Image.paired_image))
        .filter(
            Image.owner_id == current_user.id,
            Image.deleted_at.isnot(None),
            Image.source_root_id.is_(None),
        )
        .order_by(Image.deleted_at.desc())
        .all()
    )


@router.post("/trash/restore", response_model=list[schemas.ImageOut])
def restore_from_trash(
    payload: schemas.BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    for image in images:
        image.deleted_at = None
    db.commit()
    # Restored photos are upload candidates again - put them back on Immich now
    # rather than on the next timed pass.
    run_immich_sync_soon()
    for image in images:
        db.refresh(image)
    return images


def _require_library_mounted() -> None:
    """Refuse permanent deletions while the library folder is unreachable (the
    external drive is asleep/unplugged): the rows would vanish but the actual
    files would sit orphaned on the absent drive forever."""
    if not settings.library_root.is_dir():
        raise HTTPException(
            status_code=409,
            detail="Your library drive is not connected. Reconnect it before permanently "
            "deleting photos - otherwise the files would be left behind on the drive.",
        )


@router.post("/trash/delete", status_code=204)
def delete_from_trash(
    payload: schemas.BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete photos that are already in the Trash - this is the
    step that actually removes the original files from the library folder."""
    _require_library_mounted()
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    if any(image.deleted_at is None for image in images):
        raise HTTPException(
            status_code=400,
            detail="Only photos in the Trash can be permanently deleted. Move them to the Trash first.",
        )
    # Deleted source-root photos are skipped: their row must survive as the
    # marker that keeps re-scans from re-indexing the (untouched) file.
    managed = [image for image in images if image.source_root_id is None]
    trash_service.hard_delete_images(db, managed, delete_files=True)
    db.commit()
    run_immich_sync_soon()


@router.post("/trash/empty", status_code=204)
def empty_trash(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _require_library_mounted()
    images = (
        db.query(Image)
        .filter(
            Image.owner_id == current_user.id,
            Image.deleted_at.isnot(None),
            Image.source_root_id.is_(None),
        )
        .all()
    )
    trash_service.hard_delete_images(db, images, delete_files=True)
    db.commit()
    run_immich_sync_soon()


@router.get("/{image_id}", response_model=schemas.ImageOut)
def get_image(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_owned_image(db, current_user.id, image_id)


@router.patch("/bulk", response_model=list[schemas.ImageOut])
def bulk_update_images(
    update: schemas.BulkImageUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    images = [get_owned_image(db, current_user.id, image_id) for image_id in update.image_ids]
    for image in images:
        if update.rating is not None:
            image.rating = update.rating
        if update.color_label is not None:
            image.color_label = update.color_label
        if update.apply_to_pair:
            _apply_to_pair(db, current_user.id, image, update.rating, update.color_label)
    db.commit()
    for image in images:
        db.refresh(image)
    return images


@router.post("/bulk-delete", status_code=204)
def bulk_delete_images(
    payload: schemas.BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Deleting means different things for the two kinds of photos:

    - Managed (imported into the library): soft-delete into the in-app Trash.
      The file stays in the library folder; it's only removed for good when the
      photo is permanently deleted from the Trash (see /trash/delete).
    - Indexed in place from a source root: removed from the library for good,
      but the row is kept (soft-deleted, never listed in the Trash). The kept
      row is what stops the next source scan from simply re-indexing the file -
      scans skip paths that are already in the DB. The original file is never
      touched; importing the same bytes later revives the entry as a managed
      photo (see import_pipeline.commit_import_session).
    """
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    now = datetime.now(timezone.utc)
    for image in images:
        image.deleted_at = now
    db.commit()
    # Synced photos must leave Immich as soon as they're trashed (they come
    # back if restored) - wake the sync loop instead of waiting a minute.
    run_immich_sync_soon()


@router.post("/download-zip")
def download_zip(
    payload: schemas.BulkDownloadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bundle the originals for a set of images (the download "basket") into a
    single zip the browser can save in one go."""
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    if not images:
        raise HTTPException(status_code=400, detail="No images to download")

    buffer = io.BytesIO()
    # ZIP_STORED (no compression): JPEG/RAW are already compressed, so deflating
    # them again just burns CPU for a negligible size win.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        used_names: dict[str, int] = {}
        for image in images:
            path = resolve_image_path(image)
            if not path.exists():
                continue
            # Two different images can share an original filename; suffix later
            # collisions so nothing gets silently overwritten inside the zip.
            name = image.original_filename
            if name in used_names:
                used_names[name] += 1
                stem = Path(name)
                name = f"{stem.stem}_{used_names[name]}{stem.suffix}"
            else:
                used_names[name] = 0
            archive.write(path, arcname=name)

    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="photos.zip"'},
    )


@router.post("/export")
def export_images(
    payload: schemas.ExportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export photos as flattened JPEGs with their saved edits baked in, at a
    caller-chosen quality and optional long-edge size. One photo streams back as
    a plain JPEG, several as a zip. Every photo goes through the same TRUE
    full-resolution render as save-copy (serialised by _full_render_lock), so a
    large RAW selection takes a while - the client shows a busy state."""
    if not payload.image_ids:
        raise HTTPException(status_code=400, detail="No images to export")
    quality = max(1, min(100, payload.quality))
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]

    def render_jpeg(image: Image) -> bytes:
        return thumbnails.export_jpeg_bytes(image, quality, payload.max_size)

    if len(images) == 1:
        try:
            data = render_jpeg(images[0])
        except Exception:
            logger.exception("Export render failed for %s", images[0].id)
            raise HTTPException(status_code=500, detail="Could not render the export")
        filename = f"{Path(images[0].original_filename).stem}.jpg"
        return Response(
            content=data,
            media_type="image/jpeg",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # Multi-photo export: spool the zip to a disk-backed temp file - dozens of
    # full-resolution JPEGs would otherwise pile up in memory. ZIP_STORED, same
    # as download-zip: the JPEGs are already compressed.
    tmp = tempfile.TemporaryFile()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as archive:
        used_names: dict[str, int] = {}
        for image in images:
            try:
                data = render_jpeg(image)
            except Exception:
                # One broken photo shouldn't sink the whole export - skip it.
                logger.exception("Export render failed for %s - skipping", image.id)
                continue
            # Exports are always .jpg, so a RAW+JPEG pair (DSCF0001.RAF /
            # DSCF0001.JPG) collides on its stem - suffix later collisions.
            name = f"{Path(image.original_filename).stem}.jpg"
            if name in used_names:
                used_names[name] += 1
                name = f"{Path(name).stem}_{used_names[name]}.jpg"
            else:
                used_names[name] = 0
            archive.writestr(name, data)

    tmp.seek(0)
    return StreamingResponse(
        tmp,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="export.zip"'},
    )


# ---- Progress-reporting export jobs ------------------------------------------
# The synchronous /export endpoint above can only offer a spinner: the response
# starts after every photo has rendered. These job endpoints let the export
# dialog show a real per-photo progress bar: /export/start spawns a worker
# thread that renders into a temp file while bumping a counter, the client
# polls /export/{id}/progress, fetches /export/{id}/result once ready, and can
# abort between photos via DELETE. Jobs are in-memory (single-process app);
# abandoned ones (crashed client) are pruned after a TTL.

_EXPORT_JOB_TTL_S = 30 * 60
_export_jobs: dict[str, dict] = {}
_export_jobs_lock = threading.Lock()


def _drop_export_job(job_id: str) -> None:
    with _export_jobs_lock:
        job = _export_jobs.pop(job_id, None)
    if job and job.get("path"):
        Path(job["path"]).unlink(missing_ok=True)


def _prune_export_jobs() -> None:
    now = time.monotonic()
    with _export_jobs_lock:
        stale = [jid for jid, job in _export_jobs.items() if now - job["created"] > _EXPORT_JOB_TTL_S]
    for jid in stale:
        _drop_export_job(jid)


def _run_export_job(job_id: str, owner_id: int, payload: schemas.ExportStartRequest) -> None:
    job = _export_jobs[job_id]

    def cancelled() -> bool:
        return job["state"] == "cancelled"

    db = SessionLocal()
    fd, tmp_path = tempfile.mkstemp(prefix="pm-export-")
    os.close(fd)
    try:
        images = (
            db.query(Image)
            .filter(Image.owner_id == owner_id, Image.id.in_(payload.image_ids))
            .all()
        )
        # Preserve the caller's ordering (query order is unspecified).
        by_id = {img.id: img for img in images}
        images = [by_id[i] for i in payload.image_ids if i in by_id]
        quality = max(1, min(100, payload.quality))

        def render_jpeg(image: Image) -> bytes:
            return thumbnails.export_jpeg_bytes(image, quality, payload.max_size)

        if len(images) == 1:
            image = images[0]
            if payload.format == "original":
                shutil.copyfile(resolve_image_path(image), tmp_path)
                filename = image.original_filename
                media = "image/jpeg" if image.file_type == FileType.jpeg else "application/octet-stream"
            else:
                Path(tmp_path).write_bytes(render_jpeg(image))
                filename = f"{Path(image.original_filename).stem}.jpg"
                media = "image/jpeg"
            job["done"] = 1
        else:
            # ZIP_STORED like the synchronous endpoints: JPEGs (and compressed
            # RAWs) don't shrink further, they'd only cost CPU.
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED) as archive:
                used_names: dict[str, int] = {}
                for image in images:
                    if cancelled():
                        return
                    try:
                        if payload.format == "original":
                            data = None
                            src = resolve_image_path(image)
                            name = image.original_filename
                        else:
                            data = render_jpeg(image)
                            name = f"{Path(image.original_filename).stem}.jpg"
                    except Exception:
                        # One broken photo shouldn't sink the whole export.
                        logger.exception("Export job render failed for %s - skipping", image.id)
                        job["done"] += 1
                        continue
                    # Suffix filename collisions (RAW+JPEG pairs share a stem).
                    if name in used_names:
                        used_names[name] += 1
                        stem = Path(name)
                        name = f"{stem.stem}_{used_names[name]}{stem.suffix}"
                    else:
                        used_names[name] = 0
                    if data is None:
                        archive.write(src, arcname=name)
                    else:
                        archive.writestr(name, data)
                    job["done"] += 1
            filename = "export.zip" if payload.format == "jpeg" else "photos.zip"
            media = "application/zip"
        if cancelled():
            return
        job.update(path=tmp_path, filename=filename, media=media, state="ready")
    except Exception as e:
        logger.exception("Export job %s failed", job_id)
        job.update(state="error", error=str(e) or "Export failed")
    finally:
        db.close()
        if job["state"] != "ready":
            Path(tmp_path).unlink(missing_ok=True)


@router.post("/export/start", response_model=schemas.ExportStartResponse)
def export_start(
    payload: schemas.ExportStartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.image_ids:
        raise HTTPException(status_code=400, detail="No images to export")
    _prune_export_jobs()
    # Validate ownership up front so the worker can assume clean input.
    for image_id in payload.image_ids:
        get_owned_image(db, current_user.id, image_id)
    job_id = uuid4().hex
    job = {
        "done": 0,
        "total": len(payload.image_ids),
        "state": "running",
        "path": None,
        "filename": None,
        "media": None,
        "error": None,
        "created": time.monotonic(),
    }
    with _export_jobs_lock:
        _export_jobs[job_id] = job
    threading.Thread(
        target=_run_export_job,
        args=(job_id, current_user.id, payload),
        name=f"export-{job_id[:8]}",
        daemon=True,
    ).start()
    return schemas.ExportStartResponse(job_id=job_id, total=job["total"])


def _get_export_job(job_id: str) -> dict:
    job = _export_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown export job")
    return job


@router.get("/export/{job_id}/progress", response_model=schemas.ExportJobProgress)
def export_progress(job_id: str, current_user: User = Depends(get_current_user)):
    job = _get_export_job(job_id)
    return schemas.ExportJobProgress(
        done=job["done"],
        total=job["total"],
        state=job["state"],
        filename=job["filename"],
        error=job["error"],
    )


@router.get("/export/{job_id}/result")
def export_result(job_id: str, current_user: User = Depends(get_current_user)):
    job = _get_export_job(job_id)
    if job["state"] != "ready":
        raise HTTPException(status_code=409, detail="Export not finished")
    # The temp file is deleted (and the job dropped) after the response has
    # streamed - the result is a one-shot download.
    return FileResponse(
        job["path"],
        media_type=job["media"],
        filename=job["filename"],
        background=BackgroundTask(_drop_export_job, job_id),
    )


@router.delete("/export/{job_id}")
def export_cancel(job_id: str, current_user: User = Depends(get_current_user)):
    job = _get_export_job(job_id)
    if job["state"] == "running":
        # The worker checks between photos, cleans up its temp file and skips
        # the "ready" transition; the job row itself falls to the TTL prune.
        job["state"] = "cancelled"
    else:
        _drop_export_job(job_id)
    return Response(status_code=204)


@router.post("/immich", response_model=schemas.ImmichPushResult)
def push_images_to_immich(
    payload: schemas.ImmichPushRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Push already-imported library photos to Immich. Only works when the
    Immich integration is configured in Settings. Mirrors the import option:
    JPEGs are uploaded, RAW/other files are skipped. Immich does its own
    checksum-based dedup, so re-pushing the same photo is safe."""
    immich = get_immich_config(db)
    if immich is None:
        raise HTTPException(
            status_code=400,
            detail="Immich isn't configured. Add the host and API key under Settings first.",
        )

    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    uploaded = duplicate = skipped = failed = 0
    for image in images:
        # Same policy as import: only JPEGs go to Immich, never RAW originals.
        if image.file_type != FileType.jpeg:
            skipped += 1
            continue
        path = resolve_image_path(image)
        if not path.exists():
            failed += 1
            continue
        album_names = _immich_album_names(db, image, immich)
        try:
            status, asset_id = immich_service.upload_asset(
                immich.base_url, immich.api_key, path, image.taken_at
            )
            store_immich_asset_id(image.id, asset_id)
            if status == "duplicate":
                duplicate += 1
            else:
                uploaded += 1
            # Mirror the photo's (flagged) albums into Immich albums.
            for name in album_names:
                try:
                    album_id = immich_service.get_or_create_album(
                        immich.base_url, immich.api_key, name
                    )
                    immich_service.add_assets_to_album(
                        immich.base_url, immich.api_key, album_id, [asset_id]
                    )
                except Exception:
                    logger.exception("Immich album add failed for image %s -> %r", image.id, name)
        except Exception:
            logger.exception("Immich upload failed for image %s", image.id)
            failed += 1

    parts = [f"{uploaded} uploaded"]
    if duplicate:
        parts.append(f"{duplicate} already on Immich")
    if skipped:
        parts.append(f"{skipped} skipped (RAW/non-JPEG)")
    if failed:
        parts.append(f"{failed} failed")
    return schemas.ImmichPushResult(
        uploaded=uploaded, duplicate=duplicate, skipped=skipped, failed=failed,
        message=", ".join(parts) + ".",
    )


@router.post("/immich-sync", response_model=list[schemas.ImageOut])
def set_images_immich_sync(
    payload: schemas.ImmichSyncToggleRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Flag/unflag photos for selective Immich sync. Flagging on also queues an
    immediate background upload of each JPEG (with its flagged albums mirrored);
    unflagging just clears the flag - photos already on Immich are left there."""
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    for image in images:
        image.immich_sync = payload.enabled
    db.commit()

    immich = get_immich_config(db)
    if payload.enabled and immich is not None:
        for image in images:
            if image.file_type != FileType.jpeg:
                continue
            path = resolve_image_path(image)
            if not path.exists():
                continue
            enqueue_immich_upload(
                immich.base_url,
                immich.api_key,
                path,
                image.taken_at,
                _immich_album_names(db, image, immich),
                image_id=image.id,
            )
    for image in images:
        db.refresh(image)
    return images


@router.post("/bulk-tags", response_model=list[schemas.ImageOut])
def bulk_add_tags(
    payload: schemas.BulkTagRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    for image in images:
        for name in payload.tag_names:
            _add_tag_to_image(db, current_user.id, image, name)
    db.commit()
    for image in images:
        db.refresh(image)
    return images


@router.post("/bulk-reset", response_model=list[schemas.ImageOut])
def bulk_reset_metadata(
    payload: schemas.BulkResetRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reset the selected aspects of each photo back to its just-imported state.
    Which aspects are cleared is chosen per-flag (see BulkResetRequest): rating,
    colour label, tags, develop sliders, geometry (crop/rotation/...), and album
    membership. Photos whose develop or geometry was reset get re-rendered."""
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    image_ids = [image.id for image in images]

    if payload.tags:
        db.query(ImageTag).filter(ImageTag.image_id.in_(image_ids)).delete(synchronize_session=False)
    if payload.albums:
        db.query(AlbumImage).filter(AlbumImage.image_id.in_(image_ids)).delete(synchronize_session=False)

    for image in images:
        if payload.rating:
            image.rating = 0
        if payload.color_label:
            image.color_label = ColorLabel.none
        if payload.develop:
            image.edit_adjustments = None
        if payload.geometry:
            image.edit_rotation = 0
            image.edit_crop_x = image.edit_crop_y = image.edit_crop_width = image.edit_crop_height = None
            image.edit_flip_h = image.edit_flip_v = False
            image.edit_straighten = 0.0
            image.edit_persp_h = image.edit_persp_v = image.edit_distortion = 0
        # Re-derive the "edit" tag / cache-buster whenever an edit was touched, or
        # when a tag reset may have stripped the auto "edit" tag off a still-edited
        # photo.
        if payload.develop or payload.geometry or payload.tags:
            _sync_edit_state(db, current_user.id, image)

    db.commit()
    edited = payload.develop or payload.geometry
    for image in images:
        db.refresh(image)
        if edited:
            _try_regenerate_derivatives(image)
    return images


@router.post("/bulk-develop", response_model=list[schemas.ImageOut])
def bulk_develop(
    payload: schemas.BulkDevelopRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Apply one develop object (e.g. an editor preset) to every selected photo
    in place and re-render them. Geometry is left untouched - a preset is a look,
    not a composition - and a neutral object simply clears the develop sliders."""
    blob = develop.dumps(develop.normalize(payload.adjustments))
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    for image in images:
        image.edit_adjustments = blob
        _sync_edit_state(db, current_user.id, image)
    db.commit()
    for image in images:
        db.refresh(image)
        _try_regenerate_derivatives(image)
    return images


@router.post("/bulk-auto-develop", response_model=schemas.BulkAutoDevelopResult)
def bulk_auto_develop(
    payload: schemas.BulkAutoDevelopRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Auto-develop every selected photo: each gets its own suggestion learned
    from the user's saved edits (CLIP k-NN), restricted to the groups enabled in
    Settings and merged over that photo's current develop state. Photos with no
    embedding yet, or nothing similar to learn from, are skipped and counted."""
    groups = get_auto_develop_groups(db)
    if not groups:
        raise HTTPException(
            status_code=400,
            detail="Auto develop is set to affect no settings - enable at least one group in Settings",
        )
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    changed: list[Image] = []
    for image in images:
        vector = _embedding_for_image(image)
        if vector is None:
            continue
        suggestion = auto_develop.suggest_adjustments(db, engine, image, vector)
        if suggestion is None:
            continue
        adjustments, _ = suggestion
        partial = auto_develop.filter_to_groups(adjustments, groups)
        # Merge over this photo's own current develop state, exactly like the
        # editor spreads the suggestion over its live sliders (defaults when the
        # photo is un-edited); unchecked groups keep whatever was there.
        merged = {**develop.loads(image.edit_adjustments), **partial}
        image.edit_adjustments = develop.dumps(develop.normalize(merged))
        _sync_edit_state(db, current_user.id, image)
        changed.append(image)
    db.commit()
    for image in images:
        db.refresh(image)
    for image in changed:
        _try_regenerate_derivatives(image)
    return schemas.BulkAutoDevelopResult(
        images=images, applied=len(changed), skipped=len(images) - len(changed)
    )


@router.patch("/{image_id}", response_model=schemas.ImageOut)
def update_image(
    image_id: str,
    update: schemas.ImageUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    if update.rating is not None:
        image.rating = update.rating
    if update.color_label is not None:
        image.color_label = update.color_label
    if update.description is not None:
        # "" means "cleared" - stored as NULL so an empty note and no note are
        # the same thing everywhere downstream.
        image.description = update.description.strip() or None
    if update.apply_to_pair:
        _apply_to_pair(db, current_user.id, image, update.rating, update.color_label)
    db.commit()
    db.refresh(image)
    return image


# Characters no sane filename carries, and that Windows outright forbids: path
# separators (a rename is not a move), the reserved punctuation, and control
# bytes. Checked on the *typed* name so the error names the real problem
# instead of some silently mangled result.
_ILLEGAL_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _renamed_filename(typed: str, current_suffix: str) -> str:
    """Turn what the user typed into the actual new filename, keeping the
    photo's extension.

    The extension is what makes a RAF a RAF, so it is never up for editing: a
    typed name that already ends in it has it stripped (the UI shows it, and
    people re-type it), anything else is taken as the stem whole - dots inside
    a name like "Sunset 2026.07.14" are part of the name, not a new extension.
    """
    stem = typed.strip()
    if not stem:
        raise HTTPException(status_code=400, detail="The name can't be empty.")
    if _ILLEGAL_NAME_CHARS.search(stem):
        raise HTTPException(
            status_code=400,
            detail="A file name can't contain / \\ : * ? \" < > or |.",
        )
    if current_suffix and stem.lower().endswith(current_suffix.lower()):
        stem = stem[: -len(current_suffix)].strip()
    # After stripping the extension there has to be something left, and a name
    # that is only dots is a directory reference, not a file.
    if not stem or set(stem) == {"."}:
        raise HTTPException(status_code=400, detail="The name can't be empty.")
    new_name = f"{stem}{current_suffix}"
    # The common filesystem cap is 255 *bytes*, which non-ASCII names hit far
    # sooner than their character count suggests.
    if len(new_name.encode("utf-8")) > 255:
        raise HTTPException(status_code=400, detail="That name is too long.")
    return new_name


def _stored_path(image: Image, path: Path) -> str:
    """The value Image.file_path takes for `path` - relative to the library
    root for managed photos, absolute for ones indexed from a source root.
    The inverse of services.filesystem.resolve_image_path."""
    return str(path) if image.source_root_id else str(path.relative_to(settings.library_root))


def _check_rename_target(db: Session, image: Image, source: Path, target: Path) -> None:
    """Refuse a rename that would land on top of something else. Both the disk
    and the catalog get a say: a path can be free on disk yet still claimed by
    a row whose file went missing, and re-using it would break that row's way
    back (UNIQUE on file_path)."""
    if target.exists() and not target.samefile(source):
        raise HTTPException(
            status_code=409, detail=f"“{target.name}” already exists in this folder."
        )
    taken = (
        db.query(Image.id)
        .filter(Image.file_path == _stored_path(image, target), Image.id != image.id)
        .first()
    )
    if taken:
        raise HTTPException(
            status_code=409, detail=f"Another photo in the library is already called “{target.name}”."
        )


@router.post("/{image_id}/rename", response_model=schemas.ImageRenameResult)
def rename_image(
    image_id: str,
    payload: schemas.ImageRenameRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename a photo's file on disk and follow it in the catalog.

    This really does rename the original - it is the one place in the app that
    writes to the user's file rather than layering something on top of it - so
    the file and what the library calls it never drift apart. The photo keeps
    its id, and with it every rating, tag, album, edit and cached derivative.

    By default the RAW/JPEG partner is renamed to the same stem (keeping its
    own extension), so one shot stays one name on disk. If only the partner's
    rename fails the photo's own still stands, reported via `pair_error`.
    """
    image = get_owned_image(db, current_user.id, image_id)
    source = resolve_image_path(image)
    if not source.exists():
        raise HTTPException(
            status_code=409,
            detail="This photo's file isn't reachable right now, so it can't be renamed.",
        )

    new_name = _renamed_filename(payload.name, source.suffix)
    target = source.with_name(new_name)
    if target == source:
        return schemas.ImageRenameResult(image=image)
    _check_rename_target(db, image, source, target)

    # The partner is resolved (and vetted) before anything moves, so a partner
    # we can't rename doesn't leave the pair half-done - it just isn't renamed.
    partner: Image | None = None
    partner_source: Path | None = None
    partner_target: Path | None = None
    pair_error: str | None = None
    if payload.rename_pair and image.paired_image_id:
        candidate = db.get(Image, image.paired_image_id)
        # Not across the Trash: a half sitting in the Trash isn't part of the
        # pair right now (the client isn't even told about it), and renaming it
        # along would quietly touch a file the user deleted.
        if (
            candidate is not None
            and candidate.owner_id == current_user.id
            and (candidate.deleted_at is None) == (image.deleted_at is None)
        ):
            partner_source = resolve_image_path(candidate)
            if not partner_source.exists():
                pair_error = f"{candidate.original_filename} isn't reachable - it kept its name."
                partner_source = None
            else:
                partner_target = partner_source.with_name(
                    f"{Path(new_name).stem}{partner_source.suffix}"
                )
                try:
                    _check_rename_target(db, candidate, partner_source, partner_target)
                    partner = candidate
                except HTTPException as exc:
                    pair_error = f"{candidate.original_filename} kept its name: {exc.detail}"
                    partner_source = partner_target = None

    renamed: list[tuple[Path, Path]] = []
    try:
        source.rename(target)
        renamed.append((target, source))
        if partner is not None and partner_source is not None and partner_target is not None:
            partner_source.rename(partner_target)
            renamed.append((partner_target, partner_source))

        image.file_path = _stored_path(image, target)
        image.original_filename = target.name
        if partner is not None and partner_target is not None:
            partner.file_path = _stored_path(partner, partner_target)
            partner.original_filename = partner_target.name
        db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        # Put every file back before surfacing the failure: a rename that made
        # it to disk but not into the database would look to the next library
        # sync exactly like a file the user renamed in Finder.
        for moved, original in reversed(renamed):
            try:
                moved.rename(original)
            except OSError:
                logger.exception("Could not undo rename of %s", moved)
        db.rollback()
        logger.exception("Rename failed for image %s", image_id)
        raise HTTPException(status_code=500, detail=f"Could not rename the file: {exc}") from exc

    db.refresh(image)
    return schemas.ImageRenameResult(
        image=image,
        paired_filename=partner.original_filename if partner is not None else None,
        pair_error=pair_error,
    )


@router.post("/{image_id}/tags", response_model=schemas.ImageOut)
def add_tag(
    image_id: str,
    payload: schemas.AddTagRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Tag name can't be empty")
    _add_tag_to_image(db, current_user.id, image, payload.name)
    db.commit()
    db.refresh(image)
    return image


@router.delete("/{image_id}/tags/{tag_name}", response_model=schemas.ImageOut)
def remove_tag(
    image_id: str,
    tag_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    tag = db.query(Tag).filter(Tag.owner_id == current_user.id, Tag.name == tag_name).first()
    if tag:
        db.query(ImageTag).filter(ImageTag.image_id == image.id, ImageTag.tag_id == tag.id).delete()
        db.commit()
    db.refresh(image)
    return image


@router.patch("/{image_id}/rotate", response_model=schemas.ImageOut)
def rotate_image(
    image_id: str,
    payload: schemas.RotateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.degrees % 90 != 0:
        raise HTTPException(status_code=400, detail="degrees must be a multiple of 90")
    image = get_owned_image(db, current_user.id, image_id)
    image.edit_rotation = (image.edit_rotation + payload.degrees) % 360
    # A crop drawn against the old orientation doesn't map onto the new one.
    image.edit_crop_x = image.edit_crop_y = image.edit_crop_width = image.edit_crop_height = None
    image.edit_rev = (image.edit_rev or 0) + 1
    db.commit()
    db.refresh(image)
    _try_regenerate_derivatives(image)
    return image


@router.patch("/{image_id}/crop", response_model=schemas.ImageOut)
def crop_image(
    image_id: str,
    payload: schemas.CropRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    if payload.crop is None:
        image.edit_crop_x = image.edit_crop_y = image.edit_crop_width = image.edit_crop_height = None
    else:
        c = payload.crop
        if not (0 <= c.x < 1 and 0 <= c.y < 1 and 0 < c.width <= 1 - c.x and 0 < c.height <= 1 - c.y):
            raise HTTPException(status_code=400, detail="Crop box must be within the image bounds")
        image.edit_crop_x, image.edit_crop_y = c.x, c.y
        image.edit_crop_width, image.edit_crop_height = c.width, c.height
    image.edit_rev = (image.edit_rev or 0) + 1
    db.commit()
    db.refresh(image)
    _try_regenerate_derivatives(image)
    return image


@router.get("/{image_id}/base-preview")
def base_preview(
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Geometry-only JPEG (rotation/crop, no tonal edits) that the editor draws
    its live preview on. Rendered on the fly - it's only fetched while editing."""
    image = get_owned_image(db, current_user.id, image_id)
    try:
        data = thumbnails.render_base_preview_bytes(image)
    except Exception:
        logger.exception("Base preview render failed for image %s", image.id)
        raise HTTPException(status_code=404, detail="Could not render preview")
    return Response(content=data, media_type="image/jpeg")


_clamp100 = lambda v: max(-100, min(100, int(v)))  # noqa: E731


def _validate_crop(crop: schemas.CropBox | None) -> None:
    if crop is None:
        return
    if not (0 <= crop.x < 1 and 0 <= crop.y < 1 and 0 < crop.width <= 1 - crop.x and 0 < crop.height <= 1 - crop.y):
        raise HTTPException(status_code=400, detail="Crop box must be within the image bounds")


@router.patch("/{image_id}/edits", response_model=schemas.ImageOut)
def save_edits(
    image_id: str,
    payload: schemas.ImageEdits,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save the full non-destructive edit (rotation + crop + tonal sliders) in
    place and re-render this photo's derivatives. The original file on disk is
    never modified - resetting everything restores the original look."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
    image = get_owned_image(db, current_user.id, image_id)
    image.edit_rotation = payload.rotation % 360
    if payload.crop is None:
        image.edit_crop_x = image.edit_crop_y = image.edit_crop_width = image.edit_crop_height = None
    else:
        c = payload.crop
        image.edit_crop_x, image.edit_crop_y = c.x, c.y
        image.edit_crop_width, image.edit_crop_height = c.width, c.height
    image.edit_flip_h = bool(payload.flip_h)
    image.edit_flip_v = bool(payload.flip_v)
    image.edit_straighten = max(-45.0, min(45.0, float(payload.straighten)))
    image.edit_persp_h = _clamp100(payload.persp_h)
    image.edit_persp_v = _clamp100(payload.persp_v)
    image.edit_distortion = _clamp100(payload.distortion)
    adj = develop.normalize(payload.adjustments)
    image.edit_adjustments = develop.dumps(adj)
    # Tag edited photos "edit" so they're easy to find; drop the tag if the edit
    # was reset back to the original look. Bump the per-image cache-buster so the
    # thumbnail/preview URLs refresh; a reset back to neutral drops it to 0 (no ?v=).
    has_edit = bool(
        payload.rotation % 360
        or payload.crop is not None
        or payload.flip_h
        or payload.flip_v
        or image.edit_straighten
        or payload.persp_h
        or payload.persp_v
        or payload.distortion
        or image.edit_adjustments is not None
    )
    image.edit_rev = (image.edit_rev or 0) + 1 if has_edit else 0
    if has_edit:
        _add_tag_to_image(db, current_user.id, image, "edit")
    else:
        _remove_tag_from_image(db, current_user.id, image, "edit")
    db.commit()
    db.refresh(image)
    _try_regenerate_derivatives(image)
    run_backup_soon()
    return image


def _payload_adjustments(payload: schemas.ImageEdits) -> dict:
    """The normalized develop adjustments dict off an edits payload, ready for the
    thumbnails pipeline. Shared by save-copy and the editor preview."""
    return develop.normalize(payload.adjustments)


# Newest-preview-wins bookkeeping: the editor only ever wants the LATEST render
# of an image, and it aborts stale fetches - but an aborted request's thread
# still runs its render to completion (numpy can't be interrupted, and the
# full/native tiers additionally queue on a lock for seconds each). So each
# incoming preview request marks itself the newest for its image; older ones
# still pending see that and bail (PreviewSuperseded -> 409) instead of
# rendering frames nobody will ever look at.
def _parse_region(raw: str | None) -> tuple[float, float, float, float] | None:
    """"x,y,w,h" as fractions of the finished frame, or None.

    A malformed or empty region is not an error: it means "render the frame the
    way you always did", which is always a correct answer to give.
    """
    if not raw:
        return None
    try:
        x, y, w, h = (float(part) for part in raw.split(","))
    except ValueError:
        return None
    if not (w > 0 and h > 0):
        return None
    x = min(max(x, 0.0), 1.0)
    y = min(max(y, 0.0), 1.0)
    w = min(w, 1.0 - x)
    h = min(h, 1.0 - y)
    if w <= 0 or h <= 0:
        return None
    # A tile that is nearly the whole frame saves nothing and costs the padding.
    if w * h > 0.85:
        return None
    return (x, y, w, h)


# Above this a settled render is something the user waits for, so it is worth a
# line in the log saying which tier spent it.
_SLOW_PREVIEW_MS = 300

_editor_preview_seq = itertools.count(1)
_editor_preview_latest: dict[str, int] = {}
_editor_preview_state_lock = threading.Lock()


@router.post("/{image_id}/editor-preview")
def editor_preview(
    image_id: str,
    payload: schemas.ImageEdits,
    full: bool = False,
    scrub: bool = False,
    ultra: bool = False,
    native: bool = False,
    browse: bool = False,
    peek: str | None = None,
    region: str | None = None,
    region_px: int | None = None,
    zoomed: bool = False,
    px: int | None = None,
    native_only: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Live editor preview, rendered server-side with the *same* pipeline that
    saves - so what you see while editing is exactly what you get. The decoded
    base image is cached, so only the edit pipeline re-runs per request.
    `?scrub=1` renders the fast, small-base tier drawn while a control is being
    dragged (`&zoomed=1` sizes it up to the accurate tier's base - dragging a
    slider at 100% zoom is judged on detail, and the small base upscaled that
    far is blocks); the default renders the accurate tier on release; `?full=1` renders
    on the larger settled base once the sliders come to rest; `?ultra=1` is one
    step above that, for when the settled render is still shown upscaled (it
    costs no extra decode - see ULTRA_EDITOR_PREVIEW_PX); `?native=1` renders at
    TRUE full resolution - fetched in the background for 100% zoom.

    `?browse=1` renders a raw with the browsing auto-exposure instead of the
    editor's native (dark) base - the "Original" half of the split view, which
    has to be the photo as the library showed it, not the unlifted sensor data.

    `?region=x,y,w,h` (fractions of the finished frame) renders only that part
    of it, for the native tier: zoomed in, the rest of a full-resolution frame
    is seconds of work for pixels that are off screen. Ignored by every other
    tier, and by edits whose finishing effects need the whole frame (see
    thumbnails.region_is_supported). `&region_px=N` (interactive region frames
    only) caps the tile's rendered long edge to its on-screen size, so a drag
    frame costs the pixels the screen can show rather than the native cut's.

    `?peek=<mask id>` marks that mask's covered area in the frame with the
    editor's zebra, so a luminance / colour / edge mask - none of which has an
    outline that could be drawn over the photo - can be seen while it is being
    set up."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
    image = get_owned_image(db, current_user.id, image_id)
    view_region = _parse_region(region)
    # Clamped, not validated: a nonsense budget degrades to "no cap" or a
    # sane minimum, never to an error - same stance as _parse_region.
    view_region_px = max(256, min(8192, region_px)) if region_px else None
    # `?px=N` (whole-frame scrub only): the editor's adaptive drag resolution.
    # It measures its own frame times and asks for fewer pixels when the edit
    # has grown too expensive to track the pointer at the fixed tier - see the
    # ladder in PhotoEditor. Clamped the same way; other tiers ignore it.
    scrub_px = max(480, min(thumbnails.EDITOR_PREVIEW_PX, px)) if px else None
    # `?native_only=1`: the caller already has this edit state painted from the
    # fallback tier and is only waiting for the full-resolution base. Answering
    # such a poll by re-rendering the multi-second fallback frame it already
    # shows is the single most wasteful thing this endpoint used to do while a
    # 40MP decode was in flight - say "not yet" instead, keep the decode warm,
    # and let the caller come back.
    if native and native_only:
        path = resolve_image_path(image)
        mtime_ns = path.stat().st_mtime_ns
        if not thumbnails.native_base_ready(image.id, mtime_ns):
            thumbnails.warm_native_base(image.id, str(path), mtime_ns)
            return Response(status_code=202, headers={"X-Rollfilm-Tier": "pending"})
    crop = None
    if payload.crop is not None:
        crop = (payload.crop.x, payload.crop.y, payload.crop.width, payload.crop.height)
    # Claim "newest render of this image"; anything older that's still pending
    # (queued behind the full/native lock, or not yet started) becomes stale.
    seq = next(_editor_preview_seq)
    with _editor_preview_state_lock:
        _editor_preview_latest[image_id] = seq

    def _is_stale() -> bool:
        with _editor_preview_state_lock:
            return _editor_preview_latest.get(image_id) != seq

    started = time.perf_counter()
    render_meta: dict = {}
    try:
        data = thumbnails.render_editor_preview_bytes(
            image,
            payload.rotation % 360,
            crop,
            _payload_adjustments(payload),
            distortion=_clamp100(payload.distortion),
            full_quality=full,
            scrub=scrub,
            ultra=ultra,
            native=native,
            flip_h=bool(payload.flip_h),
            flip_v=bool(payload.flip_v),
            straighten=max(-45.0, min(45.0, float(payload.straighten))),
            persp_h=_clamp100(payload.persp_h),
            persp_v=_clamp100(payload.persp_v),
            browse=browse,
            peek=(peek or None),
            region=view_region,
            region_px=view_region_px,
            meta=render_meta,
            zoomed=zoomed,
            scrub_px=scrub_px,
            is_stale=_is_stale,
        )
        if native and not thumbnails.native_base_ready(
            image.id, thumbnails.editor_mtime_ns(image)
        ):
            # The service answered from the preview tier while the base decodes.
            native, ultra = False, True
        # A settled render that takes this long is felt, and which tier asked
        # for it is the first thing anyone debugging "the editor is sluggish"
        # needs to know. Below the threshold it says nothing: the interactive
        # frames are tens of milliseconds and would drown the log.
        elapsed_ms = (time.perf_counter() - started) * 1000
        if elapsed_ms >= _SLOW_PREVIEW_MS:
            tier = ("native" if native else "ultra" if ultra else "full" if full
                    else "scrub" if scrub else "accurate")
            logger.info(
                "editor preview %s%s took %.0f ms (%s)",
                tier,
                " region" if view_region else " whole frame",
                elapsed_ms,
                image_id,
            )
    except thumbnails.PreviewSuperseded:
        # The client has already aborted this fetch; the status only matters to
        # anything that still happens to be listening.
        raise HTTPException(status_code=409, detail="Superseded by a newer preview request")
    except Exception:
        logger.exception("Failed to render editor preview for %s", image.id)
        raise HTTPException(status_code=500, detail="Could not render the preview")
    finally:
        # Drop the bookkeeping entry once the newest render finishes, so the
        # map only ever holds images with a render actually in flight.
        with _editor_preview_state_lock:
            if _editor_preview_latest.get(image_id) == seq:
                del _editor_preview_latest[image_id]
    # What was actually rendered, which is not always what was asked for: a
    # native request whose full-resolution base is still decoding is answered
    # from the tier below (see thumbnails.warm_native_base). The editor reads
    # this to know it should come back for the sharp one.
    served = "native" if native else "ultra" if ultra else "full" if full else "scrub" if scrub else "accurate"
    headers = {"X-Rollfilm-Tier": served}
    if render_meta.get("frame"):
        # A region render: the tile plus exactly where it belongs. The client
        # composites it into its copy of the frame - one canvas, no overlay to
        # mis-register against the picture underneath.
        fw, fh = render_meta["frame"]
        bx, by = render_meta["box"]
        bw, bh = render_meta["box_size"]
        headers["X-Rollfilm-Frame"] = f"{fw}x{fh}"
        # x,y,w,h - all in the frame's pixels. The w/h matter when region_px
        # scaled the render: the tile's bitmap is then smaller than its box and
        # the client stretches it to fit.
        headers["X-Rollfilm-Box"] = f"{bx},{by},{bw},{bh}"
    return Response(content=data, media_type="image/jpeg", headers=headers)


# One segmentation at a time per process: the model is a shared object and each
# run wants a few hundred MB of activations, so a user clicking Sky on several
# photos in a row queues instead of stacking.
_segment_lock = threading.Lock()


def _segment_geometry(payload: schemas.SegmentRequest) -> dict:
    """The framing the mask has to be found in, validated."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
    crop = None
    if payload.crop is not None:
        crop = (payload.crop.x, payload.crop.y, payload.crop.width, payload.crop.height)
    return dict(
        rotation=payload.rotation % 360,
        crop=crop,
        distortion=_clamp100(payload.distortion),
        flip_h=bool(payload.flip_h),
        flip_v=bool(payload.flip_v),
        straighten=max(-45.0, min(45.0, float(payload.straighten))),
        persp_h=_clamp100(payload.persp_h),
        persp_v=_clamp100(payload.persp_v),
    )


def _segment_cache_key(image: Image, geometry: dict) -> str:
    """Identifies the exact frame being analysed, so asking for a second subject
    on it (sky, then greenery) reuses the first pass instead of re-running the
    model. The edit revision is in there because saving an edit can change the
    file the frame is decoded from."""
    return f"{image.id}:{image.edit_rev or 0}:" + json.dumps(geometry, sort_keys=True, default=str)


# Frames whose speculative pass is queued or running, so opening and closing the
# Masks panel a few times doesn't queue the same work again and again.
_prepare_inflight: set[str] = set()
_prepare_lock = threading.Lock()


@router.post("/{image_id}/segment/prepare", status_code=202)
def prepare_segmentation(
    image_id: str,
    payload: schemas.SegmentRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run the subject-detection pass for this frame now, in the background.

    The editor calls this when the Masks panel opens - a second or two before
    the user picks a subject. One pass finds all six, so by the time they click
    Sky the answer is usually already in the cache and the click is instant;
    if it isn't, /segment does exactly what it always did. Fire and forget:
    nothing here is returned and a failure is not the user's problem, since the
    real request will surface it."""
    if not segmentation.weights_are_cached():
        return {"status": "unavailable"}
    geometry = _segment_geometry(payload)
    image = get_owned_image(db, current_user.id, image_id)
    cache_key = _segment_cache_key(image, geometry)
    if segmentation.is_cached(cache_key):
        return {"status": "cached"}
    with _prepare_lock:
        if cache_key in _prepare_inflight:
            return {"status": "running"}
        _prepare_inflight.add(cache_key)

    def run() -> None:
        try:
            with SessionLocal() as bg_db:
                bg_image = bg_db.get(Image, image_id)
                if bg_image is None or bg_image.owner_id != current_user.id:
                    return
                # Behind the same lock as a real segmentation, so a speculative
                # pass can never make the user's own click wait for the GPU.
                with _segment_lock:
                    if segmentation.is_cached(cache_key):
                        return
                    framed = thumbnails.render_framed_base_image(bg_image, **geometry)
                    segmentation.segment(framed, "sky", cache_key=cache_key)
        except Exception:
            logger.info("Speculative segmentation for %s did not complete", image_id, exc_info=True)
        finally:
            with _prepare_lock:
                _prepare_inflight.discard(cache_key)

    threading.Thread(target=run, name=f"segment-prepare-{image_id[:8]}", daemon=True).start()
    return {"status": "started"}


@router.post("/{image_id}/segment", response_model=schemas.SegmentOut)
def segment_image(
    image_id: str,
    payload: schemas.SegmentRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Find a named subject (sky, water, greenery, people, buildings, ground) in
    the photo and return it as a soft mask, for the editor to drop into a mask as
    a `semantic` sub-mask. Runs on the framed but untoned image, so the mask lines
    up with the crop the user is looking at."""
    if payload.subject not in segmentation.CLASS_GROUPS:
        raise HTTPException(status_code=400, detail=f"unknown subject {payload.subject!r}")
    geometry = _segment_geometry(payload)
    image = get_owned_image(db, current_user.id, image_id)
    cache_key = _segment_cache_key(image, geometry)
    try:
        with _segment_lock:
            framed = thumbnails.render_framed_base_image(image, **geometry)
            field, peak = segmentation.segment(framed, payload.subject, cache_key=cache_key)
    except segmentation.SegmentationUnavailable as exc:
        # First use downloads ~14MB of weights; offline, that's the failure the
        # editor should explain rather than a bare 500.
        logger.warning("Segmentation unavailable for %s: %s", image_id, exc)
        raise HTTPException(status_code=503, detail="The subject-detection model isn't available yet")
    except Exception:
        logger.exception("Failed to segment %s", image_id)
        raise HTTPException(status_code=500, detail="Could not analyse the photo")
    mask, w, h = segmentation.encode_mask_png(field)
    return schemas.SegmentOut(
        subject=payload.subject,
        mask=mask,
        width=w,
        height=h,
        coverage=float(field.mean()),
        peak=peak,
        found=peak >= segmentation.FOUND_PEAK,
    )


@router.post("/{image_id}/save-copy", response_model=schemas.ImageOut)
def save_copy(
    image_id: str,
    payload: schemas.ImageEdits,
    quality: int = 95,
    max_size: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bake the given edit into a brand-new managed library photo (a flattened
    JPEG), tagged "edited" so edited shots are easy to find. The source photo -
    and every original file on disk - is left completely untouched. `quality`
    and `max_size` (long edge) mirror the export options; a size cap also lets
    the render decode economically instead of at full sensor size."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
    quality = max(1, min(100, quality))
    if max_size is not None:
        max_size = max(16, max_size)
    src = get_owned_image(db, current_user.id, image_id)

    crop = None
    if payload.crop is not None:
        crop = (payload.crop.x, payload.crop.y, payload.crop.width, payload.crop.height)
    adjustments = _payload_adjustments(payload)

    try:
        edited = thumbnails.render_edited_image(
            src,
            payload.rotation % 360,
            crop,
            adjustments,
            distortion=_clamp100(payload.distortion),
            flip_h=bool(payload.flip_h),
            flip_v=bool(payload.flip_v),
            straighten=max(-45.0, min(45.0, float(payload.straighten))),
            persp_h=_clamp100(payload.persp_h),
            persp_v=_clamp100(payload.persp_v),
            max_px=max_size,
        )
    except Exception:
        logger.exception("Failed to render edited copy of %s", src.id)
        raise HTTPException(status_code=500, detail="Could not render the edited copy")

    if max_size and max(edited.size) > max_size:
        edited.thumbnail((max_size, max_size), PILImage.LANCZOS)
    buf = io.BytesIO()
    # At the top of the quality range the copy is meant as a keeper, so drop
    # chroma subsampling too (4:4:4): quality=100 alone still throws away half
    # the colour resolution at libjpeg's default, which shows on saturated
    # edges. Below 95 the copy is deliberately a smaller file - leave the
    # default subsampling there, where it buys most of the size saving.
    subsampling = 0 if quality >= 95 else -1
    edited.save(buf, "JPEG", quality=quality, subsampling=subsampling)
    data = buf.getvalue()

    # Name edited copies "<stem>_edit-1.jpg", "_edit-2", ... - the first free
    # number, so repeated copies of the same photo don't overwrite each other.
    # Strip an existing "_edit-<n>" suffix first, so a copy of a copy counts up
    # (DSCF0048_edit-2.jpg) instead of stacking (DSCF0048_edit-1_edit-1.jpg).
    # library_relative_path itself de-dupes with a "_1" suffix, so probe with it:
    # a taken name comes back changed (e.g. "_edit-1_1.jpg") - bump n and retry -
    # while a free name comes back verbatim. (The old plain exists() check always
    # saw a de-duped, not-yet-existing path, so it never counted past _edit-1.)
    stem = re.sub(r"_edit-\d+$", "", Path(src.original_filename).stem)
    taken_at = src.taken_at or datetime.now(timezone.utc)
    n = 1
    while True:
        candidate = f"{stem}_edit-{n}.jpg"
        rel_path = library_relative_path(taken_at, candidate, settings.library_root)
        if Path(rel_path).name == candidate:
            break
        n += 1
    filename = Path(rel_path).name
    (settings.library_root / rel_path).write_bytes(data)

    new_image = Image(
        owner_id=current_user.id,
        file_path=rel_path,
        source_root_id=None,  # a managed library file, regardless of the source's origin
        original_filename=filename,
        file_hash=hashlib.sha256(data).hexdigest(),
        perceptual_hash=perceptual_hash(edited),
        file_type=FileType.jpeg,
        raw_format=None,
        width=edited.width,
        height=edited.height,
        file_size=len(data),
        taken_at=src.taken_at,
        camera_make=src.camera_make,
        camera_model=src.camera_model,
        iso=src.iso,
        aperture=src.aperture,
        shutter_speed=src.shutter_speed,
        focal_length=src.focal_length,
        gps_lat=src.gps_lat,
        gps_lon=src.gps_lon,
        # Remember the develop settings baked into this copy - not for rendering
        # (the pixels already contain them), but so auto-develop can learn from
        # saved copies too (see services/auto_develop.py).
        applied_adjustments=develop.dumps(adjustments),
    )
    db.add(new_image)
    db.flush()
    _add_tag_to_image(db, current_user.id, new_image, "edit copy")
    db.commit()
    db.refresh(new_image)
    # Generate the copy's thumbnail/preview *synchronously* so the photo is
    # viewable the instant the editor navigates to it - the flattened JPEG is
    # cheap to derive, and doing it async left a blank "no image" for a beat
    # (longer on slow machines). The search embedding still runs in the
    # background since it isn't needed to display the photo.
    try:
        thumbnails.regenerate_for_image(new_image)
    except Exception:
        logger.exception("Derivative generation failed for edited copy %s", new_image.id)
    # The search embedding isn't needed to display the photo - the backfill
    # worker picks the copy up (its preview.jpg was just rendered above).
    schedule_embedding_backfill()
    run_backup_soon()
    return new_image


# How long a thumbnail/preview request waits for SOMEONE ELSE'S render before
# giving up with 503 + Retry-After. It does not bound the render itself: on an
# idle library the lock is free, so the self-heal path this fallback exists for
# still generates inline however long that takes.
#
# Held to the grid's tile budget (THUMB_BUDGET_MS in ThumbnailGrid.tsx). It used
# to be 3s, which is twice that - a tile queued behind the post-import storm sat
# there for the whole wait, blowing the budget before it could even start
# retrying. Shedding at the budget hands the tile back to the grid's fast retry
# while the background worker gets on with generating it, which is the outcome
# that actually puts a picture on screen sooner.
_ON_DEMAND_RENDER_WAIT_S = 1.5


def _serve_derivative(image: Image, name: str, not_ready_detail: str) -> FileResponse:
    """Serve a cached derivative (thumbnail.jpg / preview.jpg), generating it
    on the spot if it isn't there yet. Derivatives are normally produced by the
    background worker after import, but that's asynchronous - without this
    fallback the grid shows broken images right after an import until the files
    exist *and* the page is manually refreshed. Generating on-miss closes that
    race and also self-heals any derivative that failed or was deleted."""
    path = thumbnails.derivative_dir(image.id) / name
    if not path.exists():
        try:
            # ensure_derivatives (not regenerate) so a request arriving while
            # the post-import worker is already generating this image waits for
            # that result instead of decoding the same photo again in parallel.
            thumbnails.ensure_derivatives(image, slot_timeout=_ON_DEMAND_RENDER_WAIT_S)
        except thumbnails.RenderBusy:
            # Renders are already saturated (typically right after an import, when
            # a whole grid of not-yet-generated photos scrolls into view). Shed
            # this one rather than hold a server thread in the queue and stall
            # every other request: the post-import worker is producing the same
            # file, so tell the client to come back shortly.
            raise HTTPException(
                status_code=503, detail=not_ready_detail, headers={"Retry-After": "2"}
            )
        except Exception:
            logger.exception("On-demand %s generation failed for image %s", name, image.id)
            raise HTTPException(status_code=404, detail=not_ready_detail)
    if not path.exists():
        raise HTTPException(status_code=404, detail=not_ready_detail)
    # Cache hard: the URLs are content-versioned (?v= carries the edit state,
    # plus a global buster the frontend bumps after thumbnail rebuilds), so a
    # given URL's bytes never change. Lets the browser keep grid/preview images
    # in its memory/disk cache instead of re-requesting them on every mount -
    # scrolled-back grid areas and re-opened photos then render instantly.
    return FileResponse(
        path, headers={"Cache-Control": "private, max-age=31536000, immutable"}
    )


@router.get("/{image_id}/thumbnail")
def get_thumbnail(
    image_id: str,
    size: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    # ?size=small: the 640px tier the dense grid sizes (XS/S) request - a 4K
    # screenful there holds several hundred tiles, and full 1600px thumbnails
    # overflow the renderer's decoded-image budget (tiles then paint empty).
    #
    # Same serve semantics as the full thumbnail; usually just a downscale of the
    # existing thumbnail.jpg, so old libraries need no re-render. An unrecognised
    # size falls through to the full thumbnail rather than erroring - a stale
    # renderer bundle asking for a tier this build doesn't know still gets a
    # picture.
    ensure_tier = {"small": thumbnails.ensure_small}.get(size or "")
    if ensure_tier is not None:
        try:
            path = ensure_tier(image, slot_timeout=_ON_DEMAND_RENDER_WAIT_S)
        except thumbnails.RenderBusy:
            raise HTTPException(
                status_code=503, detail="Thumbnail not ready yet", headers={"Retry-After": "2"}
            )
        except Exception:
            logger.exception("On-demand %s tier generation failed for image %s", size, image.id)
            raise HTTPException(status_code=404, detail="Thumbnail not ready yet")
        return FileResponse(
            path, headers={"Cache-Control": "private, max-age=31536000, immutable"}
        )
    return _serve_derivative(image, "thumbnail.jpg", "Thumbnail not ready yet")


@router.get("/{image_id}/preview")
def get_preview(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image = get_owned_image(db, current_user.id, image_id)
    return _serve_derivative(image, "preview.jpg", "Preview not ready yet")


# Newest-wins for the lightbox's 100%-zoom render, same idea as the editor
# previews above but GLOBAL rather than per-image: the lightbox shows exactly
# one photo, so only the latest /full request can still be on screen - during
# zoom-and-page browsing the stale queued renders are precisely OTHER images'.
# Each uncached /full request marks itself newest; older ones still waiting on
# the render lock bail (409) instead of each burning ~14s of serialized
# full-resolution render for a photo the user zapped past. The warmer and
# export paths call generate_full without a staleness probe and always render.
_full_zoom_seq = itertools.count(1)
_full_zoom_latest = 0
_full_zoom_lock = threading.Lock()


@router.get("/{image_id}/full")
def get_full(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Full-resolution edited JPEG for true 100% zoom in the lightbox. Generated
    on first request and cached (cleared automatically when edits change)."""
    global _full_zoom_latest
    image = get_owned_image(db, current_user.id, image_id)
    # Claim "newest zoom" even when this request is a cheap cached serve: the
    # user has zoomed a different photo, so a stale render still queued for the
    # previous one should die either way.
    with _full_zoom_lock:
        seq = next(_full_zoom_seq)
        _full_zoom_latest = seq
    path = thumbnails.derivative_dir(image.id) / "full.jpg"
    if not path.exists():

        def _is_stale() -> bool:
            with _full_zoom_lock:
                return _full_zoom_latest != seq

        try:
            thumbnails.generate_full(image, is_stale=_is_stale)
        except thumbnails.PreviewSuperseded:
            # The client aborted this fetch when the user moved on; the status
            # only matters to anything that still happens to be listening.
            raise HTTPException(status_code=409, detail="Superseded by a newer full-resolution request")
        except Exception:
            logger.exception("Full render failed for image %s", image.id)
            raise HTTPException(status_code=404, detail="Full-resolution image not available")
    # Same contract as the other derivatives: the URL is version-stamped
    # (?v= edit revision), so a given URL's bytes never change - without this
    # header every re-zoom re-downloaded the multi-MB full.jpg.
    return FileResponse(
        path, headers={"Cache-Control": "private, max-age=31536000, immutable"}
    )


@router.get("/{image_id}/original")
def get_original(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image = get_owned_image(db, current_user.id, image_id)
    path: Path = resolve_image_path(image)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Original file missing from library")
    return FileResponse(path, filename=image.original_filename)


@router.get("/{image_id}/export")
def get_export(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The photo's pixels for the album layout exports (PDF / HTML), with
    nothing lost on the way out. A photo without non-destructive edits - which
    includes every flattened edited copy - goes out as the very bytes it was
    saved as. One that carries edits is rendered at full resolution from them
    (the same render as the 100%-zoom full.jpg) and encoded as PNG, so the
    export holds the pipeline's pixels exactly instead of a second JPEG
    generation of them. A RAW is always rendered: no browser shows the sensor
    file itself.

    Rendered per request, not cached: a full-resolution PNG of a 40MP photo is
    ~100MB, which is too much to keep on disk per photo for an export that is
    made once. Serialised on the full render lock like every full render."""
    image = get_owned_image(db, current_user.id, image_id)
    path: Path = resolve_image_path(image)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Original file missing from library")
    headers = {"Cache-Control": "private, max-age=31536000, immutable"}
    if not _has_any_edit(image) and image.file_type in (FileType.jpeg, FileType.png):
        return FileResponse(path, headers=headers)
    try:
        rendered = thumbnails.render_full_from_stored_edits(image)
    except Exception:
        logger.exception("Lossless export render failed for image %s", image.id)
        raise HTTPException(status_code=404, detail="Photo could not be rendered")
    buf = io.BytesIO()
    # The lowest deflate level: lossless either way, and on a 40MP frame the
    # default level spends another ten seconds per photo on a ~10% smaller file
    # that goes straight into a print PDF.
    rendered.save(buf, "PNG", compress_level=1)
    return Response(buf.getvalue(), media_type="image/png", headers=headers)


def _embedding_for_image(image: Image):
    """The image's CLIP embedding, self-healing when it's missing. Reuses the
    RAW/JPEG partner's vector (same shot) when the image's own never landed;
    otherwise generates and caches one on demand rather than failing - fixes
    photos whose background embedding never landed (also makes them findable by
    semantic search from then on). Prefers the already-rendered preview.jpg
    (always a clean RGB JPEG) so this can't trip on a RAW decode or a
    source-path quirk; falls back to the source file. None when all of that
    failed."""
    vector = embeddings.get_embedding(engine, image.id)
    if vector is None and image.paired_image_id:
        vector = embeddings.get_embedding(engine, image.paired_image_id)
    if vector is None:
        try:
            from app.services.raw import extract_preview

            preview_path = thumbnails.derivative_dir(image.id) / "preview.jpg"
            src_img = (
                embeddings.open_for_encoding(preview_path)
                if preview_path.exists()
                else extract_preview(resolve_image_path(image))
            )
            vector = embeddings.encode_image(src_img)
            embeddings.ensure_embeddings_table(engine)
            embeddings.upsert_embedding(engine, image.id, vector)
        except Exception:
            logger.exception("On-demand embedding generation failed for %s", image.id)
    return vector


@router.get("/{image_id}/auto-adjust", response_model=schemas.AutoAdjustOut)
def auto_adjust(
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Suggest develop settings for this photo, learned from the user's own
    saved edits: the most visually similar edited photos (CLIP k-NN) vote with
    their settings, weighted by similarity. Purely a suggestion - nothing is
    stored; the editor applies it to its sliders and the user decides whether
    to save. Returns a *partial* develop object: only the adjustment groups
    enabled in Settings are included, so unchecked groups keep whatever value
    the editor currently holds."""
    groups = get_auto_develop_groups(db)
    if not groups:
        raise HTTPException(
            status_code=400,
            detail="Auto develop is set to affect no settings - enable at least one group in Settings",
        )
    image = get_owned_image(db, current_user.id, image_id)
    vector = _embedding_for_image(image)
    if vector is None:
        raise HTTPException(status_code=404, detail="Embedding not ready yet")
    suggestion = auto_develop.suggest_adjustments(db, engine, image, vector)
    if suggestion is None:
        raise HTTPException(
            status_code=404,
            detail="No edited photos to learn from yet - save some edits first",
        )
    adjustments, samples = suggestion
    return schemas.AutoAdjustOut(
        adjustments=auto_develop.filter_to_groups(adjustments, groups), samples=samples
    )


@router.get("/{image_id}/similar", response_model=list[schemas.SearchResultOut])
def get_similar_images(
    image_id: str,
    limit: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    vector = _embedding_for_image(image)
    if vector is None:
        raise HTTPException(status_code=404, detail="Embedding not ready yet")

    matches = embeddings.query_similar(engine, vector, k=limit, exclude_id=image.id)
    results = []
    # Never suggest the photo itself or its RAW/JPEG partner.
    seen: set[str] = {image.id}
    if image.paired_image_id:
        seen.add(image.paired_image_id)
    for match_id, distance in matches:
        match_image = db.get(Image, match_id)
        if not (match_image and match_image.owner_id == current_user.id and match_image.deleted_at is None):
            continue
        # RAW+JPEG pairs are the same shot: always surface the viewable JPEG (the
        # user browses JPEGs), so a match that landed on the RAW half shows its
        # JPEG partner instead. Falls back to whatever exists if there's no JPEG.
        if match_image.file_type == FileType.raw and match_image.paired_image_id:
            partner = db.get(Image, match_image.paired_image_id)
            if (
                partner
                and partner.owner_id == current_user.id
                and partner.deleted_at is None
                and partner.file_type != FileType.raw
            ):
                match_image = partner
        if match_image.id in seen:
            continue
        seen.add(match_image.id)
        results.append(schemas.SearchResultOut(image=match_image, distance=distance))
    return results
