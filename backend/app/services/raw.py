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

# extract_preview() feeds hashing, the grid-sized thumbnail and the CLIP
# encoder - none of which need more than ~1600px. Decoding a full 24-40MP camera
# JPEG just to throw most of it away is the biggest per-JPEG staging cost, so we
# ask libjpeg to decode at the largest DCT scale (1/2, 1/4, 1/8) that still lands
# at or above this size. draft() is a no-op for non-JPEG formats.
_PREVIEW_DECODE_PX = 1600


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


def _load_jpeg_preview(im: PILImage.Image) -> PILImage.Image:
    """Decode an already-opened JPEG (or other PIL-native image) at a reduced
    DCT scale when it's larger than we need. The draft box is scaled to the
    image's aspect ratio so the *long* edge lands near _PREVIEW_DECODE_PX - a
    square box would gate on the short edge and never reduce a wide photo."""
    w, h = im.size
    long_edge = max(w, h)
    if long_edge > _PREVIEW_DECODE_PX:
        scale = _PREVIEW_DECODE_PX / long_edge
        im.draft("RGB", (max(1, round(w * scale)), max(1, round(h * scale))))
    return ImageOps.exif_transpose(im).convert("RGB")


def extract_preview(path: Path) -> PILImage.Image:
    """Fast, decode-cheap preview used for hashing/thumbnailing.

    For RAW files this prefers the embedded JPEG preview (near-instant) and
    only falls back to a full demosaic when a camera doesn't embed one.

    Applies the file's own EXIF orientation so portrait shots come out
    right-side-up rather than however the sensor recorded them - standard
    behavior in any photo viewer. exif_transpose() is a no-op when there's no
    orientation tag to read (e.g. the postprocess() array below has none).
    """
    return extract_preview_with_size(path)[0]


def _oriented_size(im: PILImage.Image) -> tuple[int, int]:
    """The image's displayed (width, height) from its header alone - swapping
    the stored dimensions when the EXIF orientation is a quarter turn, the same
    way exif_transpose() would. Read before any draft()-reduced decode, so it
    reports the *true* original size, not the shrunken preview's."""
    w, h = im.size
    if im.getexif().get(0x0112) in (5, 6, 7, 8):
        return h, w
    return w, h


def extract_preview_with_size(path: Path) -> tuple[PILImage.Image, tuple[int, int]]:
    """extract_preview() plus the true displayed dimensions of the *original*.

    The preview is decoded at a reduced DCT scale when the source is larger
    than needed (see _load_jpeg_preview) - including a RAW's embedded JPEG,
    which cameras store at full sensor resolution. The size is read from the
    header *before* the reduced decode, so a caller sizing a thumbnail as a
    fraction of the original (staging) still sees the full dimensions.
    """
    if not is_raw(path):
        im = PILImage.open(path)
        original_size = _oriented_size(im)
        return _load_jpeg_preview(im), original_size

    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
        except rawpy.LibRawNoThumbnailError:
            thumb = None

        if thumb is not None and thumb.format == rawpy.ThumbFormat.JPEG:
            im = PILImage.open(io.BytesIO(thumb.data))
            original_size = _oriented_size(im)
            return _load_jpeg_preview(im), original_size

        rgb = raw.postprocess(use_camera_wb=True, half_size=True)
        preview = PILImage.fromarray(rgb)
        return preview, preview.size


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
