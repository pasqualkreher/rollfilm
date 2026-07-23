import io
import logging
import math
from pathlib import Path

import numpy as np
import rawpy
from PIL import Image as PILImage
from PIL import ImageOps

logger = logging.getLogger(__name__)

# Rec.709 luma weights, for measuring overall image brightness.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Auto tone: lift a native-exposure demosaic to a normal brightness *without
# burning the highlights*. The exposure gain is measured from the MIDTONES (the
# median), not the brightest point - so a sunlit subject (skin, snow) isn't
# chased up into clipping the way "expose to the right" does. A Reinhard shoulder
# on the LUMINANCE then rolls the highlights off smoothly toward white, so
# nothing hard-clips. _TARGET_MED_LIN is the median target in *linear* light
# (~sRGB 0.36); _MAX_GAIN caps the lift so a very dark frame isn't amplified
# into noise. The cap can be generous because the shoulder protects the top end
# - and it has to be: DR-mode Fuji RAFs demosaic 2-3 stops dark, so a tight cap
# left every such frame underexposed.
_TARGET_MED_LIN = 0.10
_MAX_GAIN = 8.0


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)

# When True, RAWs are loaded with NO brightness processing at all - just the
# native (camera-white-balanced, no auto-bright) demosaic, exactly as the sensor
# recorded it. Toggled from Settings ("load RAWs without processing"); the app
# sets it at startup and whenever the setting changes (see set_native_decode).
_native_decode = False


def set_native_decode(enabled: bool) -> None:
    """Enable/disable no-processing RAW loading (native exposure, no lift)."""
    global _native_decode
    _native_decode = bool(enabled)


def native_decode_enabled() -> bool:
    return _native_decode


def _auto_expose(rgb: np.ndarray) -> np.ndarray:
    """Auto-tone a native-exposure demosaic to a normal brightness that can't
    burn the highlights.

    Two steps, both in linear light:
    1. Exposure from the *midtones*: measure the median luma and pick a gain that
       brings it to _TARGET_MED_LIN. Basing it on the median (not the brightest
       point) means a sunlit subject isn't dragged up into clipping.
    2. A Reinhard shoulder with the white point set to that same gain, which lifts
       shadows/midtones by the gain, rolls the highlights off smoothly, and pins
       pure white to pure white - so nothing hard-clips. A well-exposed frame
       (gain ~1) passes through essentially unchanged.

    The shoulder is applied to the LUMINANCE and the RGB channels are scaled by
    one shared ratio. Running the curve per channel instead compresses the
    brightest channel of a colour hardest, so bright saturated subjects (sunlit
    skin above all - red is its top channel) converge toward grey and come out
    chalky-white even though nothing clips - the actual cause of "the skin is
    burning out". One ratio per pixel preserves hue and saturation through the
    lift; the rare pixel a bright channel pushes past 1.0 just clips."""
    x = rgb.astype(np.float32) / 255.0
    lin = _srgb_to_linear(x)
    # Median midtone level (strided sample so a full-frame demosaic is cheap).
    s = max(1, int(math.sqrt(rgb.shape[0] * rgb.shape[1] / 90_000)))
    med = float(np.median(lin[::s, ::s] @ _LUMA))
    if med <= 1e-4:  # essentially black - nothing to lift
        return rgb
    gain = min(_MAX_GAIN, max(1.0, _TARGET_MED_LIN / med))
    if gain <= 1.0 + 1e-3:  # already at a normal exposure
        return rgb
    # Reinhard-extended with white point W = gain, on luminance:
    # Y_out = Y*gain*(1 + Y/gain)/(1 + Y*gain) - lifts shadows/mids by ~gain,
    # rolls off highlights, maps Y=1 -> 1.
    y = lin @ _LUMA
    yg = y * gain
    y_out = yg * (1.0 + y / gain) / (1.0 + yg)
    ratio = np.where(y > 1e-6, y_out / np.maximum(y, 1e-6), gain)
    out = _linear_to_srgb(np.clip(lin * ratio[..., None], 0.0, 1.0))
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)

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


def _demosaic_rgb(raw: "rawpy.RawPy", half_size: bool):
    """Demosaic a RAW to an 8-bit RGB array with a highlight-safe rendering.

    `no_auto_bright=True` is the important bit: LibRaw's default auto-brightness
    scales the whole image up until ~1% of the brightest pixels clip to pure
    white (auto_bright_thr=0.01). On a shot with a bright subject - sunlit skin,
    snow, a white shirt - that pushes those pixels to 255, blowing the highlights
    *inside the decode*, before the editor ever sees them, so the Highlights /
    Whites sliders have nothing left to recover. Disabling it renders the RAW at
    its native (camera-white-balanced) exposure instead; a globally dark frame is
    trivially lifted with the Exposure slider, but blown highlights are gone for
    good.

    `highlight_mode=Blend` additionally reconstructs highlights where one channel
    clips but the others don't (common on saturated skin), blending them for a
    smooth roll-off rather than a hard clipped edge.

    `gamma=(2.4, 12.92)` encodes the 8-bit output with the true sRGB curve
    instead of LibRaw's BT.709 default (2.222, 4.5) - _auto_expose linearises
    with the sRGB EOTF, so the round trip is exact.

    half_size only affects output resolution, not colour rendering - without it
    LibRaw raises LibRawTooBigError on high-megapixel sensors.

    Returns the *native* exposure - the caller auto-tones it (see _auto_expose)
    unless native-decode mode is on."""
    return raw.postprocess(
        use_camera_wb=True,
        half_size=half_size,
        no_auto_bright=True,
        highlight_mode=rawpy.HighlightMode.Blend,
        gamma=(2.4, 12.92),
    )


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

        rgb = _demosaic_rgb(raw, half_size=True)
        if not _native_decode:
            rgb = _auto_expose(rgb)
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

    try:
        with rawpy.imread(str(path)) as raw:
            rgb = _demosaic_rgb(raw, half_size=True)
            if _native_decode:
                # No processing: hand back the native-exposure demosaic as-is.
                return PILImage.fromarray(rgb)
            # Midtone-based auto tone (see _auto_expose).
            return PILImage.fromarray(_auto_expose(rgb))
    except Exception:
        # A file whose sensor data is damaged (e.g. truncated/corrupt CFA
        # block) fails the demosaic, but its embedded JPEG is often still
        # intact - serve that instead of leaving the photo with no image at
        # all. The file must be reopened: a failed postprocess() leaves the
        # LibRaw handle unusable (extract_thumb() then raises OutOfOrderCall).
        embedded = _embedded_jpeg(path)
        if embedded is None:
            raise
        logger.warning(
            "RAW demosaic failed for %s - falling back to the embedded JPEG preview",
            path,
            exc_info=True,
        )
        return embedded


def _embedded_jpeg(path: Path) -> PILImage.Image | None:
    """The RAW's embedded JPEG as a PIL image, or None if there isn't a usable
    one. Never raises - this is the last resort for damaged files."""
    try:
        with rawpy.imread(str(path)) as raw:
            thumb = raw.extract_thumb()
            if thumb.format != rawpy.ThumbFormat.JPEG:
                return None
            im = PILImage.open(io.BytesIO(thumb.data))
            im.load()
            return ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        return None
