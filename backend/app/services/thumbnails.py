import io
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image as PILImage

from app.config import settings
from app.services.raw import extract_full_preview

if TYPE_CHECKING:
    from app.db.models import Image

THUMBNAIL_MAX_PX = 512
PREVIEW_MAX_PX = 2048

CropBox = tuple[float, float, float, float]

# The non-destructive slider edits, in the order the frontend editor lists them.
# Each is an int in -100..100 (0 = neutral). The exact same math runs in the
# browser for the live preview (see frontend utils/adjustments.ts) - keep the two
# in sync so what you see while editing matches the saved render.
ADJUSTMENT_FIELDS = (
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "saturation",
    "temperature",
    "tint",
)

# Rec. 709 luma weights, used for the highlight/shadow masks and saturation.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


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


# Per-hue color mixer bands and their centre hues (degrees). The circle is split
# into the segments between adjacent centres; a pixel's hue is blended between the
# two bands bounding its segment (partition of unity), so shifts stay smooth.
COLOR_BANDS = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
_BAND_EDGES = (0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0, 360.0)


def _rgb_to_hsl(arr: np.ndarray):
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    lum = (mx + mn) / 2.0
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = np.where(d == 0, 0.0, d / (1.0 - np.abs(2.0 * lum - 1.0) + 1e-9))
        hue = np.zeros_like(mx)
        rm = (mx == r) & (d != 0)
        gm = (mx == g) & (d != 0)
        bm = (mx == b) & (d != 0)
        hue[rm] = (((g - b) / d)[rm] % 6.0)
        hue[gm] = (((b - r) / d)[gm] + 2.0)
        hue[bm] = (((r - g) / d)[bm] + 4.0)
        hue = (hue * 60.0) % 360.0
    return hue, np.clip(sat, 0.0, 1.0), lum


def _hsl_to_rgb(hue: np.ndarray, sat: np.ndarray, lum: np.ndarray) -> np.ndarray:
    c = (1.0 - np.abs(2.0 * lum - 1.0)) * sat
    hp = (hue % 360.0) / 60.0
    x = c * (1.0 - np.abs(hp % 2.0 - 1.0))
    z = np.zeros_like(hue)
    r, g, b = z.copy(), z.copy(), z.copy()
    for lo, (rr, gg, bb) in enumerate([(c, x, z), (x, c, z), (z, c, x), (z, x, c), (x, z, c), (c, z, x)]):
        m = (hp >= lo) & (hp < lo + 1)
        r = np.where(m, rr, r)
        g = np.where(m, gg, g)
        b = np.where(m, bb, b)
    m = lum - c / 2.0
    return np.clip(np.stack([r + m, g + m, b + m], axis=-1), 0.0, 1.0)


def _apply_color_mix(arr: np.ndarray, mix: dict) -> np.ndarray:
    """Shift hue / saturation / luminance of each colour band. `mix` maps a band
    name to [hue, sat, lum], each -100..100."""
    bands = {b: mix.get(b, [0, 0, 0]) for b in COLOR_BANDS}
    if not any(any(v) for v in bands.values()):
        return arr
    hue, sat, lum = _rgb_to_hsl(arr)
    hue_shift = np.zeros_like(hue)
    sat_adj = np.zeros_like(hue)
    lum_adj = np.zeros_like(hue)
    for j in range(8):
        lo, hi = _BAND_EDGES[j], _BAND_EDGES[j + 1]
        b0 = list(bands.values())[j]
        b1 = list(bands.values())[(j + 1) % 8]
        m = (hue >= lo) & (hue < hi)
        t = (hue[m] - lo) / (hi - lo)
        hue_shift[m] = (1 - t) * b0[0] + t * b1[0]
        sat_adj[m] = (1 - t) * b0[1] + t * b1[1]
        lum_adj[m] = (1 - t) * b0[2] + t * b1[2]
    hue = (hue + hue_shift * 0.3) % 360.0  # +/-30 degrees at the extremes
    sat = np.clip(sat * (1.0 + sat_adj / 100.0), 0.0, 1.0)
    lum = np.clip(lum + lum_adj / 100.0 * 0.25, 0.0, 1.0)
    return _hsl_to_rgb(hue, sat, lum)


def _apply_vignette(arr: np.ndarray, amount: int) -> np.ndarray:
    """Darken (amount<0) or lighten (amount>0) the corners, smooth radial falloff."""
    h, w = arr.shape[:2]
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    r2 = np.clip((xx * xx + yy * yy) / 2.0, 0.0, 1.0)  # 0 centre .. 1 corner
    factor = 1.0 + (amount / 100.0) * r2
    return np.clip(arr * factor[..., None], 0.0, 1.0)


def _adjust_array(arr: np.ndarray, adj: dict) -> np.ndarray:
    """Apply the tonal/color slider edits to an HxWx3 float array in 0..1.

    This is the reference pipeline; the browser preview mirrors it exactly. Order
    matters: exposure -> white balance -> highlights/shadows -> contrast ->
    saturation. Everything is done in naive sRGB (no linearization) - fast and
    good enough for a simple editor, and trivially matched in JS.
    """
    e = adj.get("exposure", 0) / 100.0
    c = adj.get("contrast", 0) / 100.0
    hi = adj.get("highlights", 0) / 100.0
    sh = adj.get("shadows", 0) / 100.0
    s = adj.get("saturation", 0) / 100.0
    t = adj.get("temperature", 0) / 100.0
    n = adj.get("tint", 0) / 100.0

    if e:
        arr = arr * (2.0 ** e)  # +/- one stop at the extremes
    if t:
        arr[..., 0] *= 1.0 + 0.2 * t  # warm: more red
        arr[..., 2] *= 1.0 - 0.2 * t  # ...less blue
    if n:
        arr[..., 1] *= 1.0 - 0.2 * n  # +tint = magenta (less green)
    np.clip(arr, 0.0, 1.0, out=arr)

    if hi or sh:
        luma = arr @ _LUMA
        if sh:
            arr += (sh * 0.5 * (1.0 - luma) ** 2)[..., None]
        if hi:
            arr += (hi * 0.5 * luma**2)[..., None]
        np.clip(arr, 0.0, 1.0, out=arr)

    if c:
        arr = (arr - 0.5) * (1.0 + c) + 0.5
        np.clip(arr, 0.0, 1.0, out=arr)
    mix = adj.get("color_mix")
    if mix:
        arr = _apply_color_mix(np.clip(arr, 0.0, 1.0), mix)
    if s:
        luma = (arr @ _LUMA)[..., None]
        arr = luma + (arr - luma) * (1.0 + s)

    return np.clip(arr, 0.0, 1.0)


def _has_edits(adj: dict) -> bool:
    if any(adj.get(k, 0) for k in ADJUSTMENT_FIELDS):
        return True
    if adj.get("vignette", 0):
        return True
    mix = adj.get("color_mix") or {}
    return any(any(v) for v in mix.values())


def apply_adjustments(image: PILImage.Image, adj: dict) -> PILImage.Image:
    """Return a new image with the slider edits baked in, or the input untouched
    when everything is neutral (the common case - avoids a needless numpy pass)."""
    if not _has_edits(adj):
        return image
    rgb = image.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    arr = _adjust_array(arr, adj)
    if adj.get("vignette", 0):
        arr = _apply_vignette(arr, adj["vignette"])
    out = (arr * 255.0 + 0.5).astype(np.uint8)
    return PILImage.fromarray(out, "RGB")


def generate_derivatives(
    image_id: str,
    source_path: Path,
    rotation: int = 0,
    crop: CropBox | None = None,
    adjustments: dict | None = None,
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
    if adjustments:
        source = apply_adjustments(source, adjustments)

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


def render_base_preview_bytes(image: "Image", max_px: int = PREVIEW_MAX_PX) -> bytes:
    """A JPEG of the auto-oriented original with *no* edits applied - no rotation,
    crop or tonal changes. The editor applies all of those live on top of this
    clean base (initialised from the photo's saved edits), so nothing is applied
    twice and the whole edit stays a preview until the user saves."""
    from app.services.filesystem import resolve_image_path

    source = extract_full_preview(resolve_image_path(image))
    source.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    source.convert("RGB").save(buf, "JPEG", quality=90)
    return buf.getvalue()


def render_edited_image(
    image: "Image", rotation: int, crop: CropBox | None, adjustments: dict
) -> PILImage.Image:
    """Full-resolution RGB render with the given rotation, crop and tonal edits
    baked in. Used to write a flattened edited *copy* into the library."""
    from app.services.filesystem import resolve_image_path

    source = extract_full_preview(resolve_image_path(image))
    source = apply_edits(source, rotation, crop)
    source = apply_adjustments(source, adjustments)
    return source.convert("RGB")


def adjustments_from_image(image: "Image") -> dict:
    """The full tonal/color edit dict (sliders + colour mixer + vignette) read off
    an Image row, ready for apply_adjustments / generate_derivatives."""
    adj = {name: getattr(image, f"edit_{name}", 0) or 0 for name in ADJUSTMENT_FIELDS}
    adj["vignette"] = getattr(image, "edit_vignette", 0) or 0
    raw = getattr(image, "edit_color_mix", None)
    if raw:
        try:
            adj["color_mix"] = json.loads(raw)
        except (ValueError, TypeError):
            adj["color_mix"] = None
    return adj


def regenerate_for_image(image: "Image") -> None:
    from app.services.filesystem import resolve_image_path

    crop = None
    if image.edit_crop_x is not None:
        crop = (image.edit_crop_x, image.edit_crop_y, image.edit_crop_width, image.edit_crop_height)
    adjustments = adjustments_from_image(image)
    generate_derivatives(
        image.id,
        resolve_image_path(image),
        rotation=image.edit_rotation,
        crop=crop,
        adjustments=adjustments,
    )
