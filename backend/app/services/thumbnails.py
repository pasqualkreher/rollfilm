import io
import json
import math
import os
import threading
import uuid
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image as PILImage, ImageFilter, ImageOps

from app.config import settings
from app.services import develop, develop_color, develop_effects, masks
from app.services.raw import extract_full_preview


# OpenCV (cv2) is a large native package that is slow to import - and pathologically
# slow if the virtualenv sits on throttled/cloud-synced storage. It's only needed
# for the image-processing paths (dehaze/denoise/clarity), which always run on a
# background worker, never during API startup. Load it lazily on first use so the
# backend can serve /health immediately. All existing `cv2.<fn>` call sites keep
# working unchanged through this proxy.
class _LazyCV2:
    _mod = None

    def __getattr__(self, name):
        if _LazyCV2._mod is None:
            import cv2 as _cv2

            _LazyCV2._mod = _cv2
        return getattr(_LazyCV2._mod, name)


cv2 = _LazyCV2()

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

# The develop adjustments schema (keys, ranges, defaults) and JSON
# (de)serialisation live in services/develop.py; the extra effect maths
# (structure, glow, halation, flare, chromatic aberration, 4-parameter vignette,
# AgX tone mapping) live in services/develop_effects.py. This module wires them
# into the render pipeline. Everything runs server-side, so the editor preview
# is pixel-identical to the saved render.

# Rec. 709 luma weights, used for the highlight/shadow masks and saturation.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _srgb_to_linear(arr: np.ndarray) -> np.ndarray:
    """Decode sRGB-encoded values (0..1) to linear light. Light-transport edits
    (exposure, white balance) are physically a multiply in *linear* light -
    doing them on the gamma-encoded values instead shifts midtone brightness and
    hue, which is the muddiness/colour-cast the old naive-sRGB path had."""
    a = np.clip(arr, 0.0, 1.0)
    return np.where(a <= 0.04045, a / 12.92, np.power((a + 0.055) / 1.055, 2.4))


def _linear_to_srgb(arr: np.ndarray) -> np.ndarray:
    """Re-encode linear light back to sRGB (inverse of _srgb_to_linear)."""
    a = np.clip(arr, 0.0, 1.0)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1.0 / 2.4) - 0.055)


def derivative_dir(image_id: str) -> Path:
    path = settings.thumbnail_cache_root / image_id
    path.mkdir(parents=True, exist_ok=True)
    return path


# One generation at a time per image: right after an import, the grid's
# thumbnail requests race the post-import worker to generate the same
# derivatives - without this, every request thread ran its own full (RAW)
# decode of the same photo, multiplying the post-import CPU load for nothing.
# RLock so ensure_derivatives can call generate_derivatives under its own lock.
_gen_locks: dict[str, threading.RLock] = {}
_gen_locks_guard = threading.Lock()


def _gen_lock(image_id: str) -> threading.RLock:
    with _gen_locks_guard:
        lock = _gen_locks.get(image_id)
        if lock is None:
            lock = _gen_locks[image_id] = threading.RLock()
        return lock


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


def _max_inscribed_rect(w: float, h: float, angle_rad: float) -> tuple[float, float]:
    """Largest centred rectangle *of the same aspect ratio as w×h* that fits inside
    a w×h rectangle rotated by angle_rad. Straightening auto-crops to this, so the
    empty corners vanish WITHOUT changing the image's aspect ratio / format - it
    just zooms in a touch. (A max-*area* inscribed rect would change the aspect
    ratio, so the crop/format jumped every time you levelled the horizon.)

    A centred W×H rect (W/H = w/h) rotated back by the angle has an axis-aligned
    extent of (W·c + H·s) × (W·s + H·c); it fits inside w×h when both are within
    w and h, which gives H = min(w/(a·c+s), h/(a·s+c)) with a = W/H."""
    if w <= 0 or h <= 0:
        return 0.0, 0.0
    c = abs(math.cos(angle_rad))
    s = abs(math.sin(angle_rad))
    a = w / h  # target aspect (the image's own)
    hr = min(w / (a * c + s), h / (a * s + c))
    return a * hr, hr


def _perspective_coeffs(dest: list[tuple[float, float]], source: list[tuple[float, float]]) -> list[float]:
    """8 coefficients mapping each output point in `dest` back to its sample
    point in `source`, for PILImage.PERSPECTIVE."""
    matrix = []
    for (x, y), (u, v) in zip(dest, source):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    a = np.array(matrix, dtype=float)
    b = np.array(source, dtype=float).reshape(8)
    return np.linalg.solve(a, b).tolist()


# Max edge shift at slider 100, as a fraction of the image size. The tilt is
# symmetric about the centre, so each edge moves by half this either way.
_PERSP_MAX = 0.30


def _largest_centred_rect(coeffs: list[float], w: int, h: int) -> tuple[int, int]:
    """Largest centred crop (same aspect as the frame) whose every pixel still
    samples from inside the source image, so the auto-crop leaves no empty
    corners. `coeffs` map an output (x, y) back to its source (u, v):
        u = (c0 x + c1 y + c2) / (c6 x + c7 y + 1)
    That map is linear-fractional with a fixed-sign denominator here, hence
    quasilinear, so its extrema over a rectangle fall on the corners - checking
    the four corners is exact."""
    c0, c1, c2, c3, c4, c5, c6, c7 = coeffs
    cx, cy = w / 2.0, h / 2.0

    def inside(k: float) -> bool:
        hw, hh = k * w / 2.0, k * h / 2.0
        for x, y in ((cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)):
            den = c6 * x + c7 * y + 1.0
            if den == 0.0:
                return False
            u = (c0 * x + c1 * y + c2) / den
            v = (c3 * x + c4 * y + c5) / den
            if u < 0.0 or u > w or v < 0.0 or v > h:
                return False
        return True

    if inside(1.0):
        return w, h
    lo, hi = 0.0, 1.0
    for _ in range(24):
        mid = (lo + hi) / 2.0
        if inside(mid):
            lo = mid
        else:
            hi = mid
    return max(1, round(lo * w)), max(1, round(lo * h))


def apply_perspective(image: PILImage.Image, persp_h: int, persp_v: int) -> PILImage.Image:
    """Keystone / axis tilt: apply a perspective that converges symmetrically
    about the image centre (so the frame tilts naturally instead of stretching
    one edge out to a wedge), then auto-crop to the largest centred rectangle
    that stays inside the frame - the same trick `straighten` uses to hide the
    empty corners. persp_v tilts about the horizontal axis (top/bottom), persp_h
    about the vertical axis (left/right); each -100..100."""
    if not persp_h and not persp_v:
        return image
    w, h = image.size
    # Half-shift each edge in opposite directions about the centre: one edge
    # insets, the opposite edge outsets by the same amount (that side samples
    # from outside the frame, which the auto-crop below removes).
    dx = (persp_v / 100.0) * _PERSP_MAX * w / 2.0
    dy = (persp_h / 100.0) * _PERSP_MAX * h / 2.0
    source = [
        (dx, dy),  # top-left
        (w - dx, -dy),  # top-right
        (w + dx, h + dy),  # bottom-right
        (-dx, h - dy),  # bottom-left
    ]
    dest = [(0, 0), (w, 0), (w, h), (0, h)]
    coeffs = _perspective_coeffs(dest, source)
    warped = image.transform((w, h), PILImage.PERSPECTIVE, coeffs, resample=PILImage.BICUBIC)
    cw, ch = _largest_centred_rect(coeffs, w, h)
    if cw >= w and ch >= h:
        return warped
    left = (w - cw) // 2
    top = (h - ch) // 2
    return warped.crop((left, top, left + cw, top + ch))


def apply_edits(
    image: PILImage.Image,
    rotation: int,
    crop: CropBox | None,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
) -> PILImage.Image:
    """Geometry, in the order the editor shows it: mirror, quarter-turn, fine
    straighten (auto-cropped to lose the empty corners), keystone/axis tilt, then
    the manual crop. rotation is clockwise degrees (0/90/180/270); straighten is
    clockwise degrees; crop is (x, y, width, height) as fractions of the frame."""
    if flip_h:
        image = ImageOps.mirror(image)
    if flip_v:
        image = ImageOps.flip(image)
    if rotation:
        image = image.rotate(-rotation, expand=True)
    if straighten:
        w0, h0 = image.size
        image = image.rotate(-straighten, expand=True, resample=PILImage.BICUBIC)
        wr, hr = _max_inscribed_rect(w0, h0, math.radians(straighten))
        ew, eh = image.size
        cw = max(1, min(ew, round(wr)))
        ch = max(1, min(eh, round(hr)))
        left = (ew - cw) // 2
        top = (eh - ch) // 2
        image = image.crop((left, top, left + cw, top + ch))
    if persp_h or persp_v:
        image = apply_perspective(image, persp_h, persp_v)
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


def _apply_color_mix(arr: np.ndarray, mix: dict, hue_deg: float = 0.0) -> np.ndarray:
    """Shift hue / saturation / luminance of each colour band. `mix` maps a band
    name to [hue, sat, lum], each -100..100. `hue_deg` rotates *all* hues by a
    number of degrees (-180..180) to shift the whole palette."""
    bands = {b: list(mix.get(b, [0, 0, 0])) for b in COLOR_BANDS}
    if not hue_deg and not any(any(v) for v in bands.values()):
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
    hue = (hue + hue_shift * 1.8 + hue_deg) % 360.0
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


def _denoise_image(image: PILImage.Image, luma_amt: int, color_amt: int) -> PILImage.Image:
    """Camera-style NR, split by channel in YCrCb. The ugly part of high-ISO
    noise is the low-frequency colour blotching (rainbow mottling), whose blobs
    are far larger than non-local means' 7px patch / 21px search window - no
    NLM strength can reach them, it only desaturates edges while luma turns to
    plastic. So: luma gets *gentle* NLM (quadratic ramp - low slider values
    stay subtle), and chroma gets a large-radius guided filter driven by the
    cleaned luma, which flattens the blotches while colour still snaps to real
    luminance edges. The eye barely resolves chroma detail, so the chroma pass
    can be aggressive without the result looking soft."""
    fl = min(100, max(0, luma_amt)) / 100.0
    fc = min(100, max(0, color_amt)) / 100.0
    if fl <= 0 and fc <= 0:
        return image
    ycc = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2YCrCb)
    y = ycc[..., 0]
    h_luma = 7.0 * fl * fl
    if h_luma >= 0.5:
        y_dn = cv2.fastNlMeansDenoising(y, None, h_luma, 7, 21)
        # NR must not re-tone the image ("denoise changes the contrast"): NLM
        # nudges the low-frequency luma too (clipped shadow noise, plateau
        # averaging), which reads as lifted blacks / flattened contrast at
        # higher amounts. Add back the *original* image's low-frequency luma so
        # denoising only ever removes fine-grained texture, never tonality.
        sigma = max(4.0, min(ycc.shape[:2]) / 200.0)
        tone_shift = cv2.GaussianBlur(y.astype(np.float32), (0, 0), sigma) - cv2.GaussianBlur(
            y_dn.astype(np.float32), (0, 0), sigma
        )
        y = np.clip(y_dn.astype(np.float32) + tone_shift, 0.0, 255.0).astype(np.uint8)
    hh, ww = ycc.shape[:2]
    # Chroma at quarter scale: the downscale averages the fine confetti away
    # and shrinks the blotches into NLM's patch/search window, so they get
    # removed as a *pattern* instead of merely averaged down. The eye barely
    # resolves chroma anyway (JPEG ships 4:2:0 for the same reason).
    sw, sh = max(1, ww // 4), max(1, hh // 4)
    guide = y.astype(np.float32) / 255.0
    w = min(1.0, fc * 1.5)
    out = np.empty_like(ycc)
    out[..., 0] = y
    for c in (1, 2):
        small = cv2.resize(ycc[..., c], (sw, sh), interpolation=cv2.INTER_AREA)
        small = cv2.fastNlMeansDenoising(small, None, 3.0 + fc * 12.0, 7, 21)
        # NLM handles the per-pixel/mid-frequency part; the widest mottling is
        # still below its patch scale even at quarter size, so finish with a
        # Gaussian - the guided upsample below restores the colour edges.
        small = cv2.GaussianBlur(small, (0, 0), 0.5 + fc * 5.0)
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


def _mist(arr: np.ndarray, amount: int, light_sources: bool = True) -> np.ndarray:
    """Pro-Mist-style diffusion / halation, screen-blended over the sharp image.

    `light_sources=True` (the Mist slider): only genuinely bright highlights and
    light sources bloom. A steep brightness mask isolates them, *that masked light*
    is blurred so it halates into its surroundings, and it's screen-blended back.
    Midtones and merely-light areas (skin, pale walls, overcast sky) stay clean, so
    it reads as light blooming out of the frame rather than a flat global haze.

    `light_sources=False` (the negative-clarity diffusion): the softer
    whole-highlight glow - weighted toward the brights but not isolated to point
    sources. Runs on the *toned* image, like a filter in front of the lens."""
    f = min(100, max(0, amount)) / 100.0
    if f <= 0:
        return arr
    long_edge = max(arr.shape[:2])
    radius = max(8.0, long_edge / 22.0)
    if light_sources:
        luma = np.clip(arr @ _LUMA, 0.0, 1.0)
        # Steep ramp from ~0.72 (squared): only real light sources / near-clipping
        # highlights pass; everything dimmer contributes essentially nothing.
        mask = np.clip((luma - 0.72) / 0.28, 0.0, 1.0) ** 2
        if float(mask.max()) <= 0.0:
            return arr
        bright = (arr * mask[..., None]).astype(np.float32)
        pil = PILImage.fromarray((np.clip(bright, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
        glow = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
        glow = np.clip(glow * (1.15 * f), 0.0, 1.0)
        return 1.0 - (1.0 - arr) * (1.0 - glow)
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
    """Apply the tonal/colour adjustments to an HxWx3 float array in 0..1.

    This is the reference pipeline; the server renders it once, so the editor
    preview is identical to the save. Order: exposure + white balance (+ optional
    AgX tone map) in linear light -> highlights/shadows -> whites/blacks ->
    contrast -> colour mixer + global hue -> Fuji chrome -> saturation/vibrance.
    """
    ev = float(adj.get("exposure", 0.0) or 0.0)
    br = adj.get("brightness", 0) / 100.0
    c = adj.get("contrast", 0) / 100.0
    hi = adj.get("highlights", 0) / 100.0
    sh = adj.get("shadows", 0) / 100.0
    wh = adj.get("whites", 0) / 100.0
    bl = adj.get("blacks", 0) / 100.0
    vib = adj.get("vibrance", 0) / 100.0
    s = adj.get("saturation", 0) / 100.0
    t = adj.get("temperature", 0) / 100.0
    n = adj.get("tint", 0) / 100.0
    agx = adj.get("tone_mapper") == "agx"

    # Exposure, white balance and the optional AgX tone map are light-transport
    # operations: do them in linear light (decode sRGB -> operate -> re-encode).
    # Exposure is a true stop multiply (the EV Shift + Exposure sliders sum, each
    # in stops); linear WB shifts colour without the midtone darkening naive-sRGB
    # channel scaling produced. AgX is a filmic tone map with graceful highlight
    # roll-off and desaturation.
    if ev or t or n or agx:
        lin = _srgb_to_linear(arr)
        if ev:
            lin = lin * (2.0 ** ev)
        if t or n:
            # Channel gains: warm = more red / less blue; +tint = magenta (less
            # green). Renormalised by luma so a neutral grey keeps its brightness
            # (white balance shouldn't also change exposure).
            gain = np.array([1.0 + 0.3 * t, 1.0 - 0.3 * n, 1.0 - 0.3 * t], dtype=np.float32)
            gain = gain / float(_LUMA @ gain)
            lin = lin * gain
        if agx:
            lin = develop_effects.agx_tonemap(np.clip(lin, 0.0, None))
        arr = _linear_to_srgb(np.clip(lin, 0.0, 1.0)).astype(np.float32)
    np.clip(arr, 0.0, 1.0, out=arr)

    # Brightness: a midtone lift, distinct from Exposure. Exposure (above) is a
    # linear stop multiply that scales the whole image and drives highlights
    # toward clipping; Brightness adds a bell-weighted lift that peaks in the
    # midtones and tapers to zero at pure black and pure white, so it brightens
    # the mids without clipping highlights or crushing blacks. It's *linear in the
    # slider* - the lift scales straight with `br`, so every tick changes the
    # image by the same amount (the old gamma version was steep in the shadows and
    # felt too strong in the first few ticks). Weighted by luma so all three
    # channels lift together and the hue is preserved.
    if br:
        luma = arr @ _LUMA
        bell = 4.0 * luma * (1.0 - luma)  # 0 at black/white, 1 at midtone
        arr = arr + (br * 0.15 * bell)[..., None]
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

    # Tone curves (point or parametric per curve_mode) and camera-style colour
    # calibration shape tone/primaries after the basic tonal controls.
    arr = develop_color.apply_curves(arr, adj)
    arr = develop_color.apply_color_calibration(arr, adj.get("color_calibration") or {})

    mix = adj.get("hsl")
    hue_deg = adj.get("hue", 0)
    if (mix and any(any(v) for v in mix.values())) or hue_deg:
        arr = _apply_color_mix(np.clip(arr, 0.0, 1.0), mix or {}, hue_deg)
    arr = _apply_chrome(arr, adj.get("chrome_effect", 0), adj.get("chrome_blue", 0))
    # 3-way colour grading (shadows/midtones/highlights/global wheels) on the
    # graded image, after the mixer/chrome.
    arr = develop_color.apply_color_grading(arr, adj.get("color_grading") or {})
    # Saturation is a plain linear chroma scale; Vibrance protects already-vivid
    # colours (and skin tones) by weighting the boost toward muted pixels -
    # RapidRAW keeps the two as separate controls.
    if s:
        luma = (arr @ _LUMA)[..., None]
        arr = luma + (arr - luma) * (1.0 + s)
    if vib:
        luma = (arr @ _LUMA)[..., None]
        # Chroma (distance from the grey axis) estimates how saturated a pixel
        # already is; muted pixels get most of the push.
        chroma = np.abs(arr - luma).max(axis=-1, keepdims=True)
        weight = 1.0 - np.clip(chroma * 1.4, 0.0, 1.0) * 0.6
        arr = luma + (arr - luma) * (1.0 + vib * weight)

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


def _apply_grain(arr: np.ndarray, amount: int, size: int = 0, roughness: int = 50) -> np.ndarray:
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

    # Particle sizes relative to resolution. The smallest Grain Size lands on a
    # crisp ~1px fine-ISO texture (the 1.0px floor, with the size-0 coefficient
    # tuned so even the full-res settle render floors to 1px rather than drifting
    # coarser). Size then grows the particles to chunky pushed-film clumps at the
    # top; the coefficients keep the same maximum (0.55 + 2.95 = 3.5) as before,
    # so only the fine end changes.
    p_fine = max(1.0, (long_edge / 1500.0) * (0.55 + 2.95 * size_f))
    p_clump = p_fine * (2.0 + size_f * 2.6)

    fine = _grain_field(h, w, p_fine)
    clump = _grain_field(h, w, p_clump)

    # Barely any clump layer at the fine end - its blobs read as "big grain"
    # even when the fine layer is tiny.
    fine_weight = 1.0 - 0.45 * size_f
    clump_weight = 0.08 + 0.67 * size_f
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    # Paper-grain tone weighting: present across the WHOLE tonal range - whites and
    # near-blacks included, like the tooth of the paper - only gently stronger in
    # the midtones. The old film-style bell (4*luma*(1-luma)) faded grain to zero in
    # the whites/blacks, so bright areas came out unnaturally clean. In pure white
    # the positive half of the noise clips, so grain there reads as fine darkening
    # speckle - exactly how grain sits on white paper.
    tone_w = 0.6 + 0.4 * np.power(4.0 * luma * (1.0 - luma), 0.5)
    combined = (fine * fine_weight + clump * clump_weight) * tone_w
    # Roughness scales grain amplitude/contrast (RapidRAW's Grain Roughness):
    # smoother and finer at low values, coarse and pronounced near the top.
    rough = min(100, max(0, roughness)) / 100.0
    noise = combined * (amount / 100.0) * 0.18 * (0.6 + 0.85 * rough)
    return np.clip(arr + noise[..., None], 0.0, 1.0)


def _unsharp(arr: np.ndarray, radius: float, amount: float, threshold: float = 0.0) -> np.ndarray:
    """Unsharp mask: out = in + amount*(in - blur(in)). Positive amount sharpens,
    negative softens. Small radius = sharpness. `threshold` (0..80, in 0..255 luma
    units) gates sharpening to real edges: high-pass detail weaker than the
    threshold (sensor noise, film grain, smooth skin) is attenuated so only
    genuine edges get crisper - RapidRAW's sharpening Threshold."""
    pil = PILImage.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    blur = np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0
    hp = arr - blur
    if threshold > 0 and amount > 0:
        thr = threshold / 255.0
        hp = hp * np.clip(np.abs(hp) / thr, 0.0, 1.0)
    return np.clip(arr + amount * hp, 0.0, 1.0)


def _clarity(arr: np.ndarray, radius: float, amount: float) -> np.ndarray:
    """Fujifilm-style clarity (their -5..+5 maps roughly onto Lightroom's
    -50..+50 clarity, i.e. our -100..+100 slider covers the same span).

    Positive: local contrast over a band that reaches from *fine lines* (the
    "bite" on skin, fabric, foliage that Fuji clarity is known for) up to broad
    structure - only per-pixel content (noise, grain) is excluded, so it never
    turns gritty. The band = small-Gaussian smooth minus a large-radius
    guided-filter base: a ~1px blur can't halo, and the guided filter stops at
    strong edges, so no bright/dark halos around subjects either. (Two guided
    filters at different radii don't work here: measured on sine gratings, the
    small-radius one suppresses fine detail *more* than the large-radius one,
    which turned the band negative at fine scales.) A midtone tent mask (^1.5)
    keeps highlights/shadows from crushing, and the added contrast is weighted
    slightly toward darkening - the deepened, punchy character of the
    in-camera rendering rather than an HDR-ish glow.

    Negative: the Fuji negative-clarity *softening* look - reduces the
    local-contrast band and then blends toward an edge-preserving smooth so fine
    detail (wrinkles, pores, skin/fabric texture) goes soft and less visible while
    genuine edges stay sharp. The diffusion glow that completes the look (reviews
    compare it to a Pro-Mist filter) is layered on in apply_adjustments via
    _mist."""
    src = np.clip(arr, 0.0, 1.0).astype(np.float32)
    if amount > 0:
        # Positive clarity: midtone local contrast (definition / "bite").
        smooth = cv2.GaussianBlur(src, (0, 0), max(0.8, radius / 40.0))
        base = cv2.ximgproc.guidedFilter(smooth, smooth, int(max(4, radius)), 0.01)
        band = smooth - base
        luma = arr @ _LUMA
        mask = np.power(1.0 - np.abs(2.0 * luma - 1.0), 1.5)[..., None]  # peaks at midtones
        delta = amount * band * mask
        delta -= 0.15 * amount * np.abs(band) * mask
        return np.clip(arr + delta, 0.0, 1.0)
    # Negative clarity: a pure fine-detail *softener* (the Fuji look), NOT a
    # contrast control. Blend the image toward an edge-preserving guided-filter
    # smooth so low-contrast fine texture (wrinkles, pores, skin) goes soft and
    # less visible while genuine edges (face outline, eyes) stay crisp. Overall and
    # local contrast are left untouched - it reads as softening, not as reduced
    # contrast. The diffusion glow that completes the look is layered on via _mist.
    fine = cv2.ximgproc.guidedFilter(src, src, int(max(2.0, radius / 6.0)), 7e-3)
    blend = min(0.9, abs(amount) * 0.8)
    return np.clip(arr * (1.0 - blend) + fine * blend, 0.0, 1.0)


def _grain_pil(image: PILImage.Image, adj: dict) -> PILImage.Image:
    """Apply the film-grain pass to a PIL image at its *current* resolution."""
    g = adj.get("grain_amount", 0)
    if g <= 0:
        return image
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    arr = _apply_grain(arr, g, adj.get("grain_size", 25), adj.get("grain_roughness", 50))
    return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8), "RGB")


def _apply_local_adjustments(arr: np.ndarray, madj: dict) -> np.ndarray:
    """Render a mask's local adjustments on a copy of the (already globally-toned)
    array: the spatial detail passes it can use (clarity/structure/sharpness/
    dehaze) plus the tonal/colour pass. Whole-image effects (grain, vignette,
    glow, mist) are global-only and never applied per mask."""
    full = develop.normalize(madj)
    long_edge = max(arr.shape[:2])
    cl = full.get("clarity", 0)
    if cl:
        arr = _clarity(arr, max(4.0, long_edge / 50.0), cl / 100.0 * 1.3)
    st = full.get("structure", 0)
    if st:
        arr = develop_effects.apply_structure(arr, st)
    sp = full.get("sharpness", 0)
    if sp:
        arr = _unsharp(
            arr, min(2.0, max(0.6, long_edge / 2000.0)), sp / 100.0 * 1.2,
            threshold=full.get("sharpness_threshold", 0),
        )
    dh = full.get("dehaze", 0)
    if dh:
        arr = _dehaze(arr, dh)
    return _adjust_array(arr, full)


def apply_masks(arr: np.ndarray, adj: dict) -> np.ndarray:
    """Blend each mask's local adjustments into the image, weighted by the mask's
    generated field * opacity (inverted if the mask is inverted). Masks with no
    region or no non-default adjustment are skipped."""
    mask_list = adj.get("masks") or []
    if not mask_list:
        return arr
    for mask in mask_list:
        if not mask.get("visible", True) or not mask.get("sub_masks"):
            continue
        madj = mask.get("adjustments") or {}
        if develop.is_neutral(madj):
            continue
        field = masks.generate_mask_field(mask, arr)
        m = field * (mask.get("opacity", 100) / 100.0)
        if mask.get("invert"):
            m = 1.0 - m
        m = np.clip(m, 0.0, 1.0)
        if float(m.max()) <= 0.0:
            continue
        adjusted = _apply_local_adjustments(arr.copy(), madj)
        m3 = m[..., None]
        arr = arr * (1.0 - m3) + adjusted * m3
    return np.clip(arr, 0.0, 1.0)


def apply_adjustments(
    image: PILImage.Image, adj: dict, include_grain: bool = True, fast: bool = False
) -> PILImage.Image:
    """Return a new image with the slider edits baked in, or the input untouched
    when everything is neutral (the common case - avoids a needless numpy pass).

    `include_grain=False` skips the grain pass so the caller can add grain
    *after* downscaling to the output size (see generate_derivatives): grain
    baked at full resolution gets averaged away by the LANCZOS downscale to the
    preview/thumbnail, so what you saw in the editor vanished after saving.

    `fast=True` is the interactive *scrub* pipeline used while a control is being
    dragged: it keeps the cheap per-pixel tonal pass, masks and vignette but
    skips the expensive convolution passes (denoise, clarity/structure/sharpen,
    chromatic aberration, dehaze, and the diffusion finishing effects + grain).
    The accurate render on pointer-up brings them all back, so the settled
    preview - and the save - are unchanged; only the transient drag frames are
    lighter."""
    if develop.is_neutral(adj):
        return image
    long_edge = max(image.size)
    # Denoise first (spatial), split into Luminance + Colour like RapidRAW. The
    # single "Denoise" slider is a master over both: it feeds luma 1:1 and chroma
    # a bit harder (colour blotching is the ugly part of high-ISO noise and the
    # eye barely resolves chroma detail, so it can take more without going soft).
    # Per-channel sliders still win where they're set higher.
    dn = adj.get("denoise", 0)
    ln = max(adj.get("luma_noise_reduction", 0), dn)
    cn = max(adj.get("color_noise_reduction", 0), min(100, int(round(dn * 1.3))))
    if not fast and (ln > 0 or cn > 0):
        image = _denoise_image(image.convert("RGB"), ln, cn)
    rgb = image.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    # Detail (spatial), before the tonal pass: clarity = large-radius local
    # contrast, structure = medium-radius local contrast, sharpness = small-radius
    # edge enhancement. All skipped in the fast scrub pipeline.
    cl = adj.get("clarity", 0)
    if cl and not fast:
        arr = _clarity(arr, max(4.0, long_edge / 50.0), cl / 100.0 * 1.3)
        if cl < 0:
            # Fuji's negative clarity doesn't just flatten - it diffuses like a
            # Pro-Mist filter (soft halation around brights). Layer a gentle
            # whole-highlight glow (not the light-source-only Mist) on top of the
            # band softening; strength follows the slider.
            arr = _mist(arr, min(50, int(-cl * 0.35)), light_sources=False)
    st = adj.get("structure", 0)
    if st and not fast:
        arr = develop_effects.apply_structure(arr, st)
    sp = adj.get("sharpness", 0)
    if sp and not fast:
        # +sharpen / -soften share the unsharp formula (negative amount blends
        # toward the blur). Radius is capped so sharpening stays a fine, tight
        # edge enhancement; Threshold gates it away from noise/smooth areas.
        arr = _unsharp(
            arr, min(2.0, max(0.6, long_edge / 2000.0)), sp / 100.0 * 1.2,
            threshold=adj.get("sharpness_threshold", 0),
        )
    ca_rc = adj.get("chromatic_aberration_red_cyan", 0)
    ca_by = adj.get("chromatic_aberration_blue_yellow", 0)
    if not fast and (ca_rc or ca_by):
        arr = develop_effects.apply_chromatic_aberration(arr, ca_rc, ca_by)
    # Dehaze is spatial too (transmission map from the dark channel), so it runs
    # here rather than in the per-pixel tonal pass.
    dh = adj.get("dehaze", 0)
    if dh and not fast:
        arr = _dehaze(arr, dh)
    arr = _adjust_array(arr, adj)
    # Local (per-region) mask adjustments layer on the globally-toned image,
    # before the global finishing effects (bloom/vignette/grain).
    arr = apply_masks(arr, adj)
    # Highlight-bloom / diffusion effects run on the *toned* image (like a filter
    # in front of the lens), after the tonal pass. All are large-radius blurs, so
    # the fast scrub pipeline skips them (restored on the pointer-up render).
    if not fast and adj.get("mist", 0) > 0:
        arr = _mist(arr, adj["mist"])
    if not fast and adj.get("glow_amount", 0) > 0:
        arr = develop_effects.apply_glow(arr, adj["glow_amount"])
    if not fast and adj.get("halation_amount", 0) > 0:
        arr = develop_effects.apply_halation(arr, adj["halation_amount"])
    if not fast and adj.get("flare_amount", 0) > 0:
        arr = develop_effects.apply_flare(arr, adj["flare_amount"])
    if adj.get("vignette_amount", 0):
        arr = develop_effects.apply_vignette(
            arr,
            adj["vignette_amount"],
            adj.get("vignette_midpoint", 50),
            adj.get("vignette_roundness", 0),
            adj.get("vignette_feather", 50),
        )
    if include_grain and not fast and adj.get("grain_amount", 0) > 0:
        arr = _apply_grain(arr, adj["grain_amount"], adj.get("grain_size", 25), adj.get("grain_roughness", 50))
    out = (arr * 255.0 + 0.5).astype(np.uint8)
    return PILImage.fromarray(out, "RGB")


def add_frame(image: PILImage.Image, adj: dict | None) -> PILImage.Image:
    """Composite a solid white border around the image as the final render step.

    The width is a percentage of the shorter edge, computed per output size, so it
    is resolution-independent (a preview, thumbnail and full render all get a
    proportional frame) and equally thick on portrait and landscape. Expands the
    canvas - the whole photo stays visible, matted like a print. No-op at 0.

    Run this *after* grain so the border stays a clean, un-textured white."""
    pct = adj.get("frame_width", 0) if adj else 0
    if not pct or pct <= 0:
        return image
    rgb = image.convert("RGB")
    w, h = rgb.size
    border = int(round(min(w, h) * pct / 100.0))
    if border <= 0:
        return rgb
    framed = PILImage.new("RGB", (w + 2 * border, h + 2 * border), (255, 255, 255))
    framed.paste(rgb, (border, border))
    return framed


def generate_derivatives(
    image_id: str,
    source_path: Path,
    rotation: int = 0,
    crop: CropBox | None = None,
    adjustments: dict | None = None,
    distortion: int = 0,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
) -> PILImage.Image:
    """Writes thumbnail.jpg (grid) and preview.jpg (lightbox) for an image, and
    returns the decoded full-resolution base image (before edits) so a caller
    can reuse it (e.g. for the CLIP embedding) instead of decoding the RAW again.

    Browsers can't render RAW files directly, so for RAW sources preview.jpg
    is the only viewable representation - it's a true demosaic (not the
    camera's embedded JPEG thumbnail, which would carry the camera's own
    color rendering - see extract_full_preview()), then the user's manual
    rotation/crop (if any) is layered on top before resizing.
    """
    with _gen_lock(image_id):
        out_dir = derivative_dir(image_id)
        base = extract_full_preview(source_path)
        source = base
        if distortion:
            source = apply_distortion(source, distortion)
        source = apply_edits(source, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
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
            preview = add_frame(preview, adjustments)
        _save_atomic(preview, out_dir / "preview.jpg", quality=92)

        thumb = source.copy()
        # Grid thumbnail at a quarter of the original's dimensions (a lot cheaper to
        # generate than a large fixed size, so a full-library rebuild stays quick),
        # capped so huge originals don't still produce oversized thumbnails.
        tw = min(THUMBNAIL_MAX_PX, max(1, round(thumb.width * THUMBNAIL_SCALE)))
        th = min(THUMBNAIL_MAX_PX, max(1, round(thumb.height * THUMBNAIL_SCALE)))
        thumb.thumbnail((tw, th), PILImage.LANCZOS)
        if adjustments:
            thumb = _grain_pil(thumb, adjustments)
            thumb = add_frame(thumb, adjustments)
        _save_atomic(thumb, out_dir / "thumbnail.jpg", quality=88)

        # The full-resolution derivative (for 100% zoom) is now stale - drop it so it
        # is regenerated on next request with the new edits.
        (out_dir / "full.jpg").unlink(missing_ok=True)
        return base


def has_derivatives(image_id: str) -> bool:
    out_dir = settings.thumbnail_cache_root / image_id
    return (out_dir / "thumbnail.jpg").exists() and (out_dir / "preview.jpg").exists()


def ensure_derivatives(image: "Image") -> None:
    """Generate thumbnail/preview only if they're missing. Used by the serve
    path: if the post-import worker is generating this image right now, this
    blocks until it's done and then skips the (now redundant) regeneration
    instead of decoding the same photo a second time."""
    with _gen_lock(image.id):
        if has_derivatives(image.id):
            return
        regenerate_for_image(image)


def _save_atomic(image: PILImage.Image, dest: Path, quality: int) -> None:
    """Write to a temp file in the same dir, then rename into place. The
    thumbnail endpoint can generate a derivative on-demand at the same time the
    background worker is writing it after import; an atomic rename means a
    reader always sees either the old file or a fully-written new one, never a
    half-written JPEG. The temp name must be unique per *call*, not just per
    process (uuid, not pid): two threads of this one backend writing the same
    derivative used to share a pid-named temp file - one renamed it away and
    the other crashed with FileNotFoundError."""
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    image.save(tmp, "JPEG", quality=quality)
    os.replace(tmp, dest)


# Working resolution for the interactive editor preview: enough for a sharp
# on-screen image, small enough that a full pipeline pass stays interactive.
EDITOR_PREVIEW_PX = 1600

# Working resolution for the *scrub* preview - the frames rendered continuously
# while a slider/curve/wheel/mask handle is being dragged. Small on purpose: the
# whole pipeline (and the JPEG encode) scales with pixel count, so ~750px is
# roughly 4-5x fewer pixels than EDITOR_PREVIEW_PX and, together with the fast
# pipeline that skips the convolution passes (see apply_adjustments(fast=True)),
# keeps each drag frame at a few tens of ms. Replaced by the accurate 1600px
# render the moment the pointer is released.
SCRUB_PREVIEW_PX = 750

# Resolution for the settled "refinement" render. NOT the image's true full
# resolution: a live preview at 40-60MP turns every numpy pass in the pipeline
# (each a float32 RGB array of the whole frame, several live at once through
# dehaze/clarity/denoise) into hundreds of MB, and several settle-renders
# overlapping in the request threadpool stacked into multiple GB and wedged the
# app. Capped here instead - the resolution-dependent passes (grain, sharpen,
# denoise, clarity radii) all scale with the long edge, so they *look* the same
# at this size as at full res, which is the whole point of the refinement pass.
FULL_EDITOR_PREVIEW_PX = 2600

# Only one settled full-quality render at a time. It's the memory-heavy path, so
# serialising it keeps peak RAM to a single pipeline's worth even when a flurry
# of slider settles each kick one off (the stale ones are aborted client-side,
# but a numpy pass already running can't be interrupted).
_full_render_lock = threading.Lock()


@lru_cache(maxsize=9)
def _cached_editor_base(image_id: str, path_str: str, mtime_ns: int, max_px: int) -> PILImage.Image:
    """The decoded, downscaled base image the editor preview renders on top of.
    Cached so slider moves only re-run the edit pipeline, not the (expensive)
    RAW decode. Keyed by file mtime so an on-disk change invalidates. Treat the
    returned image as immutable - every pipeline step copies. maxsize covers the
    three working sizes (SCRUB_PREVIEW_PX / EDITOR_PREVIEW_PX /
    FULL_EDITOR_PREVIEW_PX) for a couple of images being browsed between in the
    editor.

    The scrub base is downscaled from the interactive base rather than decoded
    afresh: extract_full_preview on a big RAW is the one genuinely slow step, so
    when the 1600px entry is already warm we thumbnail *it* down to 750px (a
    cheap LANCZOS pass) instead of paying the decode again for the smaller size."""
    if max_px == SCRUB_PREVIEW_PX:
        base = _cached_editor_base(image_id, path_str, mtime_ns, EDITOR_PREVIEW_PX)
        src = base.copy()
        src.thumbnail((max_px, max_px), PILImage.LANCZOS)
        return src
    src = extract_full_preview(Path(path_str))
    src.thumbnail((max_px, max_px), PILImage.LANCZOS)
    return src.convert("RGB")


def render_editor_preview_bytes(
    image: "Image",
    rotation: int,
    crop: CropBox | None,
    adjustments: dict,
    distortion: int = 0,
    max_px: int = EDITOR_PREVIEW_PX,
    full_quality: bool = False,
    scrub: bool = False,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
) -> bytes:
    """Render the editor's live preview server-side: the exact save pipeline
    (same code path as generate_derivatives/render_edited_image) on a cached,
    preview-sized base. One pipeline = the preview IS the saved look - no
    JS mirror to drift out of sync.

    Three render tiers, all one pipeline:
    - `scrub=True`: the frames drawn continuously while a control is dragged -
      a small SCRUB_PREVIEW_PX base with the convolution passes skipped
      (apply_adjustments(fast=True)). Cheap enough to keep the drag fluid.
    - default: the accurate EDITOR_PREVIEW_PX render drawn the moment a drag
      ends (full pipeline).
    - `full_quality=True`: renders on a larger (but still bounded, see
      FULL_EDITOR_PREVIEW_PX) base - too slow for live drags, but fetched once
      the sliders settle so resolution-dependent passes (denoise radius, sharpen
      radius, grain) are previewed at the size they'll look like when saved."""
    from app.services.filesystem import resolve_image_path

    path = resolve_image_path(image)
    if full_quality:
        # Serialise + bound resolution so a burst of settle-renders can't stack
        # into many GB of concurrent full-frame numpy arrays.
        with _full_render_lock:
            return _render_editor_bytes(
                image, path, FULL_EDITOR_PREVIEW_PX, rotation, crop, adjustments, distortion,
                flip_h, flip_v, straighten, persp_h, persp_v, quality=95, fast=False,
            )
    if scrub:
        return _render_editor_bytes(
            image, path, SCRUB_PREVIEW_PX, rotation, crop, adjustments, distortion,
            flip_h, flip_v, straighten, persp_h, persp_v, quality=82, fast=True,
        )
    return _render_editor_bytes(
        image, path, max_px, rotation, crop, adjustments, distortion,
        flip_h, flip_v, straighten, persp_h, persp_v, quality=88, fast=False,
    )


def _render_editor_bytes(
    image: "Image",
    path: Path,
    base_px: int,
    rotation: int,
    crop: CropBox | None,
    adjustments: dict,
    distortion: int,
    flip_h: bool,
    flip_v: bool,
    straighten: float,
    persp_h: int,
    persp_v: int,
    quality: int,
    fast: bool = False,
) -> bytes:
    img = _cached_editor_base(image.id, str(path), path.stat().st_mtime_ns, base_px)
    if distortion:
        img = apply_distortion(img, distortion)
    img = apply_edits(img, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
    img = apply_adjustments(img, adjustments, fast=fast)
    img = add_frame(img, adjustments)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
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
    image: "Image",
    rotation: int,
    crop: CropBox | None,
    adjustments: dict,
    distortion: int = 0,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
) -> PILImage.Image:
    """Full-resolution RGB render with the given lens/geometry and tonal edits
    baked in. Used to write a flattened edited *copy* into the library."""
    from app.services.filesystem import resolve_image_path

    source = extract_full_preview(resolve_image_path(image))
    if distortion:
        source = apply_distortion(source, distortion)
    source = apply_edits(source, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
    source = apply_adjustments(source, adjustments)
    source = add_frame(source, adjustments)
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
        flip_h=bool(getattr(image, "edit_flip_h", False)),
        flip_v=bool(getattr(image, "edit_flip_v", False)),
        straighten=float(getattr(image, "edit_straighten", 0.0) or 0.0),
        persp_h=int(getattr(image, "edit_persp_h", 0) or 0),
        persp_v=int(getattr(image, "edit_persp_v", 0) or 0),
    )
    _save_atomic(rendered, out, quality=90)
    return out


def adjustments_from_image(image: "Image") -> dict:
    """The full develop adjustments dict for an Image row (parsed from the
    edit_adjustments JSON and normalized to defaults), ready for
    apply_adjustments / generate_derivatives."""
    return develop.loads(getattr(image, "edit_adjustments", None))


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
        flip_h=bool(getattr(image, "edit_flip_h", False)),
        flip_v=bool(getattr(image, "edit_flip_v", False)),
        straighten=float(getattr(image, "edit_straighten", 0.0) or 0.0),
        persp_h=int(getattr(image, "edit_persp_h", 0) or 0),
        persp_v=int(getattr(image, "edit_persp_v", 0) or 0),
    )
