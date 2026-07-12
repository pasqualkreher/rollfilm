import io
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np
from PIL import Image as PILImage, ImageFilter

from app.config import settings
from app.services.raw import extract_full_preview

if TYPE_CHECKING:
    from app.db.models import Image

# Grid thumbnails are generated at a quarter of the original's dimensions, which
# is far cheaper than a large fixed size (keeping a full-library rebuild fast)
# while staying crisp enough for the square grid tiles. THUMBNAIL_MAX_PX is just
# an upper cap so very large originals don't still yield oversized thumbnails.
THUMBNAIL_SCALE = 0.25
THUMBNAIL_MAX_PX = 1600
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
    sat0 = sat  # original saturation, before the mixer's own sat shift below
    sat = np.clip(sat * (1.0 + sat_adj / 100.0), 0.0, 1.0)
    rgb = _hsl_to_rgb(hue, sat, lum)
    # Luminance as a brightness scale (preserves the band's colour). Moving HSL
    # lightness instead washes each band toward white/black - which looked broken.
    # Gated by a *ramp* on the pixel's original saturation: true neutrals (grey,
    # shadows) stay put so they aren't brightened just because their near-arbitrary
    # hue lands in a band, but anything meaningfully coloured (sat >= ~0.5) gets the
    # full, clearly-visible response. The old `0.5 * sat0` weighting scaled the
    # effect straight down by saturation, so on ordinary (partly-saturated) photos
    # the Luminance slider did almost nothing - it read as broken.
    sat_weight = np.clip((sat0 - 0.08) * 2.2, 0.0, 1.0)
    factor = (1.0 + lum_adj / 100.0 * 0.9 * sat_weight)[..., None]
    return np.clip(rgb * factor, 0.0, 1.0)


def _box_min(dark: np.ndarray, radius: int) -> np.ndarray:
    """Separable (square-patch) minimum filter - the erosion step of the dark
    channel prior. Runs on the small (quarter-scale) dark channel, so a simple
    shift-and-minimum loop is plenty fast."""
    out = dark
    for axis in (0, 1):
        m = out.copy()
        for k in range(1, radius + 1):
            if axis == 0:
                up = np.pad(out, ((k, 0), (0, 0)), mode="edge")[: out.shape[0], :]
                down = np.pad(out, ((0, k), (0, 0)), mode="edge")[k:, :]
            else:
                up = np.pad(out, ((0, 0), (k, 0)), mode="edge")[:, : out.shape[1]]
                down = np.pad(out, ((0, 0), (0, k)), mode="edge")[:, k:]
            np.minimum(m, up, out=m)
            np.minimum(m, down, out=m)
        out = m
    return out


def _dehaze(arr: np.ndarray, amount: int) -> np.ndarray:
    """Real dehaze (replaces the old per-pixel veil-subtract hack).

    Positive: dark-channel-prior haze removal - estimate the atmospheric light
    A from a high per-channel percentile, build a transmission map from the
    patch-eroded dark channel of I/A (computed at quarter scale, then smoothed
    and upsampled), and recover the scene radiance J = (I - A)/t + A. Haze-free
    regions have a near-zero dark channel, so they pass through untouched;
    genuinely hazy areas get their contrast and colour back instead of just
    being darkened.

    Negative: physically *add* a neutral veil (mix toward a bright atmospheric
    colour) for a soft, hazy look.

    The JS live preview mirrors this (canvas blur standing in for the Gaussian),
    approximate at preview scale like clarity/sharpness."""
    dh = amount / 100.0
    if dh < 0:
        t = 1.0 + 0.45 * dh  # dh in [-1,0) -> t in [0.55,1)
        return np.clip(arr * t + 0.93 * (1.0 - t), 0.0, 1.0)

    h, w = arr.shape[:2]
    # Atmospheric light per channel: robust high percentile, floored so the
    # normalisation below can't blow up on dark images.
    A = np.clip(np.percentile(arr.reshape(-1, 3), 99.5, axis=0), 0.5, 1.0).astype(np.float32)

    # Dark channel of I/A at quarter scale (block-min), then patch erosion.
    dark_full = (arr / A).min(axis=2)
    ph = (-dark_full.shape[0]) % 4
    pw = (-dark_full.shape[1]) % 4
    dpad = np.pad(dark_full, ((0, ph), (0, pw)), mode="edge")
    dsmall = dpad.reshape(dpad.shape[0] // 4, 4, dpad.shape[1] // 4, 4).min(axis=(1, 3))
    radius = max(2, round(max(dsmall.shape) / 50))
    dsmall = _box_min(np.clip(dsmall, 0.0, 1.0), radius)

    # Refine the transmission with a guided filter (guide = the image itself):
    # edge-aware, so the haze estimate follows real object boundaries instead
    # of the blocky quarter-scale grid - the classic He et al. refinement that
    # kills both block artifacts and edge halos.
    coarse = cv2.resize(dsmall.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    gray = (arr @ _LUMA).astype(np.float32)
    dark = cv2.ximgproc.guidedFilter(gray, coarse, int(max(8, max(h, w) / 40)), 1e-3)
    dark = np.clip(dark, 0.0, 1.0)

    # Floor t at 0.4 (max ~2.5x amplification): lower floors turn fine detail
    # near the atmospheric colour into blown white blobs.
    t = np.clip(1.0 - (0.85 * dh) * dark, 0.4, 1.0)[..., None]
    j = (arr - A) / t + A
    # Highlight protection: bright clouds/sky sit at (or above) the atmospheric
    # light itself, where the 1/t recovery amplifies tiny variations into hard
    # clipped-white artifacts - fade the effect out toward the highlights. Haze
    # lives in the mids/shadows, so this barely costs any actual dehazing.
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    keep = 1.0 - np.clip((luma - 0.75) / 0.2, 0.0, 1.0) * 0.85
    return np.clip(arr + (j - arr) * keep[..., None], 0.0, 1.0)


def _denoise_image(image: PILImage.Image, amount: int) -> PILImage.Image:
    """Camera-style NR, split by channel in YCrCb. The ugly part of high-ISO
    noise is the low-frequency colour blotching (rainbow mottling), whose blobs
    are far larger than non-local means' 7px patch / 21px search window - no
    NLM strength can reach them, it only desaturates edges while luma turns to
    plastic. So: luma gets *gentle* NLM (quadratic ramp - low slider values
    stay subtle), and chroma gets a large-radius guided filter driven by the
    cleaned luma, which flattens the blotches while colour still snaps to real
    luminance edges. The eye barely resolves chroma detail, so the chroma pass
    can be aggressive without the result looking soft."""
    f = min(100, max(0, amount)) / 100.0
    if f <= 0:
        return image
    ycc = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2YCrCb)
    y = ycc[..., 0]
    h_luma = 7.0 * f * f
    if h_luma >= 0.5:
        y = cv2.fastNlMeansDenoising(y, None, h_luma, 7, 21)
    hh, ww = ycc.shape[:2]
    # Chroma at quarter scale: the downscale averages the fine confetti away
    # and shrinks the blotches into NLM's patch/search window, so they get
    # removed as a *pattern* instead of merely averaged down. The eye barely
    # resolves chroma anyway (JPEG ships 4:2:0 for the same reason).
    sw, sh = max(1, ww // 4), max(1, hh // 4)
    guide = y.astype(np.float32) / 255.0
    w = min(1.0, f * 1.5)
    out = np.empty_like(ycc)
    out[..., 0] = y
    for c in (1, 2):
        small = cv2.resize(ycc[..., c], (sw, sh), interpolation=cv2.INTER_AREA)
        small = cv2.fastNlMeansDenoising(small, None, 3.0 + f * 12.0, 7, 21)
        # NLM handles the per-pixel/mid-frequency part; the widest mottling is
        # still below its patch scale even at quarter size, so finish with a
        # Gaussian - the guided upsample below restores the colour edges.
        small = cv2.GaussianBlur(small, (0, 0), 0.5 + f * 5.0)
        up = cv2.resize(small, (ww, hh), interpolation=cv2.INTER_LINEAR)
        # Joint upsampling: a small guided filter against full-res luma snaps
        # the smoothed colour back onto real edges.
        smooth = cv2.ximgproc.guidedFilter(guide, up.astype(np.float32) / 255.0, 8, 2e-3)
        ch = ycc[..., c].astype(np.float32) / 255.0
        ch = ch + (smooth - ch) * w
        out[..., c] = np.clip(ch * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    return PILImage.fromarray(cv2.cvtColor(out, cv2.COLOR_YCrCb2RGB), "RGB")


def _apply_chrome(arr: np.ndarray, chrome: int, chrome_blue: int) -> np.ndarray:
    """Fujifilm-style Color Chrome Effect: deepen (darken) highly saturated
    colours so they gain gradation instead of blocking up - the in-camera
    effect that gives Velvia reds and Classic Chrome tones their depth.
    `chrome` applies to all hues weighted by saturation^1.5; `chrome_blue`
    (Color Chrome FX Blue) does the same for a soft window around blue,
    deepening skies. Darkening in RGB keeps channel ratios, so perceived
    saturation rises as the tone deepens - like the real effect."""
    if not chrome and not chrome_blue:
        return arr
    hue, sat, lum = _rgb_to_hsl(arr)
    # Weight by *chroma* (max-min), not HSL saturation: HSL sat blows up to ~1
    # for near-white/near-black pixels with tiny channel differences (the
    # cylinder normalisation divides by the vanishing lightness span), which
    # darkened random bright cloud pixels into blotchy artifacts. Chroma fades
    # to zero at both tonal extremes by construction, so only genuinely
    # colourful pixels deepen - like the in-camera effect.
    chroma_w = np.minimum(1.0, sat * (1.0 - np.abs(2.0 * lum - 1.0)) * 1.4)
    factor = np.ones_like(sat)
    if chrome:
        factor *= 1.0 - 0.32 * (chrome / 100.0) * np.power(chroma_w, 1.5)
    if chrome_blue:
        ang = np.abs(hue - 250.0)
        ang = np.minimum(ang, 360.0 - ang)
        window = np.where(ang < 90.0, 0.5 + 0.5 * np.cos(np.pi * ang / 90.0), 0.0)
        factor *= 1.0 - 0.35 * (chrome_blue / 100.0) * chroma_w * window
    return np.clip(arr * factor[..., None], 0.0, 1.0)


def _mist(arr: np.ndarray, amount: int) -> np.ndarray:
    """Pro-Mist-style diffusion filter: screen-blend a large-radius blur of the
    image, weighted toward its highlights, over the sharp original - bright
    areas bloom and halate softly into their surroundings while shadows and
    midtone detail stay intact. Runs on the *toned* image (after the tonal
    pass), like a filter in front of the lens capturing the final look."""
    f = min(100, max(0, amount)) / 100.0
    if f <= 0:
        return arr
    long_edge = max(arr.shape[:2])
    radius = max(8.0, long_edge / 25.0)
    pil = PILImage.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    blur = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    luma_b = np.clip(blur @ _LUMA, 0.0, 1.0)
    glow = np.clip(blur * (np.power(luma_b, 1.2) * 0.85 * f)[..., None], 0.0, 1.0)
    return 1.0 - (1.0 - arr) * (1.0 - glow)


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
        arr = arr * (2.0 ** (2.0 * e))  # +/- two stops at the extremes (a useful range)
    if t:
        arr[..., 0] *= 1.0 + 0.3 * t  # warm: more red
        arr[..., 2] *= 1.0 - 0.3 * t  # ...less blue
    if n:
        arr[..., 1] *= 1.0 - 0.3 * n  # +tint = magenta (less green)
    np.clip(arr, 0.0, 1.0, out=arr)

    # Fuji-style tone masks: shadows lift fades to zero at pure black (keeps the
    # film "toe" dense instead of washing blacks grey) and highlights fade to
    # zero at pure white (whites stay anchored; the Whites slider owns the very
    # top end). Both peak in the lower/upper mids like Fuji's Shadow/Highlight
    # Tone rather than piling up at the extremes.
    if hi or sh:
        luma = arr @ _LUMA
        if sh:
            arr += (sh * 0.7 * (1.0 - luma) ** 2 * np.power(luma, 0.4))[..., None]
        if hi:
            arr += (hi * 0.6 * luma**2 * np.power(1.0 - luma, 0.4))[..., None]
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

    # Contrast as a filmic S-curve (blend toward/away from smoothstep) instead of
    # the old linear stretch around 0.5: the linear version clipped highlights
    # and blacks harshly, while the sigmoid rolls both ends off softly - the
    # "shoulder" that gives in-camera film renderings their character. The 1.6
    # gain keeps the midtone slope comparable to the old response.
    if c:
        cs = min(1.0, max(-1.0, 1.6 * c))
        arr = arr + cs * (arr * arr * (3.0 - 2.0 * arr) - arr)
        np.clip(arr, 0.0, 1.0, out=arr)

    mix = adj.get("color_mix")
    tint = adj.get("color_tint", 0)
    if mix or tint:
        arr = _apply_color_mix(np.clip(arr, 0.0, 1.0), mix or {}, tint)
    arr = _apply_chrome(arr, adj.get("chrome_effect", 0), adj.get("chrome_blue", 0))
    if s:
        luma = (arr @ _LUMA)[..., None]
        arr = luma + (arr - luma) * (1.0 + s)

    return np.clip(arr, 0.0, 1.0)


def _grain_noise(*shape: int) -> np.ndarray:
    """Sum of 3 uniforms, centred and scaled to roughly [-1, 1] with a
    bell-shaped (Irwin-Hall) distribution - much closer to how photographic
    grain amplitude is actually distributed than flat np.random.rand noise."""
    u = np.random.rand(*shape) + np.random.rand(*shape) + np.random.rand(*shape)
    return ((u - 1.5) / 1.5).astype(np.float32)


def _grain_field(h: int, w: int, particle_px: float) -> np.ndarray:
    """A film-grain noise field with a given particle size in pixels: noise is
    generated at particle resolution, nearest-upscaled (hard speckle edges),
    then lightly blurred so particles read as soft irregular blobs rather than
    square pixels. Roughly [-1, 1]."""
    nh = min(h, max(1, int(round(h / particle_px))))
    nw = min(w, max(1, int(round(w / particle_px))))
    small = _grain_noise(nh, nw)
    pil = PILImage.fromarray(np.clip(small * 90.0 + 128.0, 0, 255).astype(np.uint8), "L")
    field = pil.resize((w, h), PILImage.NEAREST)
    field = field.filter(ImageFilter.GaussianBlur(max(0.35, particle_px * 0.4)))
    return (np.asarray(field, dtype=np.float32) - 128.0) / 90.0


def _apply_grain(arr: np.ndarray, amount: int, size: int = 0) -> np.ndarray:
    """Fuji-style analog film grain.

    Two layers: a fine base texture plus a coarser "clump" layer approximating
    silver-halide clusters, blended toward the clumps as `size` grows. Both
    particle sizes scale with the image's resolution (long edge), so grain
    looks the *same* on the 2048px preview and the full-resolution save - the
    old version generated 1px noise regardless of resolution, so full-size
    renders came out with much finer (near-invisible) grain than the preview,
    and per-pixel white noise reads as digital sensor noise, not film.

    Intensity follows a midtone bell like real film: strongest in the mids,
    fading into deep shadows (film's thin toe) and highlights (dense areas of
    the negative). Monochromatic (same offset on R/G/B), like silver grain.
    Stochastic - the preview shows a different pattern than the saved render."""
    h, w = arr.shape[:2]
    size_f = size / 100.0
    long_edge = max(h, w)

    # Particle sizes relative to resolution. The size slider's low end is
    # near-pixel salt (crisp fine-ISO texture), growing to chunky pushed-film
    # clumps at the top.
    p_fine = max(0.7, (long_edge / 1500.0) * (0.35 + 1.25 * size_f))
    p_clump = p_fine * (2.2 + size_f * 2.8)

    fine = _grain_field(h, w, p_fine)
    clump = _grain_field(h, w, p_clump)

    # Barely any clump layer at the fine end - its blobs read as "big grain"
    # even when the fine layer is tiny.
    fine_weight = 1.0 - 0.45 * size_f
    clump_weight = 0.15 + 0.6 * size_f
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    midtone = np.power(4.0 * luma * (1.0 - luma), 0.75)
    combined = (fine * fine_weight + clump * clump_weight) * midtone
    noise = combined * (amount / 100.0) * 0.14
    return np.clip(arr + noise[..., None], 0.0, 1.0)


def _unsharp(arr: np.ndarray, radius: float, amount: float) -> np.ndarray:
    """Unsharp mask: out = in + amount*(in - blur(in)). Positive amount sharpens,
    negative softens. Small radius = sharpness."""
    pil = PILImage.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    blur = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    return np.clip(arr + amount * (arr - blur), 0.0, 1.0)


def _clarity(arr: np.ndarray, radius: float, amount: float) -> np.ndarray:
    """Fujifilm-style clarity: large-radius local contrast weighted toward the
    midtones (so highlights/shadows aren't crushed). The structural base comes
    from an edge-preserving *guided filter* rather than a Gaussian blur - a
    Gaussian bleeds across strong edges, which turned into bright/dark halos
    around subjects at higher amounts; the guided filter stops at edges, so
    only genuine local texture gets amplified. The midtone mask is a raised
    tent (^1.5) easing out toward the tonal extremes. Positive = punchier
    mids, negative = softer."""
    src = np.clip(arr, 0.0, 1.0).astype(np.float32)
    base = cv2.ximgproc.guidedFilter(src, src, int(max(4, radius)), 0.01)
    luma = arr @ _LUMA
    mask = np.power(1.0 - np.abs(2.0 * luma - 1.0), 1.5)[..., None]  # peaks at midtones
    return np.clip(arr + amount * (src - base) * mask, 0.0, 1.0)


def _has_edits(adj: dict) -> bool:
    if any(adj.get(k, 0) for k in ADJUSTMENT_FIELDS):
        return True
    for k in ("vignette", "grain", "denoise", "clarity", "sharpness", "color_tint", "chrome_effect", "chrome_blue", "mist"):
        if adj.get(k, 0):
            return True
    mix = adj.get("color_mix") or {}
    return any(any(v) for v in mix.values())


def _grain_pil(image: PILImage.Image, adj: dict) -> PILImage.Image:
    """Apply the film-grain pass to a PIL image at its *current* resolution."""
    g = adj.get("grain", 0)
    if g <= 0:
        return image
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    arr = _apply_grain(arr, g, adj.get("grain_size", 0))
    return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8), "RGB")


def apply_adjustments(image: PILImage.Image, adj: dict, include_grain: bool = True) -> PILImage.Image:
    """Return a new image with the slider edits baked in, or the input untouched
    when everything is neutral (the common case - avoids a needless numpy pass).

    `include_grain=False` skips the grain pass so the caller can add grain
    *after* downscaling to the output size (see generate_derivatives): grain
    baked at full resolution gets averaged away by the LANCZOS downscale to the
    preview/thumbnail, so what you saw in the editor vanished after saving."""
    if not _has_edits(adj):
        return image
    long_edge = max(image.size)
    # Denoise first (spatial): chroma smoothing + gentle luma median in YCbCr.
    dn = adj.get("denoise", 0)
    if dn > 0:
        image = _denoise_image(image.convert("RGB"), dn)
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
        # toward the blur). Radius is capped: Fuji-style sharpening is a fine,
        # tight edge enhancement - an uncapped radius grew to ~4px on full-res
        # renders, which produced visible halos.
        arr = _unsharp(arr, min(2.0, max(0.6, long_edge / 2000.0)), sp / 100.0 * 1.2)
    # Dehaze is spatial too (transmission map from the dark channel), so it runs
    # here rather than in the per-pixel tonal pass.
    dh = adj.get("dehaze", 0)
    if dh:
        arr = _dehaze(arr, dh)
    arr = _adjust_array(arr, adj)
    # Mist blooms the *toned* image, so it runs after the tonal pass.
    if adj.get("mist", 0) > 0:
        arr = _mist(arr, adj["mist"])
    if adj.get("vignette", 0):
        arr = _apply_vignette(arr, adj["vignette"])
    if include_grain and adj.get("grain", 0) > 0:
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
        # Grain is added per-derivative below, *after* the downscale - baked at
        # full res it would just be averaged away by the resize.
        source = apply_adjustments(source, adjustments, include_grain=False)

    # The lightbox preview keeps the *original* resolution - only the grid
    # thumbnail is ever downscaled, so nowhere outside the grid does the user
    # look at fewer pixels than the photo really has.
    preview = source.copy()
    if adjustments:
        preview = _grain_pil(preview, adjustments)
    _save_atomic(preview, out_dir / "preview.jpg", quality=90)

    thumb = source.copy()
    # Grid thumbnail at a quarter of the original's dimensions (a lot cheaper to
    # generate than a large fixed size, so a full-library rebuild stays quick),
    # capped so huge originals don't still produce oversized thumbnails.
    tw = min(THUMBNAIL_MAX_PX, max(1, round(thumb.width * THUMBNAIL_SCALE)))
    th = min(THUMBNAIL_MAX_PX, max(1, round(thumb.height * THUMBNAIL_SCALE)))
    thumb.thumbnail((tw, th), PILImage.LANCZOS)
    if adjustments:
        thumb = _grain_pil(thumb, adjustments)
    _save_atomic(thumb, out_dir / "thumbnail.jpg", quality=88)

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


# Working resolution for the interactive editor preview: enough for a sharp
# on-screen image, small enough that a full pipeline pass stays interactive.
EDITOR_PREVIEW_PX = 1600


@lru_cache(maxsize=4)
def _cached_editor_base(image_id: str, path_str: str, mtime_ns: int, max_px: int) -> PILImage.Image:
    """The decoded, downscaled base image the editor preview renders on top of.
    Cached so slider moves only re-run the edit pipeline, not the (expensive)
    RAW decode. Keyed by file mtime so an on-disk change invalidates. Treat the
    returned image as immutable - every pipeline step copies."""
    src = extract_full_preview(Path(path_str))
    src.thumbnail((max_px, max_px), PILImage.LANCZOS)
    return src.convert("RGB")


@lru_cache(maxsize=1)
def _cached_editor_base_full(image_id: str, path_str: str, mtime_ns: int) -> PILImage.Image:
    """Full-resolution editor base, for the settled (non-interactive) preview
    refinement. Separate from _cached_editor_base with maxsize=1: a full-res
    decode is ~100MB, so keeping several around would bloat the process just
    from browsing between photos in the editor."""
    return extract_full_preview(Path(path_str)).convert("RGB")


def render_editor_preview_bytes(
    image: "Image",
    rotation: int,
    crop: CropBox | None,
    adjustments: dict,
    distortion: int = 0,
    max_px: int = EDITOR_PREVIEW_PX,
    full_quality: bool = False,
) -> bytes:
    """Render the editor's live preview server-side: the exact save pipeline
    (same code path as generate_derivatives/render_edited_image) on a cached,
    preview-sized base. One pipeline = the preview IS the saved look - no
    JS mirror to drift out of sync.

    `full_quality=True` renders on the *full-resolution* base instead - too
    slow for live slider drags, but fetched by the editor once the sliders
    settle, so resolution-dependent passes (denoise radius, sharpen radius,
    grain) are previewed exactly as they will be saved."""
    from app.services.filesystem import resolve_image_path

    path = resolve_image_path(image)
    if full_quality:
        img = _cached_editor_base_full(image.id, str(path), path.stat().st_mtime_ns)
    else:
        img = _cached_editor_base(image.id, str(path), path.stat().st_mtime_ns, max_px)
    if distortion:
        img = apply_distortion(img, distortion)
    img = apply_edits(img, rotation, crop)
    img = apply_adjustments(img, adjustments)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=88)
    return buf.getvalue()


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
    adj["chrome_effect"] = getattr(image, "edit_chrome_effect", 0) or 0
    adj["chrome_blue"] = getattr(image, "edit_chrome_blue", 0) or 0
    adj["mist"] = getattr(image, "edit_mist", 0) or 0
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
