import io
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image as PILImage, ImageFilter

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
    "whites",
    "blacks",
    "dehaze",
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


def apply_distortion(image: PILImage.Image, amount: int) -> PILImage.Image:
    """Radial lens-distortion correction (geometric), circular in pixel space
    (aspect-correct). +amount corrects barrel (pulls content in), -amount corrects
    pincushion. Nearest sampling; the JS live preview mirrors this exactly."""
    if not amount:
        return image
    rgb = np.asarray(image.convert("RGB"))
    h, w = rgb.shape[:2]
    k = amount / 100.0 * 0.25
    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0
    half = max(w, h) / 2.0  # common scale for both axes -> circular, not elliptical
    ys, xs = np.meshgrid(np.arange(h, dtype=np.float32), np.arange(w, dtype=np.float32), indexing="ij")
    dx = (xs - cx) / half
    dy = (ys - cy) / half
    factor = 1.0 + k * (dx * dx + dy * dy)
    sx = np.clip(np.rint(cx + (xs - cx) * factor), 0, w - 1).astype(np.int32)
    sy = np.clip(np.rint(cy + (ys - cy) * factor), 0, h - 1).astype(np.int32)
    return PILImage.fromarray(rgb[sy, sx], "RGB")


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


def _apply_color_mix(arr: np.ndarray, mix: dict, tint: int = 0) -> np.ndarray:
    """Shift hue / saturation / luminance of each colour band. `mix` maps a band
    name to [hue, sat, lum], each -100..100. `tint` rotates *all* hues
    (-100..100 -> +/-180 deg) to shift the whole palette."""
    bands = {b: mix.get(b, [0, 0, 0]) for b in COLOR_BANDS}
    if not tint and not any(any(v) for v in bands.values()):
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
    # +/-180 degrees at the extremes, so a band can be pushed all the way to a
    # different colour (with wrap, any target hue is reachable). The global tint
    # rotates every hue on top of the per-band shifts.
    hue = (hue + hue_shift * 1.8 + tint / 100.0 * 180.0) % 360.0
    sat = np.clip(sat * (1.0 + sat_adj / 100.0), 0.0, 1.0)
    rgb = _hsl_to_rgb(hue, sat, lum)
    # Luminance as a brightness scale (preserves the band's colour). Moving HSL
    # lightness instead washes each band toward white/black - which looked broken.
    factor = (1.0 + lum_adj / 100.0 * 0.5)[..., None]
    return np.clip(rgb * factor, 0.0, 1.0)


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
    wh = adj.get("whites", 0) / 100.0
    bl = adj.get("blacks", 0) / 100.0
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

    # Whites/blacks act on the very ends of the tone range (cubic mask, so more
    # concentrated at the extremes than highlights/shadows).
    if wh or bl:
        luma = arr @ _LUMA
        if wh:
            arr += (wh * 0.5 * luma**3)[..., None]
        if bl:
            arr += (bl * 0.5 * (1.0 - luma) ** 3)[..., None]
        np.clip(arr, 0.0, 1.0, out=arr)

    if c:
        arr = (arr - 0.5) * (1.0 + c) + 0.5
        np.clip(arr, 0.0, 1.0, out=arr)

    # Dehaze: haze is a bright, desaturated veil sitting mostly in the shadows/
    # mids. Unlike Contrast (a symmetric S-curve), +dehaze *only* pulls that veil
    # down (asymmetric, weighted to darker tones) and restores saturation;
    # -dehaze lifts the shadows + desaturates for a soft, hazy look.
    dh = adj.get("dehaze", 0) / 100.0
    if dh:
        luma = arr @ _LUMA
        arr = arr - (dh * 0.22) * ((1.0 - luma) ** 2)[..., None]
        np.clip(arr, 0.0, 1.0, out=arr)
        luma2 = (arr @ _LUMA)[..., None]
        arr = luma2 + (arr - luma2) * (1.0 + dh * 0.6)
        np.clip(arr, 0.0, 1.0, out=arr)

    mix = adj.get("color_mix")
    tint = adj.get("color_tint", 0)
    if mix or tint:
        arr = _apply_color_mix(np.clip(arr, 0.0, 1.0), mix or {}, tint)
    if s:
        luma = (arr @ _LUMA)[..., None]
        arr = luma + (arr - luma) * (1.0 + s)

    return np.clip(arr, 0.0, 1.0)


def _apply_grain(arr: np.ndarray, amount: int, size: int = 0) -> np.ndarray:
    """Add monochrome film grain (luminance noise). `size` (0..100) controls the
    grain's coarseness: noise is generated at a lower resolution and scaled up so
    higher size = chunkier grain. Stochastic - preview uses a different pattern."""
    h, w = arr.shape[:2]
    scale = 1.0 + (size / 100.0) * 4.0  # 1x .. 5x coarser
    nh = max(1, int(round(h / scale)))
    nw = max(1, int(round(w / scale)))
    small = np.random.rand(nh, nw).astype(np.float32)
    if (nh, nw) != (h, w):
        small_pil = PILImage.fromarray((small * 255.0 + 0.5).astype(np.uint8), "L")
        noise = np.asarray(small_pil.resize((w, h), PILImage.BILINEAR), dtype=np.float32) / 255.0
    else:
        noise = small
    noise = (noise - 0.5) * (amount / 100.0) * 0.2
    return np.clip(arr + noise[..., None], 0.0, 1.0)


def _unsharp(arr: np.ndarray, radius: float, amount: float) -> np.ndarray:
    """Unsharp mask: out = in + amount*(in - blur(in)). Positive amount sharpens,
    negative softens. Small radius = sharpness."""
    pil = PILImage.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    blur = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    return np.clip(arr + amount * (arr - blur), 0.0, 1.0)


def _clarity(arr: np.ndarray, radius: float, amount: float) -> np.ndarray:
    """Fujifilm-style clarity: large-radius local contrast weighted toward the
    midtones (so highlights/shadows aren't crushed). Positive = punchier mids,
    negative = softer."""
    pil = PILImage.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    blur = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    luma = arr @ _LUMA
    mask = (1.0 - np.abs(2.0 * luma - 1.0))[..., None]  # peaks at midtones
    return np.clip(arr + amount * (arr - blur) * mask, 0.0, 1.0)


def _has_edits(adj: dict) -> bool:
    if any(adj.get(k, 0) for k in ADJUSTMENT_FIELDS):
        return True
    for k in ("vignette", "grain", "denoise", "clarity", "sharpness", "color_tint"):
        if adj.get(k, 0):
            return True
    mix = adj.get("color_mix") or {}
    return any(any(v) for v in mix.values())


def apply_adjustments(image: PILImage.Image, adj: dict) -> PILImage.Image:
    """Return a new image with the slider edits baked in, or the input untouched
    when everything is neutral (the common case - avoids a needless numpy pass)."""
    if not _has_edits(adj):
        return image
    long_edge = max(image.size)
    # Denoise first (spatial): a light Gaussian blur scaled to the image size so
    # preview and full render soften by a comparable amount.
    dn = adj.get("denoise", 0)
    if dn > 0:
        radius = dn / 100.0 * (long_edge / 600.0)
        if radius > 0.1:
            image = image.filter(ImageFilter.GaussianBlur(radius))
    rgb = image.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    # Detail (spatial), before the tonal pass: clarity = large-radius local
    # contrast, sharpness = small-radius edge enhancement.
    cl = adj.get("clarity", 0)
    if cl:
        arr = _clarity(arr, max(3.0, long_edge / 60.0), cl / 100.0 * 0.9)
    sp = adj.get("sharpness", 0)
    if sp:
        # +sharpen / -soften share the unsharp formula (negative amount blends
        # toward the blur).
        arr = _unsharp(arr, max(0.6, long_edge / 1500.0), sp / 100.0 * 1.2)
    arr = _adjust_array(arr, adj)
    if adj.get("vignette", 0):
        arr = _apply_vignette(arr, adj["vignette"])
    if adj.get("grain", 0) > 0:
        arr = _apply_grain(arr, adj["grain"], adj.get("grain_size", 0))
    out = (arr * 255.0 + 0.5).astype(np.uint8)
    return PILImage.fromarray(out, "RGB")


def generate_derivatives(
    image_id: str,
    source_path: Path,
    rotation: int = 0,
    crop: CropBox | None = None,
    adjustments: dict | None = None,
    distortion: int = 0,
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
    if distortion:
        source = apply_distortion(source, distortion)
    source = apply_edits(source, rotation, crop)
    if adjustments:
        source = apply_adjustments(source, adjustments)

    preview = source.copy()
    preview.thumbnail((PREVIEW_MAX_PX, PREVIEW_MAX_PX))
    _save_atomic(preview, out_dir / "preview.jpg", quality=90)

    thumb = source.copy()
    thumb.thumbnail((THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX))
    _save_atomic(thumb, out_dir / "thumbnail.jpg", quality=85)

    # The full-resolution derivative (for 100% zoom) is now stale - drop it so it
    # is regenerated on next request with the new edits.
    (out_dir / "full.jpg").unlink(missing_ok=True)


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
    image: "Image", rotation: int, crop: CropBox | None, adjustments: dict, distortion: int = 0
) -> PILImage.Image:
    """Full-resolution RGB render with the given lens/geometry and tonal edits
    baked in. Used to write a flattened edited *copy* into the library."""
    from app.services.filesystem import resolve_image_path

    source = extract_full_preview(resolve_image_path(image))
    if distortion:
        source = apply_distortion(source, distortion)
    source = apply_edits(source, rotation, crop)
    source = apply_adjustments(source, adjustments)
    return source.convert("RGB")


def generate_full(image: "Image") -> Path:
    """Render + cache the full-resolution edited JPEG (for true 100% zoom in the
    lightbox), returning its path. Cheap to serve once cached; cleared whenever
    the edit changes (see generate_derivatives)."""
    out = derivative_dir(image.id) / "full.jpg"
    crop = None
    if image.edit_crop_x is not None:
        crop = (image.edit_crop_x, image.edit_crop_y, image.edit_crop_width, image.edit_crop_height)
    rendered = render_edited_image(
        image,
        image.edit_rotation,
        crop,
        adjustments_from_image(image),
        distortion=getattr(image, "edit_distortion", 0) or 0,
    )
    _save_atomic(rendered, out, quality=90)
    return out


def adjustments_from_image(image: "Image") -> dict:
    """The full tonal/color edit dict (sliders + colour mixer + vignette) read off
    an Image row, ready for apply_adjustments / generate_derivatives."""
    adj = {name: getattr(image, f"edit_{name}", 0) or 0 for name in ADJUSTMENT_FIELDS}
    adj["vignette"] = getattr(image, "edit_vignette", 0) or 0
    adj["grain"] = getattr(image, "edit_grain", 0) or 0
    adj["grain_size"] = getattr(image, "edit_grain_size", 0) or 0
    adj["denoise"] = getattr(image, "edit_denoise", 0) or 0
    adj["clarity"] = getattr(image, "edit_clarity", 0) or 0
    adj["sharpness"] = getattr(image, "edit_sharpness", 0) or 0
    adj["color_tint"] = getattr(image, "edit_color_tint", 0) or 0
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
        distortion=getattr(image, "edit_distortion", 0) or 0,
    )
