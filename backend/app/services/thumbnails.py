import os
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image as PILImage

from app.config import settings
from app.services.raw import extract_full_preview

if TYPE_CHECKING:
    from app.db.models import Image

THUMBNAIL_MAX_PX = 512
PREVIEW_MAX_PX = 2048

CropBox = tuple[float, float, float, float]


def derivative_dir(image_id: str) -> Path:
    path = settings.thumbnail_cache_root / image_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def apply_edits(image: PILImage.Image, rotation: int, crop: CropBox | None) -> PILImage.Image:
    """rotation is clockwise degrees (0/90/180/270); crop is (x, y, width,
    height) as fractions of the already-rotated image."""
    if rotation:
        image = image.rotate(-rotation, expand=True)
    if crop:
        x, y, w, h = crop
        iw, ih = image.size
        box = (round(x * iw), round(y * ih), round((x + w) * iw), round((y + h) * ih))
        image = image.crop(box)
    return image


def generate_derivatives(
    image_id: str, source_path: Path, rotation: int = 0, crop: CropBox | None = None
) -> None:
    """Writes thumbnail.jpg (grid) and preview.jpg (lightbox) for an image.

    Browsers can't render RAW files directly, so for RAW sources preview.jpg
    is the only viewable representation - it's a true demosaic (not the
    camera's embedded JPEG thumbnail, which would carry the camera's own
    color rendering - see extract_full_preview()), then the user's manual
    rotation/crop (if any) is layered on top before resizing.
    """
    out_dir = derivative_dir(image_id)
    source = extract_full_preview(source_path)
    source = apply_edits(source, rotation, crop)

    preview = source.copy()
    preview.thumbnail((PREVIEW_MAX_PX, PREVIEW_MAX_PX))
    _save_atomic(preview, out_dir / "preview.jpg", quality=90)

    thumb = source.copy()
    thumb.thumbnail((THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX))
    _save_atomic(thumb, out_dir / "thumbnail.jpg", quality=85)


def _save_atomic(image: PILImage.Image, dest: Path, quality: int) -> None:
    """Write to a temp file in the same dir, then rename into place. The
    thumbnail endpoint can generate a derivative on-demand at the same time the
    background worker is writing it after import; an atomic rename means a
    reader always sees either the old file or a fully-written new one, never a
    half-written JPEG."""
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    image.save(tmp, "JPEG", quality=quality)
    os.replace(tmp, dest)


def regenerate_for_image(image: "Image") -> None:
    from app.services.filesystem import resolve_image_path

    crop = None
    if image.edit_crop_x is not None:
        crop = (image.edit_crop_x, image.edit_crop_y, image.edit_crop_width, image.edit_crop_height)
    generate_derivatives(
        image.id, resolve_image_path(image), rotation=image.edit_rotation, crop=crop
    )
