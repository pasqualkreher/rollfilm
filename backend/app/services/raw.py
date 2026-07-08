import io
from pathlib import Path

import rawpy
from PIL import Image as PILImage
from PIL import ImageOps

RAW_EXTENSIONS = {
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw",
}
JPEG_EXTENSIONS = {".jpg", ".jpeg"}
PNG_EXTENSIONS = {".png"}


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXTENSIONS


def classify_file_type(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in RAW_EXTENSIONS:
        return "raw"
    if suffix in JPEG_EXTENSIONS:
        return "jpeg"
    if suffix in PNG_EXTENSIONS:
        return "png"
    return None


def extract_preview(path: Path) -> PILImage.Image:
    """Fast, decode-cheap preview used for hashing/thumbnailing.

    For RAW files this prefers the embedded JPEG preview (near-instant) and
    only falls back to a full demosaic when a camera doesn't embed one.

    Applies the file's own EXIF orientation so portrait shots come out
    right-side-up rather than however the sensor recorded them - standard
    behavior in any photo viewer. exif_transpose() is a no-op when there's no
    orientation tag to read (e.g. the postprocess() array below has none).
    """
    if not is_raw(path):
        return ImageOps.exif_transpose(PILImage.open(path)).convert("RGB")

    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
        except rawpy.LibRawNoThumbnailError:
            thumb = None

        if thumb is not None and thumb.format == rawpy.ThumbFormat.JPEG:
            img = PILImage.open(io.BytesIO(thumb.data))
            return ImageOps.exif_transpose(img).convert("RGB")

        rgb = raw.postprocess(use_camera_wb=True, half_size=True)
        return PILImage.fromarray(rgb)


def extract_full_preview(path: Path) -> PILImage.Image:
    """True RAW demosaic, used for the final thumbnail/preview shown once a
    photo is committed to the library (and for zapping through RAW files in
    the import lightbox).

    extract_preview() above reuses the RAW's *embedded* JPEG thumbnail for
    speed, but that thumbnail is rendered by the camera's own JPEG engine -
    on Fuji bodies in particular, it already has the active Film Simulation
    recipe baked in, making the "RAW" preview look identical to its JPEG
    sibling instead of showing the actual unprocessed sensor data. This
    always demosaics instead, at the cost of being slower (fine here since
    it only runs once per photo, in the background).
    """
    if not is_raw(path):
        return ImageOps.exif_transpose(PILImage.open(path)).convert("RGB")

    with rawpy.imread(str(path)) as raw:
        # half_size only affects output resolution, not color rendering -
        # it's unrelated to the embedded-thumbnail issue above, but without
        # it LibRaw raises LibRawTooBigError on high-megapixel sensors.
        rgb = raw.postprocess(use_camera_wb=True, half_size=True)
        return PILImage.fromarray(rgb)
