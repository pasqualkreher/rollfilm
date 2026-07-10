import io
import logging
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
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
    ImportStagedFile,
    SourceRoot,
    Tag,
    User,
)
from app.db.session import engine, get_db
from app.services import embeddings, immich as immich_service, sources as sources_service, thumbnails
from app.services.filesystem import resolve_image_path
from app.services.settings_store import get_immich_config

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


def _prune_empty_dirs(start: Path, stop_at: Path) -> None:
    """After deleting a managed original, remove any now-empty parent folders the
    app created for it (the per-year / per-day import folders), walking upward.
    Never touches stop_at (the library root) itself, and bails the moment it
    would step outside it - so a bad path can't delete unrelated directories."""
    try:
        stop_at = stop_at.resolve()
    except OSError:
        return
    current = start.parent
    while True:
        try:
            resolved = current.resolve()
        except OSError:
            return
        # Stop at the library root, or if we've somehow escaped above it.
        if resolved == stop_at or stop_at not in resolved.parents:
            return
        try:
            next(resolved.iterdir())
            return  # still has contents - leave it (and everything above) alone
        except StopIteration:
            pass  # empty - safe to remove
        except OSError:
            return
        try:
            resolved.rmdir()
        except OSError:
            return
        current = resolved.parent


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


@router.get("", response_model=list[schemas.ImageOut])
def list_images(
    view_mode: Literal["combined", "jpeg_only", "raw_only"] = "combined",
    album_id: str | None = None,
    rating_min: int | None = None,
    color_label: ColorLabel | None = None,
    camera_model: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Image).filter(Image.owner_id == current_user.id)

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
    if date_from:
        query = query.filter(Image.taken_at >= date_from)
    if date_to:
        query = query.filter(Image.taken_at <= date_to)

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
    images = [get_owned_image(db, current_user.id, image_id) for image_id in payload.image_ids]
    image_ids = {image.id for image in images}

    # paired_image_id and ImportStagedFile.duplicate_of_image_id both have FK
    # constraints (enforced - see db/session.py) back to images.id; null those
    # out first or deleting a row still referenced by another would fail. Clear
    # the deleted rows' own pairing link *and* any external sibling pointing
    # back in - when both halves of a pair are selected, only nulling the
    # sibling leaves the first half still pointing at the second.
    for image in images:
        image.paired_image_id = None
    if image_ids:
        db.query(Image).filter(Image.paired_image_id.in_(image_ids)).update(
            {Image.paired_image_id: None}, synchronize_session=False
        )
        db.query(ImportStagedFile).filter(
            ImportStagedFile.duplicate_of_image_id.in_(image_ids)
        ).update({ImportStagedFile.duplicate_of_image_id: None}, synchronize_session=False)
    db.flush()

    # Cache source roots so an all-from-one-folder delete hits the DB once, not
    # once per image.
    source_cache: dict[str, SourceRoot | None] = {}

    def _source_for(img: Image) -> SourceRoot | None:
        if img.source_root_id is None:
            return None
        if img.source_root_id not in source_cache:
            source_cache[img.source_root_id] = db.get(SourceRoot, img.source_root_id)
        return source_cache[img.source_root_id]

    for image in images:
        source = _source_for(image)
        if source is None:
            # Managed (imported) library file - ours to delete. Also tidy the
            # date folders the app created once they're empty, so deleting the
            # last shot of a day/year doesn't leave hollow dirs.
            original = settings.library_root / image.file_path
            original.unlink(missing_ok=True)
            _prune_empty_dirs(original, settings.library_root)
        elif sources_service.is_path_available(source.path):
            # File indexed in place from a *connected* external folder: delete
            # the original there too. Only when the drive/folder is currently
            # reachable - an offline source is left untouched. We remove just the
            # file, never the user's own folder structure.
            resolve_image_path(image).unlink(missing_ok=True)
        # else: external source is offline - can't reach the file; leave it on
        # disk (the row still goes, matching "removed from the library").
        shutil.rmtree(thumbnails.derivative_dir(image.id), ignore_errors=True)
        db.delete(image)
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
        if match_image and match_image.owner_id == current_user.id:
            results.append(schemas.SearchResultOut(image=match_image, distance=distance))
    return results
