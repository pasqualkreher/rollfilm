"""A copy of a photo: what it takes along, and the physical copy itself.

A physical copy (save-copy: the edit baked into a new JPEG in the library)
and a virtual copy (a second entry for the same file) both start as the
photo they were made from. The pixels and the develop state are the routes'
business; this is the library side of it - the tags the user gave the
source, its stars, label and note - so a copy made to keep a version of a
photo is found where the photo is found. Album membership is not copied:
an album is a chosen set, and a copy turning up in every album of its
source would change those sets behind the user's back ("Add to..." is one
click away). The app's own tags ("edit", "album: ...") describe the source's
place in the library and stay with it; the copy gets its own ("edit copy",
"virtual copy") from the route.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from PIL import Image as PILImage
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import ColorLabel, FileType, Image
from app.services import develop, thumbnails
from app.services import exif as exif_service
from app.services import raw as raw_service
from app.services import sidecar as sidecar_service
from app.services import tags as tags_service
from app.services.filesystem import library_relative_path, resolve_image_path
from app.services.hashing import perceptual_hash

logger = logging.getLogger(__name__)

# The per-photo fields a copy inherits from the photo it was made from.
_INHERITED_FIELDS = ("rating", "color_label", "description")


def copy_library_metadata(db: Session, owner_id: int, src: Image, copy: Image) -> None:
    """Give `copy` the user tags and the stars, label and note of `src`.
    Called once the copy's row is flushed (it needs an id for the tag
    links); the caller commits and then touches the copy's sidecar."""
    for field in _INHERITED_FIELDS:
        setattr(copy, field, getattr(src, field))
    for name in tags_service.user_tags(db, src):
        tags_service.add_tag_to_image(db, owner_id, copy, name)


# --- the physical copy ---------------------------------------------------------

CropBox = tuple[float, float, float, float]

# The long edge the copy's perceptual hash is read at: the import hashes a
# preview of about this size (import_pipeline), so a copy matches its source
# the way a second import of the same picture would.
_HASH_PX = 1600


@dataclass(frozen=True)
class CopyEdits:
    """The edit a copy bakes in: the geometry and the develop adjustments,
    normalized - from the editor's live payload or a photo's saved state."""

    rotation: int = 0
    crop: CropBox | None = None
    adjustments: dict | None = None
    distortion: int = 0
    flip_h: bool = False
    flip_v: bool = False
    straighten: float = 0.0
    persp_h: int = 0
    persp_v: int = 0

    @classmethod
    def from_row(cls, image: Image) -> "CopyEdits":
        crop = None
        if image.edit_crop_x is not None:
            crop = (image.edit_crop_x, image.edit_crop_y, image.edit_crop_width, image.edit_crop_height)
        return cls(
            rotation=int(image.edit_rotation or 0) % 360,
            crop=crop,
            adjustments=thumbnails.adjustments_from_image(image),
            distortion=int(getattr(image, "edit_distortion", 0) or 0),
            flip_h=bool(getattr(image, "edit_flip_h", False)),
            flip_v=bool(getattr(image, "edit_flip_v", False)),
            straighten=float(getattr(image, "edit_straighten", 0.0) or 0.0),
            persp_h=int(getattr(image, "edit_persp_h", 0) or 0),
            persp_v=int(getattr(image, "edit_persp_v", 0) or 0),
        )

    @property
    def normalized(self) -> dict:
        return self.adjustments if self.adjustments is not None else develop.normalize(None)


def render_copy_frame(
    src: Image, edits: CopyEdits, max_size: int | None = None,
    is_stale: Callable[[], bool] | None = None,
) -> PILImage.Image:
    """The copy's picture: the full-resolution render of `src` with `edits`
    baked in, capped to `max_size` on its long edge. The render keeps its
    last frame (thumbnails._last_full_render), so the editor's Save copy
    right after the full.jpg warm-up, or a second copy of the same edit,
    skips the render. `is_stale` lets a batch stop a render it no longer
    wants (PreviewSuperseded)."""
    frame = thumbnails.render_edited_image(
        src, edits.rotation, edits.crop, edits.normalized,
        distortion=edits.distortion, flip_h=edits.flip_h, flip_v=edits.flip_v,
        straighten=edits.straighten, persp_h=edits.persp_h, persp_v=edits.persp_v,
        max_px=max_size, is_stale=is_stale, array=True,
    )
    edited = PILImage.fromarray(frame, "RGB")
    if max_size and max(edited.size) > max_size:
        edited.thumbnail((max_size, max_size), PILImage.LANCZOS)
    return edited


def _encode(edited: PILImage.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    # At the top of the quality range the copy is meant as a keeper, so drop
    # chroma subsampling too (4:4:4): quality=100 alone still throws away half
    # the colour resolution at libjpeg's default, which shows on saturated
    # edges. Below 95 the copy is deliberately a smaller file - leave the
    # default subsampling there, where it buys most of the size saving.
    subsampling = 0 if quality >= 95 else -1
    edited.save(
        buf, "JPEG", quality=quality, subsampling=subsampling, icc_profile=raw_service.srgb_icc_bytes()
    )
    return buf.getvalue()


def _copy_name(src: Image) -> tuple[str, str]:
    """The copy's library path and file name: "<stem>_edit-1.jpg", "_edit-2",
    ... - the first free number, so repeated copies of the same photo don't
    overwrite each other. An existing "_edit-<n>" suffix is stripped first,
    so a copy of a copy counts up (DSCF0048_edit-2.jpg) instead of stacking
    (DSCF0048_edit-1_edit-1.jpg). library_relative_path itself de-dupes with
    a "_1" suffix, so probe with it: a taken name comes back changed (e.g.
    "_edit-1_1.jpg") - bump n and retry - while a free name comes back
    verbatim."""
    stem = re.sub(r"_edit-\d+$", "", Path(src.original_filename).stem)
    taken_at = src.taken_at or datetime.now(timezone.utc)
    n = 1
    while True:
        candidate = f"{stem}_edit-{n}.jpg"
        rel_path = library_relative_path(taken_at, candidate, settings.library_root)
        if Path(rel_path).name == candidate:
            return rel_path, candidate
        n += 1


def _hash_preview(data: bytes) -> str:
    with PILImage.open(io.BytesIO(data)) as im:
        w, h = im.size
        if max(w, h) > _HASH_PX:
            scale = _HASH_PX / max(w, h)
            im.draft("RGB", (max(1, round(w * scale)), max(1, round(h * scale))))
        return perceptual_hash(im.convert("RGB"))


def write_copy(
    db: Session, owner_id: int, src: Image, edited: PILImage.Image, edits: CopyEdits,
    quality: int, helper=None,
) -> Image:
    """Put the rendered `edited` picture of `src` into the library as a new
    managed JPEG and a new row: encoded at `quality`, named beside the
    source's date, carrying the source's camera data (exiftool, through
    `helper` when the caller has one - a batch keeps its own) and the
    library's stars, label and tags (copy_library_metadata), tagged "edit
    copy", its thumbnail and preview rendered before it is handed back so
    the grid and the editor can show it at once. The source and every
    original on disk are left untouched."""
    data = _encode(edited, max(1, min(100, int(quality))))
    rel_path, filename = _copy_name(src)
    target = settings.library_root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    try:
        exif_service.write_export_metadata(
            target,
            resolve_image_path(src),
            library=exif_service.LibraryMetadata(
                rating=src.rating or 0,
                label=None if src.color_label in (None, ColorLabel.none) else src.color_label.value,
                keywords=tuple(tags_service.user_tags(db, src)),
            ),
            helper=helper,
        )
    except Exception:
        # The picture is what was asked for; one without its camera data
        # still beats none. (A JPEG source without exiftool at hand, say.)
        logger.exception("Save copy: could not write metadata into %s", target.name)
    # Hashed and sized as the file stands, after exiftool rewrote it.
    on_disk = target.read_bytes()
    new_image = Image(
        owner_id=owner_id,
        file_path=rel_path,
        source_root_id=None,  # a managed library file, regardless of the source's origin
        original_filename=filename,
        file_hash=hashlib.sha256(on_disk).hexdigest(),
        perceptual_hash=_hash_preview(data),
        file_type=FileType.jpeg,
        raw_format=None,
        width=edited.width,
        height=edited.height,
        file_size=len(on_disk),
        taken_at=src.taken_at,
        camera_make=src.camera_make,
        camera_model=src.camera_model,
        lens_model=src.lens_model,
        iso=src.iso,
        aperture=src.aperture,
        shutter_speed=src.shutter_speed,
        focal_length=src.focal_length,
        gps_lat=src.gps_lat,
        gps_lon=src.gps_lon,
        gps_country=src.gps_country,
        # Remember the develop settings baked into this copy - not for rendering
        # (the pixels already contain them), but so auto-develop can learn from
        # saved copies too (see services/auto_develop.py).
        applied_adjustments=develop.dumps(edits.normalized),
    )
    db.add(new_image)
    db.flush()
    # The source's tags, stars, label and note come along.
    copy_library_metadata(db, owner_id, src, new_image)
    tags_service.add_tag_to_image(db, owner_id, new_image, "edit copy")
    db.commit()
    db.refresh(new_image)
    sidecar_service.touch(db, [new_image])
    # Generate the copy's thumbnail/preview *synchronously* so the photo is
    # viewable the instant the editor navigates to it - the flattened JPEG is
    # cheap to derive, and doing it async left a blank "no image" for a beat
    # (longer on slow machines). The search embedding still runs in the
    # background since it isn't needed to display the photo.
    try:
        thumbnails.regenerate_for_image(new_image)
    except Exception:
        logger.exception("Derivative generation failed for edited copy %s", new_image.id)
    return new_image
