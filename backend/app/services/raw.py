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
# chased up into clipping the way "expose to the right" does. The gain is NOT
# baked into the pixels: it travels alongside the linear array as `base_gain`
# and is applied as the first step of the develop pipeline, where a Reinhard
# shoulder with white point = gain rolls the highlights off smoothly (see
# thumbnails._linear_tone_block / default_tone_to_srgb). _TARGET_MED_LIN is the
# median target in *linear* light (~sRGB 0.36); _MAX_GAIN caps the lift so a
# very dark frame isn't amplified into noise. The cap can be generous because
# the shoulder protects the top end - and it has to be: DR-mode Fuji RAFs
# demosaic 2-3 stops dark, so a tight cap left every such frame underexposed.
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


def compute_base_gain(lin: np.ndarray) -> float:
    """The auto-exposure gain for a linear-light array: lift the median luma to
    _TARGET_MED_LIN, capped at _MAX_GAIN. Basing it on the median (not the
    brightest point) means a sunlit subject isn't dragged up into clipping.
    Returns 1.0 in native-decode mode (the "no processing" setting) and for
    frames that are already at a normal exposure or essentially black."""
    if _native_decode:
        return 1.0
    # Median midtone level (strided sample so a full-frame demosaic is cheap).
    s = max(1, int(math.sqrt(lin.shape[0] * lin.shape[1] / 90_000)))
    med = float(np.median(lin[::s, ::s] @ _LUMA))
    if med <= 1e-4:  # essentially black - nothing to lift
        return 1.0
    return float(min(_MAX_GAIN, max(1.0, _TARGET_MED_LIN / med)))


def reinhard_ratio(y: np.ndarray, white: float) -> np.ndarray:
    """Per-pixel luminance ratio of the Reinhard-extended shoulder with white
    point `white`: Y_out = Y*(1 + Y/W^2)/(1 + Y), evaluated as a shared RGB
    ratio so hue/saturation survive the roll-off (a per-channel curve would
    compress the brightest channel of a colour hardest and turn sunlit skin
    chalky). Maps 0 -> 0 and W -> 1 monotonically; identity-like for Y << 1
    when W = 1, so JPEG sources pass through essentially unchanged."""
    w2 = max(float(white), 1.0) ** 2
    y_out = y * (1.0 + y / w2) / (1.0 + y)
    return np.where(y > 1e-6, y_out / np.maximum(y, 1e-6), 1.0).astype(np.float32)


def default_tone_to_srgb(lin: np.ndarray, gain: float) -> np.ndarray:
    """The neutral (no-edits) rendering of a linear base: apply the base gain,
    roll the highlights off with a Reinhard shoulder whose white point is that
    same gain, and encode to 8-bit sRGB. Algebraically identical to the old
    baked _auto_expose (shoulder yg*(1+y/g)/(1+yg) == Reinhard-extended at
    L=y*g, W=g), so unedited RAWs render exactly as before the linear-pipeline
    refactor. With gain 1.0 (native decode / JPEG) the shoulder is a no-op for
    in-range values."""
    y = (lin @ _LUMA) * gain
    ratio = gain * reinhard_ratio(y, gain)
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


def _demosaic_linear(raw: "rawpy.RawPy", half_size: bool) -> np.ndarray:
    """Demosaic a RAW to a linear-light float32 RGB array (0..~1, sRGB primaries).

    `no_auto_bright=True` is the important bit: LibRaw's default auto-brightness
    scales the whole image up until ~1% of the brightest pixels clip to pure
    white (auto_bright_thr=0.01). On a shot with a bright subject - sunlit skin,
    snow, a white shirt - that pushes those pixels to the ceiling, blowing the
    highlights *inside the decode*, before the editor ever sees them, so the
    Highlights / Whites sliders have nothing left to recover. Disabling it
    renders the RAW at its native (camera-white-balanced) exposure instead; the
    develop pipeline lifts it with `base_gain` where the real image data above
    the display white point stays recoverable.

    `highlight_mode=Blend` additionally reconstructs highlights where one channel
    clips but the others don't (common on saturated skin), blending them for a
    smooth roll-off rather than a hard clipped edge.

    `gamma=(1, 1)` + `output_bps=16` keep the output linear at 16-bit depth -
    the develop pipeline works scene-referred in linear light and only encodes
    to sRGB at the very end, so a 14-bit sensor isn't crushed to 256 levels
    before editing.

    half_size only affects output resolution, not colour rendering; the editor
    bases are capped well below even the half-size resolution, so they pass
    half_size=True and only the final full-resolution renders pay for a full
    demosaic."""
    rgb16 = raw.postprocess(
        use_camera_wb=True,
        half_size=half_size,
        no_auto_bright=True,
        highlight_mode=rawpy.HighlightMode.Blend,
        gamma=(1, 1),
        output_bps=16,
    )
    return np.asarray(rgb16, dtype=np.float32) / 65535.0


def raw_dimensions(path: Path) -> tuple[int, int] | None:
    """Displayed pixel dimensions of a RAW's rendered output, from the file
    header alone (no demosaic - a cheap metadata read).

    The EXIF ImageWidth/Height fields of many RAW formats (Fuji RAF in
    particular) describe the *embedded preview JPEG*, not the sensor output -
    e.g. 4416x2944 for a 7728x5152 camera - so metadata built from them
    undersells the RAW everywhere the recorded size is shown or used.
    LibRaw's sizes.width/height is the active sensor area, exactly what
    postprocess() renders; sizes.flip mirrors the orientation tag, so
    quarter-turned shots swap to displayed orientation like exif.read_exif
    does for JPEGs."""
    try:
        with rawpy.imread(str(path)) as raw:
            s = raw.sizes
            w, h = int(s.width), int(s.height)
            if s.flip in (5, 6):  # LibRaw flip: 0=none, 3=180deg, 5/6=quarter turns
                w, h = h, w
            return (w, h) if w > 0 and h > 0 else None
    except Exception:
        logger.exception("Could not read RAW dimensions from %s", path)
        return None


def _linearise_pil(im: PILImage.Image) -> np.ndarray:
    """EXIF-orient an opened PIL image and linearise it with the sRGB EOTF.
    Scales in place and skips the redundant astype so a full-frame JPEG needs
    one float32 buffer plus the block temporaries, not three."""
    im = ImageOps.exif_transpose(im).convert("RGB")
    arr = np.asarray(im, dtype=np.float32)
    arr /= 255.0
    return _srgb_to_linear(arr)


def load_linear_base(
    path: Path, half_size: bool = True, max_px: int | None = None
) -> tuple[np.ndarray, float]:
    """The develop pipeline's source of truth: a linear-light float32 RGB array
    plus its auto-exposure `base_gain` (1.0 in native-decode mode).

    RAW files are demosaiced linearly (see _demosaic_linear); a damaged file
    whose demosaic fails falls back to its embedded JPEG, linearised, with gain
    1.0 (the camera already exposed the JPEG). JPEG/PNG sources are decoded,
    EXIF-oriented and linearised with the sRGB EOTF, gain 1.0.

    `max_px` is the long edge the caller actually needs. It's the JPEG/PNG
    counterpart of `half_size`: without it a 26MP camera JPEG was decoded at
    full resolution to render a 2600px derivative, costing ~4x the pixels (and
    ~2GB peak) of the RAW path for the same output. libjpeg decodes at the
    smallest DCT scale (1/2, 1/4, 1/8) still at or above the target, so the
    result is never smaller than requested - the caller's own LANCZOS/INTER_AREA
    downscale does the rest, exactly as before. None = decode full size."""
    if not is_raw(path):
        im = PILImage.open(path)
        if max_px:
            w, h = im.size
            long_edge = max(w, h)
            if long_edge > max_px:
                scale = max_px / long_edge
                # draft() is a no-op for non-JPEG formats (PNG has no DCT).
                im.draft("RGB", (max(1, round(w * scale)), max(1, round(h * scale))))
        return _linearise_pil(im), 1.0

    try:
        with rawpy.imread(str(path)) as raw:
            lin = _demosaic_linear(raw, half_size=half_size)
            return lin, compute_base_gain(lin)
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
        # Already EXIF-transposed by _embedded_jpeg; exif_transpose strips the
        # orientation tag it honours, so running it again is a no-op.
        return _linearise_pil(embedded), 1.0


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXTENSIONS


def decode_reduction(path: Path, decoded_shape: tuple[int, ...]) -> float:
    """How much smaller a `max_px`-budgeted decode came out than the unbudgeted
    one (>= 1.0). Lets a caller that sizes its output as a *fraction of the
    frame* keep that output identical while decoding less: multiply the fraction
    by this. Always 1.0 for RAW, where max_px has no effect."""
    if is_raw(path):
        return 1.0
    try:
        with PILImage.open(path) as im:
            original = max(_oriented_size(im))
    except Exception:
        return 1.0
    decoded = max(decoded_shape[0], decoded_shape[1])
    return original / decoded if decoded and original else 1.0


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

        lin = _demosaic_linear(raw, half_size=True)
        preview = PILImage.fromarray(default_tone_to_srgb(lin, compute_base_gain(lin)))
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

    # load_linear_base handles the damaged-file embedded-JPEG fallback.
    lin, gain = load_linear_base(path, half_size=True)
    return PILImage.fromarray(default_tone_to_srgb(lin, gain))


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
