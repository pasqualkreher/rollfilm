import hashlib
import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_image
from app.auth import get_current_user
from app.config import settings
from app.db.models import (
    AlbumImage,
    ColorLabel,
    FileType,
    Image,
    ImageTag,
    Tag,
    User,
)
from app.db.session import engine, get_db
from app.services import (
    embeddings,
    geocode,
    immich as immich_service,
    sources as sources_service,
    thumbnails,
    trash as trash_service,
)
from app.services.filesystem import library_relative_path, resolve_image_path
from app.services.hashing import perceptual_hash
from app.services.settings_store import get_immich_config
from app.workers.queue import enqueue_embedding, enqueue_post_import

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/images", tags=["images"])


def _try_regenerate_derivatives(image: Image) -> None:
    """Rotation/crop metadata is already committed by the time this runs -
    if the source file is missing, corrupt, or LibRaw chokes on it, that's a
    thumbnail-rebuild problem to retry later (see the Settings "Rebuild all
    thumbnails" action), not a reason to fail the edit the user just made."""
    try:
        thumbnails.regenerate_for_image(image)
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
    no partner (or it isn't owned by the caller)."""
    if not image.paired_image_id:
        return
    partner = db.get(Image, image.paired_image_id)
    if partner is None or partner.owner_id != owner_id:
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


@router.get("", response_model=list[schemas.ImageOut])
def list_images(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    country: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    tags: list[str] | None = Query(None),
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Image).filter(
        Image.owner_id == current_user.id, Image.deleted_at.is_(None)
    )

    if album_id:
        query = query.join(AlbumImage, AlbumImage.image_id == Image.id).filter(
            AlbumImage.album_id == album_id
        )
    if rating_min is not None:
        query = query.filter(Image.rating >= rating_min)
    if color_label is not None:
        query = query.filter(Image.color_label == color_label)
    if camera_model:
        query = query.filter(Image.camera_model == camera_model)
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
    query = sources_service.exclude_unavailable(
        query, sources_service.unavailable_source_ids(db, current_user.id)
    )

    query = query.order_by(Image.taken_at.desc())
    return query.offset(offset).limit(limit).all()


@router.get("/facets", response_model=schemas.LibraryFacets)
def list_facets(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Distinct values for the filter dropdowns: cameras and regions present in
    the caller's library, each with a photo count. Regions are reverse-geocoded
    lazily here for any geotagged photo not yet resolved, so they populate
    without a separate maintenance pass."""
    base = db.query(Image).filter(Image.owner_id == current_user.id, Image.deleted_at.is_(None))
    base = sources_service.exclude_unavailable(
        base, sources_service.unavailable_source_ids(db, current_user.id)
    )

    # Backfill any geotagged photos missing a country (e.g. imported before this
    # feature, or restored from a backup), then commit before counting.
    missing = base.filter(Image.gps_lat.isnot(None), Image.gps_country.is_(None)).all()
    if missing and geocode.annotate_images(missing):
        db.commit()

    cameras = [
        schemas.Facet(value=value, count=count)
        for value, count in (
            base.with_entities(Image.camera_model, func.count(Image.id))
            .filter(Image.camera_model.isnot(None), Image.camera_model != "")
            .group_by(Image.camera_model)
            .order_by(func.count(Image.id).desc())
            .all()
        )
    ]
    regions = [
        schemas.Facet(value=value, count=count)
        for value, count in (
            base.with_entities(Image.gps_country, func.count(Image.id))
            .filter(Image.gps_country.isnot(None))
            .group_by(Image.gps_country)
            .order_by(func.count(Image.id).desc())
            .all()
        )
    ]
    no_location = base.filter(Image.gps_lat.is_(None)).count()
    return schemas.LibraryFacets(cameras=cameras, regions=regions, no_location_count=no_location)


@router.get("/trash", response_model=list[schemas.ImageOut])
def list_trash(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Managed photos only: deleted source-root photos are also soft-deleted
    # rows, but they act as permanent scan-exclusion markers, not as trash
    # entries (there is no file of ours to delete or bring back).
    return (
        db.query(Image)
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
    for image in images:
        db.refresh(image)
    return images


@router.post("/trash/delete", status_code=204)
def delete_from_trash(
    payload: schemas.BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete photos that are already in the Trash - this is the
    step that actually removes the original files from the library folder."""
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


@router.post("/trash/empty", status_code=204)
def empty_trash(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
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
        try:
            status = immich_service.upload_asset(
                immich.base_url, immich.api_key, path, image.taken_at
            )
            if status == "duplicate":
                duplicate += 1
            else:
                uploaded += 1
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
    """Clears rating, color label, and all tags - back to the state a photo
    is in right after import."""
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    image_ids = [image.id for image in images]
    db.query(ImageTag).filter(ImageTag.image_id.in_(image_ids)).delete(synchronize_session=False)
    for image in images:
        image.rating = 0
        image.color_label = ColorLabel.none
    db.commit()
    for image in images:
        db.refresh(image)
    return images


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
    if update.apply_to_pair:
        _apply_to_pair(db, current_user.id, image, update.rating, update.color_label)
    db.commit()
    db.refresh(image)
    return image


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


def _clean_color_mix(mix: dict | None) -> str | None:
    """Clamp the per-band HSL mixer and drop it entirely when fully neutral, so a
    neutral edit stores NULL rather than a no-op JSON blob."""
    if not mix:
        return None
    cleaned = {
        band: [_clamp100(v) for v in (vals or [0, 0, 0])[:3]]
        for band, vals in mix.items()
        if band in thumbnails.COLOR_BANDS
    }
    if not any(any(v) for v in cleaned.values()):
        return None
    return json.dumps(cleaned)


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
    image.edit_exposure = _clamp100(payload.exposure)
    image.edit_contrast = _clamp100(payload.contrast)
    image.edit_highlights = _clamp100(payload.highlights)
    image.edit_shadows = _clamp100(payload.shadows)
    image.edit_whites = _clamp100(payload.whites)
    image.edit_blacks = _clamp100(payload.blacks)
    image.edit_dehaze = _clamp100(payload.dehaze)
    image.edit_saturation = _clamp100(payload.saturation)
    image.edit_temperature = _clamp100(payload.temperature)
    image.edit_tint = _clamp100(payload.tint)
    image.edit_vignette = _clamp100(payload.vignette)
    image.edit_distortion = _clamp100(payload.distortion)
    image.edit_grain = max(0, min(100, int(payload.grain)))
    image.edit_grain_size = max(0, min(100, int(payload.grain_size)))
    image.edit_denoise = max(0, min(100, int(payload.denoise)))
    image.edit_clarity = _clamp100(payload.clarity)
    image.edit_sharpness = _clamp100(payload.sharpness)
    image.edit_color_tint = _clamp100(payload.color_tint)
    image.edit_chrome_effect = max(0, min(100, int(payload.chrome_effect)))
    image.edit_chrome_blue = max(0, min(100, int(payload.chrome_blue)))
    image.edit_mist = max(0, min(100, int(payload.mist)))
    image.edit_color_mix = _clean_color_mix(payload.color_mix)
    # Tag edited photos "edit" so they're easy to find; drop the tag if the edit
    # was reset back to the original look.
    has_edit = bool(
        payload.rotation % 360
        or payload.crop is not None
        or payload.flip_h
        or payload.flip_v
        or image.edit_straighten
        or payload.persp_h
        or payload.persp_v
        or image.edit_color_mix
        or any(
            int(getattr(payload, name))
            for name in (
                *thumbnails.ADJUSTMENT_FIELDS,
                "vignette",
                "distortion",
                "grain",
                "denoise",
                "clarity",
                "sharpness",
                "color_tint",
                "chrome_effect",
                "chrome_blue",
                "mist",
            )
        )
    )
    if has_edit:
        _add_tag_to_image(db, current_user.id, image, "edit")
    else:
        _remove_tag_from_image(db, current_user.id, image, "edit")
    db.commit()
    db.refresh(image)
    _try_regenerate_derivatives(image)
    return image


def _payload_adjustments(payload: schemas.ImageEdits) -> dict:
    """The clamped tonal/effect adjustments dict off an edits payload, ready
    for the thumbnails pipeline. Shared by save-copy and the editor preview."""
    adjustments = {name: _clamp100(getattr(payload, name)) for name in thumbnails.ADJUSTMENT_FIELDS}
    adjustments["vignette"] = _clamp100(payload.vignette)
    adjustments["grain"] = max(0, min(100, int(payload.grain)))
    adjustments["grain_size"] = max(0, min(100, int(payload.grain_size)))
    adjustments["denoise"] = max(0, min(100, int(payload.denoise)))
    adjustments["clarity"] = _clamp100(payload.clarity)
    adjustments["sharpness"] = _clamp100(payload.sharpness)
    adjustments["color_tint"] = _clamp100(payload.color_tint)
    adjustments["chrome_effect"] = max(0, min(100, int(payload.chrome_effect)))
    adjustments["chrome_blue"] = max(0, min(100, int(payload.chrome_blue)))
    adjustments["mist"] = max(0, min(100, int(payload.mist)))
    cleaned_mix = _clean_color_mix(payload.color_mix)
    adjustments["color_mix"] = json.loads(cleaned_mix) if cleaned_mix else None
    return adjustments


@router.post("/{image_id}/editor-preview")
def editor_preview(
    image_id: str,
    payload: schemas.ImageEdits,
    full: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Live editor preview, rendered server-side with the *same* pipeline that
    saves - so what you see while editing is exactly what you get. The decoded
    base image is cached, so only the edit pipeline re-runs per request.
    `?full=1` renders on the full-resolution base - the editor requests that
    once the sliders settle, replacing the fast downscaled render."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
    image = get_owned_image(db, current_user.id, image_id)
    crop = None
    if payload.crop is not None:
        crop = (payload.crop.x, payload.crop.y, payload.crop.width, payload.crop.height)
    try:
        data = thumbnails.render_editor_preview_bytes(
            image,
            payload.rotation % 360,
            crop,
            _payload_adjustments(payload),
            distortion=_clamp100(payload.distortion),
            full_quality=full,
            flip_h=bool(payload.flip_h),
            flip_v=bool(payload.flip_v),
            straighten=max(-45.0, min(45.0, float(payload.straighten))),
            persp_h=_clamp100(payload.persp_h),
            persp_v=_clamp100(payload.persp_v),
        )
    except Exception:
        logger.exception("Failed to render editor preview for %s", image.id)
        raise HTTPException(status_code=500, detail="Could not render the preview")
    return Response(content=data, media_type="image/jpeg")


@router.post("/{image_id}/save-copy", response_model=schemas.ImageOut)
def save_copy(
    image_id: str,
    payload: schemas.ImageEdits,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bake the given edit into a brand-new managed library photo (a flattened
    JPEG), tagged "edited" so edited shots are easy to find. The source photo -
    and every original file on disk - is left completely untouched."""
    if payload.rotation % 90 != 0:
        raise HTTPException(status_code=400, detail="rotation must be a multiple of 90")
    _validate_crop(payload.crop)
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
        )
    except Exception:
        logger.exception("Failed to render edited copy of %s", src.id)
        raise HTTPException(status_code=500, detail="Could not render the edited copy")

    buf = io.BytesIO()
    edited.save(buf, "JPEG", quality=95)
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
    enqueue_embedding(new_image.id, settings.library_root / rel_path)
    return new_image


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
            thumbnails.regenerate_for_image(image)
        except Exception:
            logger.exception("On-demand %s generation failed for image %s", name, image.id)
            raise HTTPException(status_code=404, detail=not_ready_detail)
    if not path.exists():
        raise HTTPException(status_code=404, detail=not_ready_detail)
    return FileResponse(path)


@router.get("/{image_id}/thumbnail")
def get_thumbnail(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image = get_owned_image(db, current_user.id, image_id)
    return _serve_derivative(image, "thumbnail.jpg", "Thumbnail not ready yet")


@router.get("/{image_id}/preview")
def get_preview(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image = get_owned_image(db, current_user.id, image_id)
    return _serve_derivative(image, "preview.jpg", "Preview not ready yet")


@router.get("/{image_id}/full")
def get_full(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Full-resolution edited JPEG for true 100% zoom in the lightbox. Generated
    on first request and cached (cleared automatically when edits change)."""
    image = get_owned_image(db, current_user.id, image_id)
    path = thumbnails.derivative_dir(image.id) / "full.jpg"
    if not path.exists():
        try:
            thumbnails.generate_full(image)
        except Exception:
            logger.exception("Full render failed for image %s", image.id)
            raise HTTPException(status_code=404, detail="Full-resolution image not available")
    return FileResponse(path)


@router.get("/{image_id}/original")
def get_original(image_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image = get_owned_image(db, current_user.id, image_id)
    path: Path = resolve_image_path(image)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Original file missing from library")
    return FileResponse(path, filename=image.original_filename)


@router.get("/{image_id}/similar", response_model=list[schemas.SearchResultOut])
def get_similar_images(
    image_id: str,
    limit: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = get_owned_image(db, current_user.id, image_id)
    vector = embeddings.get_embedding(engine, image.id)
    if vector is None:
        raise HTTPException(status_code=404, detail="Embedding not ready yet")

    matches = embeddings.query_similar(engine, vector, k=limit, exclude_id=image.id)
    results = []
    for match_id, distance in matches:
        match_image = db.get(Image, match_id)
        if match_image and match_image.owner_id == current_user.id and match_image.deleted_at is None:
            results.append(schemas.SearchResultOut(image=match_image, distance=distance))
    return results
