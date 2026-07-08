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
    preview.save(out_dir / "preview.jpg", "JPEG", quality=90)

    thumb = source.copy()
    thumb.thumbnail((THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX))
    thumb.save(out_dir / "thumbnail.jpg", "JPEG", quality=85)


def regenerate_for_image(image: "Image") -> None:
    crop = None
    if image.edit_crop_x is not None:
        crop = (image.edit_crop_x, image.edit_crop_y, image.edit_crop_width, image.edit_crop_height)
    generate_derivatives(
        image.id, settings.library_root / image.file_path, rotation=image.edit_rotation, crop=crop
    )
