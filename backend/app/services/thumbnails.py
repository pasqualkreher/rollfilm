import io
import json
import math
import os
import logging
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image as PILImage, ImageOps

from app.config import settings
from app.services import develop, develop_color, develop_effects, film_sims, masks
from app.services import raw as raw_service


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

# Long-edge cap for small.jpg, the tier the dense grid sizes (XS/S) request. A
# 4K screenful at those sizes is several hundred tiles; at 1600px each that is
# over a gigabyte of decoded pixels - past what the renderer keeps decoded, so
# it silently drops tiles and they paint empty. 640px covers the largest XS/S
# tile on a 2x display and decodes at ~1/6 the memory.
SMALL_MAX_PX = 640

# Long-edge cap for the stored lightbox preview.jpg. Big enough for any screen;
# the true 100%-zoom pixels come from full.jpg (rendered at full resolution on
# demand), so preview.jpg no longer needs to carry the whole sensor.
PREVIEW_RENDER_MAX_PX = 2600

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


def derivative_path(image_id: str) -> Path:
    """Where an image's derivatives live - without bringing the folder into
    existence. For readers and for deletion; writers want derivative_dir()."""
    return settings.thumbnail_cache_root / image_id


def derivative_dir(image_id: str) -> Path:
    """Same folder, created if missing. Only for callers about to write into
    it - creating it anywhere else leaves empty folders behind for photos that
    have no derivatives."""
    path = derivative_path(image_id)
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


# --- Render admission control -------------------------------------------------
# Derivative generation is the one genuinely heavy thing this process does: a
# frame's worth of linear float32 pixels plus the pipeline's full-frame temporaries.
# The callers are independently sized pools that know nothing about each other -
# the post-import workers, the maintenance rebuild pool, and (worst of all) the
# on-demand thumbnail endpoint, which runs on uvicorn's 40-thread pool and so
# could start 40 concurrent decodes the moment a grid full of fresh imports
# scrolled into view. Nothing bounded their *sum*, which is how an import filled
# RAM and took the whole machine into swap.
#
# One process-wide semaphore fixes that: however many pools ask, only this many
# renders run at once. Sized to deliberately leave headroom so the machine stays
# usable while a big import churns - both cores (the UI, the browser and the
# rest of the system need some) and RAM (never budget the whole machine; the OS,
# the CLIP model and the page cache all want their share).
#
# Measured on a 26MP source (Fuji RAF and its JPEG sibling): ~1GB peak RSS for
# one generate_derivatives call, dominated by apply_adjustments_linear's
# full-frame float32 temporaries. Bigger sensors cost proportionally more, so
# this is a floor rather than a guarantee - which is why the RAM budget below
# only spends a third of the machine.
_PEAK_BYTES_PER_RENDER = 1024**3


def _physical_ram_bytes() -> int | None:
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        return None


# What the rest of the machine needs regardless of how much RAM it has: the
# OS, the Electron shell, the backend itself and the CLIP model together sit
# around 4-5GB. That cost is fixed, not proportional - which is why the budget
# below is "everything above this floor" rather than only a fraction of RAM:
# a plain one-third rule starved an 8GB machine down to 2 slots while six
# cores idled through an import.
_RAM_FLOOR_BYTES = 5 * 1024**3


def _render_slot_count() -> int:
    # Leave two cores for everything that isn't photo processing.
    slots = max(1, (os.cpu_count() or 4) - 2)
    ram = _physical_ram_bytes()
    if ram:
        # Whichever is larger: a third of RAM (small machines) or what's left
        # above the fixed floor (everything else). Still a hard cap - the
        # unbounded version of this took the machine into swap.
        budget = max(ram // 3, ram - _RAM_FLOOR_BYTES)
        slots = min(slots, max(1, int(budget // _PEAK_BYTES_PER_RENDER)))
    return slots


RENDER_SLOTS = _render_slot_count()
_render_slots = threading.BoundedSemaphore(RENDER_SLOTS)


class RenderBusy(Exception):
    """No render slot came free within the caller's patience. Raised only for
    callers that passed a `slot_timeout` - i.e. request handlers, which would
    rather shed the work than hold a server thread. Background workers pass no
    timeout and simply queue."""


@contextmanager
def _locked(lock, timeout: float | None):
    """Acquire `lock`, giving up with RenderBusy after `timeout` seconds.
    None waits indefinitely."""
    if not (lock.acquire() if timeout is None else lock.acquire(timeout=timeout)):
        raise RenderBusy
    try:
        yield
    finally:
        lock.release()


@contextmanager
def _render_admission(timeout: float | None):
    """Hold one of the RENDER_SLOTS admission tickets for the duration.

    Bounding the *wait* matters as much as bounding the renders: with only a
    couple of slots, a grid full of not-yet-generated photos could otherwise
    park every thread of uvicorn's pool in this queue and stall the whole API -
    trading the RAM exhaustion for thread-pool exhaustion. Request handlers pass
    a short timeout and get RenderBusy instead, which they turn into a "retry
    shortly" response; the post-import worker is producing the same derivative
    anyway."""
    with _locked(_render_slots, timeout):
        yield


def _distortion_indices(h: int, w: int, amount: int) -> tuple[np.ndarray, np.ndarray]:
    """The (sy, sx) source-index maps of the radial lens-distortion correction,
    shared by the PIL and float-array variants."""
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
    return sy, sx


def apply_distortion(image: PILImage.Image, amount: int) -> PILImage.Image:
    """Radial lens-distortion correction (geometric), circular in pixel space
    (aspect-correct). +amount corrects barrel (pulls content in), -amount corrects
    pincushion. Nearest sampling; the JS live preview mirrors this exactly."""
    if not amount:
        return image
    rgb = np.asarray(image.convert("RGB"))
    sy, sx = _distortion_indices(rgb.shape[0], rgb.shape[1], amount)
    return PILImage.fromarray(rgb[sy, sx], "RGB")


def apply_distortion_array(arr: np.ndarray, amount: int) -> np.ndarray:
    """apply_distortion for a float HxWx3 array (the linear pipeline base)."""
    if not amount:
        return arr
    sy, sx = _distortion_indices(arr.shape[0], arr.shape[1], amount)
    return arr[sy, sx]


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


def apply_edits_array(
    arr: np.ndarray,
    rotation: int,
    crop: CropBox | None,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
) -> np.ndarray:
    """apply_edits for a float HxWx3 array (the linear pipeline base): each
    channel plane rides through the unchanged PIL geometry as a 32-bit float
    ("F" mode) image, so rotation/straighten/perspective/crop stay bit-identical
    to the display path - one geometry implementation, two pixel formats."""
    if not (flip_h or flip_v or rotation or straighten or persp_h or persp_v or crop):
        return arr
    planes = [
        apply_edits(
            PILImage.fromarray(np.ascontiguousarray(arr[..., c]), "F"),
            rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v,
        )
        for c in range(arr.shape[-1])
    ]
    return np.stack([np.asarray(p, dtype=np.float32) for p in planes], axis=-1)


# Per-hue color mixer bands and their centre hues (degrees). The circle is split
# into the segments between adjacent centres; a pixel's hue is blended between the
# two bands bounding its segment (partition of unity), so shifts stay smooth.
COLOR_BANDS = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
_BAND_EDGES = (0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0, 360.0)

# Per-band Range reshapes that blend: how far a band's edit carries into the
# neighbouring hues before the neighbour takes over. -100..100, 0 = the plain
# linear ramp the mixer has always used.
#
# A segment's blend runs on t in 0..1 from one band's centre to the next, and the
# two weights are (1-f(t)) and f(t). Shaping f instead of widening a kernel is
# what keeps this well-behaved: the weights still sum to 1 at every hue, so a
# band is always at full strength on its own centre hue and setting every band
# alike still applies that value evenly - Range only moves the handover.
#
#   f(t) = t^a / (t^a + (1-t)^b)
#
# with `a` from the band on the left of the segment and `b` from the one on the
# right. Each exponent governs how long its own band holds on: a = b = 1 divides
# out to f(t) = t, i.e. exactly the old ramp, so stored edits render unchanged.
# Above 1 the band keeps close to full weight well into its neighbour's half
# (bleeds further); below 1 it drops away right next to its own centre (stays
# tight). f is strictly increasing for any positive a, b, so the blend never
# folds back on itself.
_RANGE_EXP = 4.0  # exponent at +-100; geometric, so -100 and +100 are mirrors


def _range_exp(rng: float) -> float:
    return float(_RANGE_EXP ** (float(rng) / 100.0))


def _blend_shape(t: np.ndarray, a: float, b: float) -> np.ndarray:
    """Reshape a 0..1 segment blend by the two bounding bands' Range exponents."""
    if a == 1.0 and b == 1.0:
        return t
    ta = np.power(t, a)
    tb = np.power(1.0 - t, b)
    # ta and tb are never both zero on 0..1 (that would need t == 0 and t == 1),
    # so the epsilon is belt-and-braces against float underflow, not a real case.
    return ta / (ta + tb + 1e-9)


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


def _apply_color_mix(arr: np.ndarray, mix: dict, hue_deg: float = 0.0,
                     ranges: dict | None = None) -> np.ndarray:
    """Shift hue / saturation / luminance of each colour band. `mix` maps a band
    name to [hue, sat, lum], each -100..100. `hue_deg` rotates *all* hues by a
    number of degrees (-180..180) to shift the whole palette. `ranges` maps a band
    name to -100..100 (0 = neutral) and sets how far that band's edit reaches into
    the neighbouring hues - see _blend_shape."""
    bands = [list(mix.get(b, [0, 0, 0])) for b in COLOR_BANDS]
    # Range only reshapes how the bands' *values* are blended, so with every band
    # neutral there is nothing for it to reshape - the early-out stays correct.
    if not hue_deg and not any(any(v) for v in bands):
        return arr
    exps = [_range_exp((ranges or {}).get(b, 0)) for b in COLOR_BANDS]
    hue, sat, lum = _rgb_to_hsl(arr)
    hue_shift = np.zeros_like(hue)
    sat_adj = np.zeros_like(hue)
    lum_adj = np.zeros_like(hue)
    for j in range(8):
        lo, hi = _BAND_EDGES[j], _BAND_EDGES[j + 1]
        nxt = (j + 1) % 8
        b0, b1 = bands[j], bands[nxt]
        m = (hue >= lo) & (hue < hi)
        t = _blend_shape((hue[m] - lo) / (hi - lo), exps[j], exps[nxt])
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


def _dehaze(arr: np.ndarray, amount: int, ref_long_edge: float | None = None) -> np.ndarray:
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
    # The filter radius belongs to the photo, not to the tile being rendered.
    dark = cv2.ximgproc.guidedFilter(
        gray, coarse, int(max(8, (ref_long_edge or max(h, w)) / 40)), 1e-3
    )
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


# How far above the estimated chroma-noise level a correction may reach before
# it is treated as real colour and shrunk away (see _denoise_image). Measured
# against noise-free charts and synthetic high-ISO blotching: 4 halves the hue
# damage on hard colour boundaries (32 -> 13 degrees) and near-eliminates it on
# smooth colour (11 -> 2.5 degrees) while removing MORE chroma noise than the
# unguarded pass on edged content (RMSE 6.4 against 8.4). Higher values denoise
# flat colour slightly better and cost colour fidelity roughly linearly; the
# unguarded pass is the limit as this goes to infinity.
_CHROMA_NOISE_K = 4.0


def _denoise_image(
    image: PILImage.Image, luma_amt: int, color_amt: int, ref_short_edge: float | None = None
) -> PILImage.Image:
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
        sigma = max(4.0, (ref_short_edge or min(ycc.shape[:2])) / 200.0)
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
        # NR must not repaint the picture ("denoise changes the colours"), the
        # chroma counterpart of the tone add-back in the luma pass above. The
        # quarter-scale blur is wide (up to ~20px at full size) and the guided
        # upsample can only put back edges LUMA can see - two saturated areas of
        # the same brightness have no luma edge between them, so their colours
        # bled into each other. Measured on a noise-free chart, denoise 50 moved
        # hue by up to 42 degrees and saturation by 0.24: damage done to a photo
        # with nothing to denoise.
        #
        # So keep only the part of the correction that is plausibly noise. The
        # image states its own noise level - the median |correction| is a robust
        # estimate of it, since noise is everywhere and edges are not - and
        # corrections far above it are shrunk toward zero (Wiener-style, smooth
        # rather than a hard cut, so nothing switches on at a threshold). Noise
        # sits at or below the level and passes through nearly untouched; a real
        # colour boundary is an order of magnitude above it and is left alone.
        # On a clean image the estimate collapses and the pass becomes a no-op,
        # which is the behaviour that was actually wanted all along.
        delta = smooth - ch
        level = float(np.median(np.abs(delta[::4, ::4])))
        limit = max(_CHROMA_NOISE_K * level, 1e-5)
        delta *= (limit * limit) / (delta * delta + limit * limit)
        out[..., c] = np.clip((ch + delta * w) * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
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


# A wide Gaussian is expensive in a way that scales with its own radius: the
# widest lobe below has a sigma of a seventh of the field, and computed honestly
# it costs more than the rest of this pass put together. Three box blurs in
# succession converge on a Gaussian (central limit; the result is a cubic
# B-spline), and a box blur is a sliding sum - the same cost per pixel whatever
# its width. Measured against cv2.GaussianBlur on the radii this pass uses, the
# worst-case error is under 1% of full scale on random noise and far below that
# on the smooth field it actually runs on, and the three lobes together cost 6ms
# instead of 83ms. Widths follow the standard integer fit (Kovesi): pick the odd
# width whose n-fold convolution has the wanted variance, splitting between two
# adjacent widths to land on it exactly.
#
# Three boxes is a coarse fit at small sigma - 2% by the time the width is down
# to five pixels, 3% at three - and there is nothing to win there anyway, since
# a Gaussian that narrow is already cheap (a few ms on the field this runs on,
# against ~6ms for the whole box chain). Below eight pixels the real thing runs
# instead, which is why the error above holds for every radius, not just the
# wide ones where boxes happen to be accurate.
_BOX_GAUSS_MIN_SIGMA = 8.0


def _box_gauss(img: np.ndarray, sigma: float, passes: int = 3) -> np.ndarray:
    if sigma < 0.6:
        return img
    if sigma < _BOX_GAUSS_MIN_SIGMA:
        return cv2.GaussianBlur(img, (0, 0), sigma)
    ideal = math.sqrt(12.0 * sigma * sigma / passes + 1.0)
    lo = max(1, int(math.floor(ideal)) | 1)  # nearest odd width at or below
    n_lo = round(
        (12.0 * sigma * sigma - passes * lo * lo - 4.0 * passes * lo - 3.0 * passes)
        / (-4.0 * lo - 4.0)
    )
    out = img
    for i in range(passes):
        w = lo if i < n_lo else lo + 2
        if w > 1:
            out = cv2.boxFilter(out, -1, (w, w))
    return out


# --- Diffusion (Pro-Mist) ----------------------------------------------------
# A diffusion filter is a sheet of glass with something in it - suspended
# particles, an etched surface - that scatters part of the light passing through
# instead of focusing it. Two facts about that separate an optical look from a
# pasted-on glow, and neither of them is a Gaussian blur:
#
# 1. The point spread function is HEAVY-TAILED. A point light seen through real
#    diffusion has a bright core hugging the source *and* a wide, shallow veil
#    reaching far past it (roughly 1/r^2). One Gaussian can only ever be one of
#    the two - narrow gives a tight blob with a visible edge, wide gives the
#    featureless grey wash - which is why a single blur always reads as "blur".
#    A few Gaussians at geometrically spaced radii, weighted down as they widen,
#    fit that tail closely enough (the standard cheap PSF fit) and are what make
#    the halo read as glass: bloom right at the light, glow around it, and a
#    faint bloom-off across the whole frame.
# 2. Scattering MOVES light, it does not create it. A screen blend only ever
#    adds, so the frame gets brighter overall while the highlights keep their
#    full punch and merely wear a halo - the tell of a digital glow. Taking the
#    halo's energy back out of the highlight that emitted it is what trades
#    sharpness for bloom: specular points soften and bleed instead of sitting
#    there sharp with a ring around them, and a large blown area stays put (its
#    neighbours scatter into it as fast as it scatters out) rather than
#    inflating into white mush.
#
# Radii are fractions of the long edge, so the look is resolution-independent.
_MIST_PSF = ((1.0, 0.50), (2.7, 0.31), (7.5, 0.19))  # (radius x base, weight)
_MIST_BASE_DIV = 60.0  # base sigma = long_edge / this

# The halo carries the scattered light back with a surplus: a real filter's
# near-source output measures brighter than pure conservation predicts, because
# light reflected around inside the glass adds to what passes straight through.
# That surplus IS the veiling that lifts the blacks around a light source - the
# half of the Pro-Mist look a Black Pro-Mist trades away - so it is what keeps
# the effect additive-feeling at moderate settings without washing the frame.
_MIST_VEIL_GAIN = 1.25

# Scattered light comes back slightly warm: glass and coatings pass long
# wavelengths a touch more freely than short ones. Barely a percent either way -
# luminance-neutral to three decimals - but it is the difference between a halo
# that looks like glass and one that looks like a grey blur. (The Halation
# slider is the strong, deliberately red version of this; Mist stays subtle so
# the two stack instead of fighting.)
_MIST_TINT = np.array([1.03, 1.00, 0.95], dtype=np.float32)

# The scatter field is built at a reduced resolution. The narrowest PSF lobe is
# already ~1/60 of the frame, so no detail finer than that survives the blur and
# computing the field at full size is pure waste. INTER_AREA averages, which
# conserves energy on the way down - a one-pixel specular highlight keeps all of
# its light instead of being sampled away - and the field is low-frequency
# enough that bilinear interpolation puts it back without a seam. Three blurs at
# this size cost a fraction of the single full-resolution blur they replace,
# which is what pays for the heavy tail.
_MIST_FIELD_PX = 512


def _mist(
    arr: np.ndarray, amount: int, light_sources: bool = True, ref_long_edge: float | None = None
) -> np.ndarray:
    """Pro-Mist-style optical diffusion: light scattered *out of* the highlights
    and spread back across the frame through a heavy-tailed PSF, in linear light.

    `light_sources=True` (the Mist slider): only genuinely bright highlights and
    light sources scatter. A smooth, steep brightness gate isolates them, so
    midtones and merely-light areas (skin, pale walls, overcast sky) stay clean
    and it reads as light blooming out of the frame rather than a flat haze.

    `light_sources=False` (the negative-clarity diffusion): the softer
    whole-highlight glow - weighted toward the brights but not isolated to point
    sources.

    Both run on the *toned* image, like a filter in front of the lens, and both
    scatter in LINEAR light. Blurring the gamma-encoded values instead averages
    perceptual numbers rather than photons: a lamp a hundred times brighter than
    the wall behind it counts as only about six times brighter once encoded, so
    its core never dominates the halo and the result comes out as an even grey
    veil with no centre. Decoding first is what gives the bloom a bright core
    and a clean falloff - see _MIST_PSF above for the rest of the model."""
    f = min(100, max(0, amount)) / 100.0
    if f <= 0:
        return arr
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    if light_sources:
        # Smoothstep over display 0.62..1.0, squared: the same "light sources
        # only" character the old linear ramp had, but with no corner at the
        # foot of it. A hard knee draws a visible contour line through a smooth
        # gradient - a sky, a softbox falloff - exactly where the effect is
        # meant to be least noticeable.
        t = np.clip((luma - 0.62) * (1.0 / 0.38), 0.0, 1.0)
        mask = np.square(t * t * (3.0 - 2.0 * t))
        # `k` is the fraction of a fully-gated pixel's light the filter diverts.
        k = 0.42 * f
    else:
        # Whole-highlight: everything above the deep shadows scatters a little,
        # the brights most. No isolation - this is the soft overall diffusion
        # that goes with Fuji's negative clarity, not a light-source bloom.
        mask = np.power(np.clip((luma - 0.10) * (1.0 / 0.90), 0.0, 1.0), 1.6)
        k = 0.30 * f
    if float(mask.max()) <= 0.0:
        return arr
    lin = _srgb_to_linear(arr).astype(np.float32)
    src = lin * mask[..., None]

    h, w = lin.shape[:2]
    # Same photo-pixels per field-pixel as a whole-frame render: the field is
    # sized for the frame, and a tile takes its share of it.
    scale = min(1.0, _MIST_FIELD_PX / (ref_long_edge or max(h, w)))
    if scale < 1.0:
        small = cv2.resize(
            src,
            (max(8, int(round(w * scale))), max(8, int(round(h * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    else:
        small = src
    base = max(1.5, max(h, w) * scale / _MIST_BASE_DIV)
    halo = np.zeros_like(small)
    for radius_scale, weight in _MIST_PSF:
        halo += _box_gauss(small, base * radius_scale) * weight
    halo *= _MIST_TINT * (k * _MIST_VEIL_GAIN)
    if scale < 1.0:
        halo = cv2.resize(halo, (w, h), interpolation=cv2.INTER_LINEAR)

    # Scatter: the gated light leaves the direct path (-k*src) and arrives
    # spread out (+halo). The PSF weights sum to 1, so away from the veil
    # surplus this moves light around rather than manufacturing it.
    out = lin - src * k + halo
    return _linear_to_srgb(np.clip(out, 0.0, 1.0)).astype(np.float32)


def _apply_vignette(arr: np.ndarray, amount: int) -> np.ndarray:
    """Darken (amount<0) or lighten (amount>0) the corners, smooth radial falloff."""
    h, w = arr.shape[:2]
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    r2 = np.clip((xx * xx + yy * yy) / 2.0, 0.0, 1.0)  # 0 centre .. 1 corner
    factor = 1.0 + (amount / 100.0) * r2
    return np.clip(arr * factor[..., None], 0.0, 1.0)


# --- Linear tone block -------------------------------------------------------
# Middle grey in linear light: the tone-control regions, contrast pivot and
# brightness bell are all anchored here (the photographic 18% grey card).
_MIDDLE_GREY = 0.18

# Tone-slider regions, in *stops from middle grey* on log2 luminance. Each is a
# smoothstep ramp (start, end): the weight is 0 below `start` stops away from
# grey and reaches 1 at `end` stops away. Highlights/shadows cover everything
# beyond middle grey (including scene-referred values above display white - the
# key to real highlight recovery); whites/blacks gate to the extremes only.
# _*_STOPS is the maximum shift (in stops) each slider applies at +/-100.
# Hand-tuned constants: adjust these against the reference photo set, never the
# logic - and keep the summed log-slope of overlapping regions above -1 so the
# combined curve stays monotone (see test_develop_pipeline).
#
# Whites/blacks set the curve ENDPOINTS like in Lightroom: on top of a small
# late log-region shift, every direction moves a display-referred endpoint -
# whites-negative raises the tonemap WHITE POINT, whites-positive pulls the
# display white point DOWN (brightens toward clipping), blacks-negative sets a
# display-linear BLACK POINT (crushes to true black) and blacks-positive lifts
# it (washes the toe). Endpoint moves act on the *display* range, so they bite
# on every photo - a low-key frame has no pixels 2+ stops above middle grey for
# a scene-referred region to grab, but it always has a display black and white -
# and they compose monotonically with the region shifts no matter how strong.
# Highlights/shadows ramps start 1.5 stops *before* middle grey so the mids
# (where real photos actually live - a low-key frame can have its 95th luma
# percentile AT middle grey) respond decisively; the smoothstep is quadratically
# soft at its start, so the earlier (-0.5, 4.0) ramp left everything below one
# stop above grey nearly dead and the sliders did visibly nothing on darker
# content. Don't steepen these ramps: the sh/hi smoothstep slopes overlap
# around middle grey and their summed log-slope must stay above -1 for the
# curve to remain monotone (see test_develop_pipeline).
_SH_RANGE = (-1.5, 4.5)
_HI_RANGE = (-1.5, 4.5)
# Shadows travel beyond +-100: the tuned ramp above concentrates on the deep
# end, so the extended travel would only push near-black pixels further while
# the visible mid-shadows barely move ("the slider stops biting"). The extra
# amount past +-100 therefore rides an earlier, steeper-rated ramp that
# reaches decisively into the mids - with a different reach per direction:
# lifting keeps the tight ramp (the isotonic guard in _tone_ratio turns its
# steepness into the slammed-up plateau look), while darkening - monotone by
# construction, it only steepens the curve - uses a wider ramp so the visible
# upper shadows keep stepping down through the whole travel instead of only
# the near-black end moving.
_SH_EXTRA_POS_RANGE = (-0.5, 2.5)
_SH_EXTRA_NEG_RANGE = (-1.5, 3.0)
_SH_EXTRA_STOPS = 3.0
_BL_RANGE = (2.5, 6.0)   # blacks > 0: late region lift on top of the endpoint
_WH_RANGE = (2.0, 5.0)   # whites > 0: late region shift on top of the endpoint
_WH_NEG_RANGE = (2.75, 6.0)  # whites < 0: late shift on top of the white point
_SH_STOPS = 2.2
_HI_STOPS = 2.2
_BL_STOPS = 1.5
_WH_STOPS = 1.3
_WH_NEG_STOPS = 1.6
# The display-referred endpoint moves (see the block comment above):
# whites < 0 raises the Reinhard white point by up to this many stops (darkens
# and de-clips the very top end; under AgX, which has no white-point parameter,
# the same slider scales display-linear white down by up to _WH_NEG_AGX);
# whites > 0 divides by up to (1 - _WH_POS_POINT) (white point pulled down -
# highlights brighten into a hard clip, the whole point of Whites);
# blacks < 0 subtracts up to _BL_NEG_POINT display-linear (a true-black toe);
# blacks > 0 lifts the display black point by up to _BL_POS_LIFT.
_WH_NEG_WP_STOPS = 1.2
_WH_NEG_AGX = 0.25
_WH_POS_POINT = 0.25
_BL_NEG_POINT = 0.05
_BL_POS_LIFT = 0.05


def _smoothstep(x: np.ndarray) -> np.ndarray:
    t = np.clip(x, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _tone_curve_y(
    y0: np.ndarray, hi: float, sh: float, wh: float, bl: float, c: float, br: float
) -> np.ndarray:
    """The tone sliders as a pure elementwise mapping of linear luminance -
    the curve itself, reusable on real pixels and on the reference grid the
    monotone guard below evaluates."""
    l = np.log2(y0 / _MIDDLE_GREY)  # stops from middle grey

    # Region-weighted shifts in stops. Shadows/blacks look below middle grey
    # (-l), highlights/whites above (+l); scene-referred values > 1.0 sit at
    # l > 2.47 where the highlight/white weights are at full strength, so
    # negative highlights pull genuine sensor data back under the white point.
    # The endpoint halves of whites/blacks (wh<0 white point, bl<0 black point)
    # are applied in _linear_tone_block - see the constants block above.
    # Shadows: the classic +-100 amount rides the tuned deep-end ramp; the
    # extended travel past it rides the mid-reaching ramp (see _SH_EXTRA_RANGE).
    sh_base = max(-1.0, min(1.0, sh))
    sh_extra = sh - sh_base

    y1 = y0
    shift = None
    for amount, stops, (r0, r1), sign in (
        (sh_base, _SH_STOPS, _SH_RANGE, -1.0),
        (max(sh_extra, 0.0), _SH_EXTRA_STOPS, _SH_EXTRA_POS_RANGE, -1.0),
        (min(sh_extra, 0.0), _SH_EXTRA_STOPS, _SH_EXTRA_NEG_RANGE, -1.0),
        (hi, _HI_STOPS, _HI_RANGE, 1.0),
        (max(bl, 0.0), _BL_STOPS, _BL_RANGE, -1.0),
        (max(wh, 0.0), _WH_STOPS, _WH_RANGE, 1.0),
        (min(wh, 0.0), _WH_NEG_STOPS, _WH_NEG_RANGE, 1.0),
    ):
        if not amount:
            continue
        w = _smoothstep((sign * l - r0) / (r1 - r0))
        term = (amount * stops) * w
        shift = term if shift is None else shift + term
    if shift is not None:
        y1 = y0 * np.exp2(shift)

    # Contrast: a slope change in log-exposure around middle grey - the linear-
    # light analogue of a film curve's gamma. Monotone for the whole range; the
    # tonemap shoulder absorbs the highlight expansion instead of clipping.
    # Asymmetric gain: positive contrast can push a strong S (the shoulder
    # protects the ends), negative must keep the exponent well above zero or
    # the image collapses to flat grey.
    if c:
        k = 1.2 if c > 0 else 0.85
        y1 = _MIDDLE_GREY * np.power(y1 / _MIDDLE_GREY, 1.0 + k * c)

    # Brightness: a Gaussian bell in stops around middle grey - lifts/darkens
    # the mids up to +/-1 stop at the slider extremes while black, white and the
    # scene-referred highlights stay anchored.
    if br:
        l1 = np.log2(np.maximum(y1, 1e-6) / _MIDDLE_GREY)
        bell = np.exp2(0.5 * br * np.exp(-(l1 * l1) / (2.0 * 2.2 * 2.2)))
        y1 = y1 * bell

    return y1


# Reference grid for the monotone guard: -20..+10 stops from middle grey at
# ~0.007-stop resolution, comfortably covering every luminance the pipeline
# can produce.
_TONE_GUARD_L = np.linspace(-20.0, 10.0, 4096, dtype=np.float32)


def _tone_ratio(y: np.ndarray, adj: dict) -> np.ndarray | None:
    """Per-pixel multiplier on linear luminance implementing the tone sliders
    (highlights/shadows/whites/blacks/contrast/brightness), or None when all are
    neutral. Pure math on luminance so tests can drive it with 1-D ramps; the
    caller applies it as one shared RGB ratio, which preserves hue/saturation
    (the old additive per-channel lifts washed colours toward grey)."""
    hi = adj.get("highlights", 0) / 100.0
    sh = adj.get("shadows", 0) / 100.0
    wh = adj.get("whites", 0) / 100.0
    bl = adj.get("blacks", 0) / 100.0
    c = adj.get("contrast", 0) / 100.0
    br = adj.get("brightness", 0) / 100.0  # slider is +/-200 -> br in +/-2
    if not (hi or sh or wh or bl or c or br):
        return None

    y0 = np.maximum(y, 1e-6).astype(np.float32)
    y1 = _tone_curve_y(y0, hi, sh, wh, bl, c, br)

    # Monotone guard for the extended slider travel: the region constants are
    # hand-tuned so every combination within +-100 stays monotone, but the
    # sliders now reach +-150 where steep opposing shifts can reverse the
    # curve (solarisation). Only in that extended zone: evaluate the same
    # curve on the reference grid and, if it reverses anywhere, replace the
    # mapping with its isotonic projection (the curve plateaus instead of
    # folding back), interpolated in log space. Within +-100 this never runs,
    # so existing edits render exactly as before.
    if max(abs(hi), abs(sh), abs(wh), abs(bl)) > 1.0 + 1e-6:
        gy0 = (_MIDDLE_GREY * np.exp2(_TONE_GUARD_L)).astype(np.float32)
        gy1 = _tone_curve_y(gy0, hi, sh, wh, bl, c, br)
        gl1 = np.log2(np.maximum(gy1, 1e-9) / _MIDDLE_GREY)
        if np.any(np.diff(gl1) < 0.0):
            gl1 = np.maximum.accumulate(gl1)
            l0 = np.log2(y0 / _MIDDLE_GREY)
            y1 = _MIDDLE_GREY * np.exp2(np.interp(l0, _TONE_GUARD_L, gl1))

    return (y1 / y0).astype(np.float32)


def _linear_tone_block(lin: np.ndarray, adj: dict, base_gain: float = 1.0) -> np.ndarray:
    """The scene-referred tonal pass: linear-light float RGB in (values may
    exceed 1.0 - that headroom IS the highlight-recovery data), display sRGB
    float 0..1 out. Nothing is clipped until the final encode.

    Order: total gain (auto base gain x 2^exposure, a true stop multiply) ->
    white balance -> tone sliders as one chroma-preserving luminance ratio ->
    tone map (Reinhard-extended shoulder or AgX) -> sRGB encode."""
    ev = float(adj.get("exposure", 0.0) or 0.0)
    t = adj.get("temperature", 0) / 100.0
    n = adj.get("tint", 0) / 100.0

    g = float(base_gain) * (2.0 ** ev)
    arr = lin.astype(np.float32, copy=True)
    if g != 1.0:
        arr *= np.float32(g)
    if t or n:
        # Channel gains: warm = more red / less blue; +tint = magenta (less
        # green). Renormalised by luma so a neutral grey keeps its brightness
        # (white balance shouldn't also change exposure).
        gain = np.array([1.0 + 0.3 * t, 1.0 - 0.3 * n, 1.0 - 0.3 * t], dtype=np.float32)
        gain = gain / float(_LUMA @ gain)
        arr *= gain

    ratio = _tone_ratio(arr @ _LUMA, adj)
    if ratio is not None:
        arr *= ratio[..., None]

    wh = adj.get("whites", 0) / 100.0
    bl = adj.get("blacks", 0) / 100.0
    if adj.get("tone_mapper") == "agx":
        # AgX handles scene-referred input natively (log2 encode spans +4 EV)
        # and returns display-linear 0..1. AgX has no white-point parameter, so
        # whites<0 raises the white point *after* the map instead: scale
        # display-linear white down so nothing reaches 1 (plus the late region
        # shift above, which only bites on genuinely bright content).
        arr = develop_effects.agx_tonemap(np.clip(arr, 0.0, None))
        if wh < 0:
            arr *= np.float32(1.0 - _WH_NEG_AGX * -wh)
    else:
        # Reinhard-extended shoulder on luminance, shared RGB ratio. White point
        # = the applied gain: neutral JPEGs (g=1) pass through untouched, neutral
        # RAWs reproduce the old baked auto-tone exactly, and exposure pushes
        # grow the white point so lifted frames roll off instead of clipping.
        # Whites<0 RAISES the white point (up to _WH_NEG_WP_STOPS stops): the
        # very top end darkens and de-clips decisively, while mids barely move -
        # the Lightroom "whites set the curve endpoint" behaviour.
        white = max(g, 1.0)
        if wh < 0:
            white *= 2.0 ** (_WH_NEG_WP_STOPS * -wh)
        y = np.maximum(arr @ _LUMA, 0.0)
        arr *= raw_service.reinhard_ratio(y, white)[..., None]

    # Display-referred endpoint moves (per channel, standard endpoint
    # behaviour - the encode clip below catches out-of-range tails):
    # whites>0 pulls the display white point down (brightens into a hard clip);
    # blacks<0 sets a display-linear black point (everything below crushes to
    # true black, the rest rescales - a real toe, where the old additive
    # darkening could never reach 0); blacks>0 lifts the black point (washes
    # the toe while white stays pinned). These act on the display range, so
    # every photo responds - the scene-referred regions above only bite where
    # the histogram actually has content.
    if wh > 0:
        arr /= np.float32(1.0 - _WH_POS_POINT * wh)
    if bl < 0:
        bp = np.float32(_BL_NEG_POINT * -bl)
        arr = (arr - bp) / (1.0 - bp)
    elif bl > 0:
        lift = np.float32(_BL_POS_LIFT * bl)
        arr = arr * (1.0 - lift) + lift

    return _linear_to_srgb(np.clip(arr, 0.0, 1.0)).astype(np.float32)


def _display_color_block(arr: np.ndarray, adj: dict) -> np.ndarray:
    """The display-referred colour pass on sRGB float 0..1: film simulation,
    curves, colour calibration, HSL mixer + global hue, Fuji chrome, 3-way
    colour grading, saturation/vibrance. (Curves are defined on the 0..255
    display grid and the mixer/grading semantics are display-space by design,
    so these stay after the tone map.)"""
    s = adj.get("saturation", 0) / 100.0
    vib = adj.get("vibrance", 0) / 100.0

    # The film-simulation look goes first so it acts as the base "stock" the
    # user's curves/mixer/grading refine - the order a camera bakes it in.
    arr = film_sims.apply_film_sim(arr, adj.get("film_sim"), adj.get("lut_intensity", 100))
    # Tone curves (point or parametric per curve_mode) and camera-style colour
    # calibration shape tone/primaries after the basic tonal controls.
    arr = develop_color.apply_curves(arr, adj)
    arr = develop_color.apply_color_calibration(arr, adj.get("color_calibration") or {})

    mix = adj.get("hsl")
    hue_deg = adj.get("hue", 0)
    if (mix and any(any(v) for v in mix.values())) or hue_deg:
        arr = _apply_color_mix(np.clip(arr, 0.0, 1.0), mix or {}, hue_deg,
                               adj.get("hsl_range") or {})
    arr = _apply_chrome(arr, adj.get("chrome_effect", 0), adj.get("chrome_blue", 0))
    # 3-way colour grading (shadows/midtones/highlights/global wheels) on the
    # graded image, after the mixer/chrome.
    arr = develop_color.apply_color_grading(arr, adj.get("color_grading") or {})
    # Saturation is a plain linear chroma scale; Vibrance protects already-vivid
    # colours (and skin tones) by weighting the boost toward muted pixels -
    # RapidRAW keeps the two as separate controls.
    # Both scale factors are floored at zero: the sliders reach -200, and past
    # -100 the image should settle at grayscale, not invert its chroma.
    if s:
        luma = (arr @ _LUMA)[..., None]
        arr = luma + (arr - luma) * max(1.0 + s, 0.0)
    if vib:
        luma = (arr @ _LUMA)[..., None]
        # Chroma (distance from the grey axis) estimates how saturated a pixel
        # already is; muted pixels get most of the push.
        chroma = np.abs(arr - luma).max(axis=-1, keepdims=True)
        weight = 1.0 - np.clip(chroma * 1.4, 0.0, 1.0) * 0.6
        arr = luma + (arr - luma) * np.maximum(1.0 + vib * weight, 0.0)

    return np.clip(arr, 0.0, 1.0)


def _adjust_array(arr: np.ndarray, adj: dict) -> np.ndarray:
    """Apply the tonal/colour adjustments to a display-referred HxWx3 float
    array in 0..1: decode to linear, run the scene-referred tone block (gain 1 -
    an 8-bit source has no headroom to recover), then the display colour block.
    Kept as the display-space entry point for mask-local adjustments
    (_apply_local_adjustments), which operate on the already-toned image."""
    lin = _srgb_to_linear(arr).astype(np.float32)
    return _display_color_block(_linear_tone_block(lin, adj, base_gain=1.0), adj)


def _grain_field(h: int, w: int, particle_px: float, coarse: float, shape: float) -> np.ndarray:
    """A monochrome silver-grain field of unit RMS (float32), built as a
    band-pass noise stack rather than upscaled blocks.

    Real grain has a *band-pass* Wiener spectrum: no energy at the pixel grid
    (that reads as digital sensor noise) and none at low frequencies either
    (that reads as blotchy mottling). The old field - white noise generated at
    1/particle resolution, nearest-upscaled and blurred - had both: the nearest
    upscale left an axis-aligned lattice of square blocks (nothing in film is
    aligned to a grid), and the plain blur is a low-pass, so what survived was
    soft mottling rather than particles.

    Here one white-noise realisation is filtered into two difference-of-Gaussian
    bands - a fine one peaking at ~1.1x the particle size and a `coarse` clump
    band ~2.5x that - and mixed. Both are scale-free, so nothing lines up with
    the pixel grid at any particle size.

    Two shaping steps then turn Gaussian noise into *particles*:
    `shape` (>1) raises the kurtosis, so amplitude concentrates into distinct
    specks with clean gaps between them instead of an even fog, and a small
    negative skew makes the dark specks bite a little harder than the light
    ones - silver grains sit *in* the emulsion.

    The noise is synthesised on a grid of ~3 samples per particle and lifted to
    full size with a cubic (band-limited) upscale: the field carries no detail
    finer than that, so this is exact reconstruction, and it keeps the blur
    kernels small - coarse grain costs the same as fine grain."""
    p = max(1.0, float(particle_px))
    step = max(1.0, p / 3.0)
    nh = max(4, int(round(h / step)))
    nw = max(4, int(round(w / step)))
    # Particle size in work-grid pixels - ~3 by construction, but clamped for
    # the degenerate case of an image smaller than the 4px floor above.
    ps = min(3.5, p / max(h / nh, 1e-6))

    n = np.random.standard_normal((nh, nw)).astype(np.float32)
    g_a = cv2.GaussianBlur(n, (0, 0), max(0.42, ps * 0.30))
    g_b = cv2.GaussianBlur(n, (0, 0), max(0.95, ps * 0.75))
    g_c = cv2.GaussianBlur(n, (0, 0), max(2.40, ps * 1.95))
    fine = g_a - g_b
    clump = g_b - g_c
    fine /= float(fine.std()) + 1e-6
    clump /= float(clump.std()) + 1e-6
    field = fine * (1.0 - coarse) + clump * coarse

    if shape > 1.0:
        sign = np.sign(field)
        np.power(np.abs(field, out=field), shape, out=field)
        field *= sign
    field /= float(field.std()) + 1e-6
    # Mild negative skew (mean preserved), scaled by the square's own spread so
    # the amount of skew stays the same whatever `shape` did to the tails.
    sq = field * field
    field -= (0.05 / (float(sq.std()) + 1e-6)) * (sq - float(sq.mean()))
    field /= float(field.std()) + 1e-6
    if (nh, nw) != (h, w):
        field = cv2.resize(field, (w, h), interpolation=cv2.INTER_CUBIC)
    return field


# Preview-size grain fields, cached by size: synthesising a full-frame noise
# field costs a good chunk of every accurate/settle render with grain active.
# The field depends only on (h, w, particle size, band mix, shaping), so the
# editor's repeated renders of the same image reuse it - which also stops the
# grain pattern re-rolling on every slider tick. Native/full-resolution renders
# (saves, exports) stay above the pixel cap and keep their fresh stochastic
# field per render.
_GRAIN_CACHE: "OrderedDict[tuple[int, int, float, float, float], np.ndarray]" = OrderedDict()
_GRAIN_CACHE_MAX = 8
_GRAIN_CACHE_MAX_PX = 8_000_000
_grain_cache_lock = threading.Lock()


def _cached_grain_field(
    h: int, w: int, particle_px: float, coarse: float, shape: float
) -> np.ndarray:
    if h * w > _GRAIN_CACHE_MAX_PX:
        return _grain_field(h, w, particle_px, coarse, shape)
    key = (h, w, round(particle_px, 4), round(coarse, 3), round(shape, 3))
    with _grain_cache_lock:
        hit = _GRAIN_CACHE.get(key)
        if hit is not None:
            _GRAIN_CACHE.move_to_end(key)
            return hit
    f = _grain_field(h, w, particle_px, coarse, shape)
    f.flags.writeable = False  # shared across renders
    with _grain_cache_lock:
        _GRAIN_CACHE[key] = f
        _GRAIN_CACHE.move_to_end(key)
        while len(_GRAIN_CACHE) > _GRAIN_CACHE_MAX:
            _GRAIN_CACHE.popitem(last=False)
    return f


def _apply_grain(arr: np.ndarray, amount: int, size: int = 0, roughness: int = 50) -> np.ndarray:
    """Fujifilm-style analog film grain.

    Monochromatic (the same offset on R/G/B), like silver grain - Fuji's Grain
    Effect is monochrome too, and coloured grain reads as sensor noise.

    Particle size scales with the image's resolution (long edge), so grain looks
    the *same* on the 2048px preview and the full-resolution save. The field
    itself (_grain_field) is band-pass noise shaped into discrete particles;
    this function only decides how big they are, how much they clump, and how
    they sit on the tone scale.

    Tone response is the other half of the Fuji look. Grain lives in the
    *density* of the emulsion: the thin shadow end of a negative holds almost no
    developed silver, so deep blacks stay clean, while the mids and the bright
    end - skies especially, where Fuji's grain is most recognisable - carry the
    most. Amplitude therefore rises as sqrt(luma) and only eases back near
    paper-white. A flat weighting (what this used before) lifts the blacks with
    an even veil, which is the single clearest giveaway of digital fake grain.

    Stochastic - the preview shows a different pattern than the saved render."""
    h, w = arr.shape[:2]
    size_f = min(100, max(0, size)) / 100.0
    rough = min(100, max(0, roughness)) / 100.0
    long_edge = max(h, w)

    # Particle size relative to resolution. The smallest Grain Size lands on a
    # crisp ~1px fine-ISO texture (the 1.0px floor); the top end is chunky
    # pushed-film. Slightly below the old 3.5 maximum because a band-pass
    # particle reads visually larger than the old blurred block of the same
    # nominal size.
    p = max(1.0, (long_edge / 1500.0) * (0.55 + 2.45 * size_f))
    # How much of the coarse clump band rides along. Big grain clumps more (that
    # is what makes pushed film look pushed); Roughness nudges it either way.
    coarse = min(0.85, max(0.0, 0.10 + 0.45 * size_f + 0.12 * (rough - 0.5)))
    # Roughness is the particle *character*, not just a second volume knob:
    # low = fine, even, almost Gaussian texture; high = sparse, hard-edged
    # specks with clean gaps, plus a little more amplitude to match.
    field = _cached_grain_field(h, w, p, coarse, 1.0 + 0.55 * rough)

    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    # sqrt(luma) - 0.45*luma^3, peaking around luma 0.68 and normalised to 1
    # there: clean deep blacks, full strength through the mids and highlights,
    # a gentle roll-off into pure white (where the positive half of the noise
    # clips anyway, so grain there reads as fine darkening speckle).
    tone_w = np.sqrt(luma)
    tone_w -= 0.45 * luma * luma * luma
    tone_w *= 1.0 / 0.683
    noise = field * tone_w
    noise *= (amount / 100.0) * 0.040 * (0.72 + 0.56 * rough)
    return np.clip(arr + noise[..., None], 0.0, 1.0)


def _unsharp(arr: np.ndarray, radius: float, amount: float, threshold: float = 0.0) -> np.ndarray:
    """Unsharp mask: out = in + amount*(in - blur(in)). Positive amount sharpens,
    negative softens. Small radius = sharpness. `threshold` (0..80, in 0..255 luma
    units) gates sharpening to real edges: high-pass detail weaker than the
    threshold (sensor noise, film grain, smooth skin) is attenuated so only
    genuine edges get crisper - RapidRAW's sharpening Threshold."""
    blur = cv2.GaussianBlur(np.clip(arr, 0.0, 1.0).astype(np.float32), (0, 0), radius)
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
    _mist.

    Both directions are a control over DETAIL DEPTH, not over colour, so the
    whole thing is computed on luminance alone and applied to RGB as one shared
    ratio - the same reason raw.reinhard_ratio is a ratio rather than a
    per-channel curve. Running the band per channel (as this did) meant the
    three channels got different amounts of local contrast wherever their
    texture differed, which pushed saturation up and rotated hue: measured on
    saturated textured patches, +65 clarity moved saturation by up to 0.05 and
    hue by up to 10 degrees. Luminance-only, both survive to float32 rounding
    (1e-7) - clarity changes how deep the detail reads and nothing else.

    The slider does bite slightly harder than the per-channel version did, by 3%
    at +30 rising to 11% at +130 (measured as local-contrast energy): a
    single-channel guide has less to distinguish an edge with, so its base is
    smoother and the band it leaves is wider. Saved edits therefore render a
    touch deeper than they did. Not compensated with a fudge factor - the
    deviation is amount-dependent, so no single scale matches everywhere, and
    the honest reading is that this is what the slider always meant to do.

    A single-channel guide
    is also about half the cost of a three-channel one (47ms against 84ms on a
    2600px frame), so the fix is faster than what it replaces."""
    y = np.clip(arr, 0.0, 1.0).astype(np.float32) @ _LUMA
    y = np.maximum(y, 1e-6)
    if amount > 0:
        # Positive clarity: midtone local contrast (definition / "bite").
        smooth = cv2.GaussianBlur(y, (0, 0), max(0.8, radius / 40.0))
        base = cv2.ximgproc.guidedFilter(smooth, smooth, int(max(4, radius)), 0.01)
        band = smooth - base
        mask = np.power(1.0 - np.abs(2.0 * y - 1.0), 1.5)  # peaks at midtones
        delta = amount * band * mask
        delta -= 0.15 * amount * np.abs(band) * mask
        y_out = y + delta
    else:
        # Negative clarity: a pure fine-detail *softener* (the Fuji look), NOT a
        # contrast control. Blend toward an edge-preserving guided-filter smooth
        # so low-contrast fine texture (wrinkles, pores, skin) goes soft and less
        # visible while genuine edges (face outline, eyes) stay crisp. Overall and
        # local contrast are left untouched - it reads as softening, not as
        # reduced contrast. The diffusion glow that completes the look is layered
        # on via _mist.
        fine = cv2.ximgproc.guidedFilter(y, y, int(max(2.0, radius / 6.0)), 7e-3)
        blend = min(0.9, abs(amount) * 0.8)
        y_out = y * (1.0 - blend) + fine * blend
    # Shared ratio: every channel is scaled by the same factor, so the colour of
    # a pixel is untouched and only its brightness carries the effect.
    ratio = np.maximum(y_out, 0.0) / y
    # Cap the ratio where brightening would push a channel past 1: clipping it
    # afterwards would compress the brightest channel hardest and rotate the hue
    # of exactly the most saturated colours (measured 3 degrees on a fully
    # saturated chart at +130). Capping instead costs those few pixels a little
    # of the effect and keeps their colour. The midtone mask already fades the
    # effect out near white, so this bites on almost nothing.
    # (A black pixel's cap is 1e6, which never binds - and scaling zero by
    # anything is still zero, so it needs no special case.)
    #
    # Three explicit maxima rather than arr.max(axis=-1): numpy's generic
    # reduction over a length-3 trailing axis is ~8x slower than the pairwise
    # form (95ms against 13ms on a 3900px frame), which is the difference
    # between this guard costing half the pass and costing a twentieth of it.
    peak = np.maximum(np.maximum(arr[..., 0], arr[..., 1]), arr[..., 2])
    np.maximum(peak, 1e-6, out=peak)
    np.minimum(ratio, np.reciprocal(peak), out=ratio)
    return np.clip(arr * ratio[..., None], 0.0, 1.0)


def _grain_pil(image: PILImage.Image, adj: dict) -> PILImage.Image:
    """Apply the film-grain pass to a PIL image at its *current* resolution."""
    g = adj.get("grain_amount", 0)
    if g <= 0:
        return image
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    arr = _apply_grain(arr, g, adj.get("grain_size", 25), adj.get("grain_roughness", 50))
    return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8), "RGB")


def _apply_local_adjustments(
    arr: np.ndarray, madj: dict, ref_long_edge: float | None = None
) -> np.ndarray:
    """Render a mask's local adjustments on a copy of the (already globally-toned)
    array: the spatial detail passes it can use (clarity/structure/sharpness/
    dehaze) plus the tonal/colour pass. Whole-image effects (grain, vignette,
    glow, mist) are global-only and never applied per mask."""
    full = develop.normalize(madj)
    long_edge = ref_long_edge or max(arr.shape[:2])
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
        arr = _dehaze(arr, dh, long_edge)
    return _adjust_array(arr, full)


def apply_masks(
    arr: np.ndarray, adj: dict, peek: str | None = None, view=None,
    ref_long_edge: float | None = None,
) -> tuple[np.ndarray, np.ndarray | None]:
    """Blend each mask's local adjustments into the image, weighted by the mask's
    generated field * opacity (inverted if the mask is inverted). Masks with no
    region or no non-default adjustment are skipped.

    `peek` names one mask whose *field* is handed back alongside the render (see
    paint_mask_peek). It is taken at the point that mask would be applied, so it
    is the selection the render actually used - not a re-derivation from the
    finished pixels, which for a luminance mask would be a different selection
    the moment the mask's own Exposure moved the tones it selects on. A peeked
    mask has its field computed even when it is hidden or carries no adjustment
    yet: a mask you are still setting up is exactly the one you need to see."""
    mask_list = adj.get("masks") or []
    if not mask_list:
        return arr, None
    peek_field: np.ndarray | None = None
    for mask in mask_list:
        if not mask.get("sub_masks"):
            continue
        wanted = peek is not None and str(mask.get("id") or "") == peek
        madj = mask.get("adjustments") or {}
        renders = mask.get("visible", True) and not develop.is_neutral(madj)
        if not renders and not wanted:
            continue
        field = masks.generate_mask_field(mask, arr, view)
        m = field * (mask.get("opacity", 100) / 100.0)
        if mask.get("invert"):
            m = 1.0 - m
        m = np.clip(m, 0.0, 1.0)
        if wanted:
            peek_field = m
        if not renders or float(m.max()) <= 0.0:
            continue
        adjusted = _apply_local_adjustments(arr.copy(), madj, ref_long_edge)
        m3 = m[..., None]
        arr = arr * (1.0 - m3) + adjusted * m3
    return np.clip(arr, 0.0, 1.0), peek_field


# The marking is the same pink candy-stripe the editor draws over a radial or a
# brush mask (MaskOverlay's zebra, #ff2d95 at 0.55 / 0.12): one visual language
# for "this is what the mask covers", whether the shape can be drawn as an
# outline or - luminance, colour, edges - only exists as pixels. Stripes rather
# than a wash because a flat pink over a pink sunset reads as part of the photo,
# and seeing the picture between the bars is what lets the boundary be judged.
_PEEK_RGB = np.array([1.0, 0.176, 0.584], dtype=np.float32)
_PEEK_BAR = 0.55
_PEEK_GAP = 0.12
# Stripe period as a fraction of the long edge, so the bars look the same width
# on screen whether the frame came from the scrub tier or a native render.
_PEEK_PERIOD_FRAC = 1 / 110


def paint_mask_peek(arr: np.ndarray, field: np.ndarray, view=None) -> np.ndarray:
    """Paint the zebra over the area `field` covers, its alpha following the
    field - so a feathered edge marks as a fade, not as a hard border.

    The stripes belong to the PHOTO, not to the array being painted: a zoomed
    tile (see masks.FieldView) sizes its period from the whole frame and phases
    its diagonal from the frame's origin, so the zebra on a tile is pixel-for-
    pixel the zebra the whole render would have put there."""
    h, w = field.shape
    x0, y0 = (view.x0, view.y0) if view is not None else (0, 0)
    full = max(view.full_w, view.full_h) if view is not None else max(h, w)
    period = max(4.0, full * _PEEK_PERIOD_FRAC)
    xs = (np.arange(w, dtype=np.float32) + x0)[None, :]
    ys = (np.arange(h, dtype=np.float32) + y0)[:, None]
    bar = ((xs + ys) % period) < (period * 0.5)  # 45 degrees, half bar / half gap
    a = (field * np.where(bar, _PEEK_BAR, _PEEK_GAP).astype(np.float32))[..., None]
    return np.clip(arr * (1.0 - a) + _PEEK_RGB * a, 0.0, 1.0)


# --- The editor preview's tone/denoise stage cache ---------------------------
#
# Every adjustment the pipeline reads STRICTLY AFTER the denoise pass. The cache
# key is the adjustment dict with exactly these removed, so dragging any of them
# reuses the stored stage while touching anything else recomputes it.
#
# The list is a denylist on purpose. A key that belongs here but is missing costs
# a cache miss - a slower frame, never a wrong one. The reverse (an allowlist of
# tone keys) would turn the same oversight into a stale render, which in an
# editor is the bug you never want. So: when in doubt, leave a key out.
_POST_DENOISE_KEYS = frozenset({
    # Detail (spatial)
    "clarity", "structure", "sharpness", "sharpness_threshold", "dehaze",
    "chromatic_aberration_red_cyan", "chromatic_aberration_blue_yellow",
    # Display colour block
    "film_sim", "lut_intensity", "curve_mode", "point_curves", "parametric_curve",
    "color_calibration", "hsl", "hsl_range", "hue", "chrome_effect", "chrome_blue",
    "color_grading", "saturation", "vibrance",
    # Local adjustments
    "masks",
    # Finishing effects + frame
    "mist", "glow_amount", "halation_amount", "flare_amount",
    "vignette_amount", "vignette_midpoint", "vignette_roundness", "vignette_feather",
    "grain_amount", "grain_size", "grain_roughness", "frame_width",
})

# One entry, not an LRU: a drag is one slider on one image at one tier, which is
# exactly the access pattern a single slot serves. An LRU of a few would multiply
# the biggest thing in the process - a 3900px float32 RGB frame is 122MB - by its
# depth, and this cache exists to make the editor cheaper, not fatter.
_tone_stage: tuple[str, np.ndarray] | None = None
_tone_stage_lock = threading.Lock()

# Don't store frames bigger than the ultra tier (122MB). The native 100%-zoom
# render is ~480MB per copy, where holding one to save a second of denoise is a
# bad trade against the rest of the process; it recomputes like it always did.
_TONE_STAGE_MAX_BYTES = 160 * 1024 * 1024


def _tone_stage_key(base_key: str, base_gain: float, adj: dict, fast: bool) -> str:
    pre = {k: v for k, v in adj.items() if k not in _POST_DENOISE_KEYS}
    # `fast` is part of the key because it decides whether denoise ran at all -
    # a scrub frame's stage and a settled frame's stage are different arrays.
    return json.dumps(
        [base_key, round(float(base_gain), 6), bool(fast), pre],
        sort_keys=True, separators=(",", ":"), default=str,
    )


def _tone_stage_get(key: str | None) -> np.ndarray | None:
    """The cached stage as a fresh writeable array, or None. Callers get a copy:
    the passes downstream are free to work in place, and the stored array has to
    survive being handed out repeatedly. The copy costs ~5ms at the settle tier
    against the ~360ms denoise it saves."""
    if key is None:
        return None
    with _tone_stage_lock:
        hit = _tone_stage
    if hit is None or hit[0] != key:
        return None
    return hit[1].copy()


def _tone_stage_put(key: str | None, arr: np.ndarray) -> None:
    global _tone_stage
    if key is None or arr.nbytes > _TONE_STAGE_MAX_BYTES:
        return
    stored = arr.copy()
    # Read-only so a future pass that starts writing in place fails loudly here
    # instead of quietly poisoning every later frame that reuses this stage.
    stored.flags.writeable = False
    with _tone_stage_lock:
        _tone_stage = (key, stored)


def invalidate_tone_stage() -> None:
    """Drop the stage cache (image edited on disk, decode settings changed)."""
    global _tone_stage
    with _tone_stage_lock:
        _tone_stage = None


def apply_adjustments(
    image: PILImage.Image, adj: dict, include_grain: bool = True, fast: bool = False
) -> PILImage.Image:
    """Display-referred entry point: bake the slider edits into an 8-bit image,
    or return the input untouched when everything is neutral (the common case -
    avoids a needless numpy pass). Decodes to linear (an 8-bit source has no
    highlight headroom, so base_gain is 1) and runs the shared linear pipeline."""
    if develop.is_neutral(adj):
        return image
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return apply_adjustments_linear(
        _srgb_to_linear(arr).astype(np.float32), 1.0, adj,
        include_grain=include_grain, fast=fast,
    )


def _denoise_stage(
    arr: np.ndarray, adj: dict, fast: bool, ref_short_edge: float | None = None
) -> np.ndarray:
    """Denoise (spatial), split into Luminance + Colour like RapidRAW - the two
    halves of high-ISO noise are removed by different amounts of smoothing
    (colour blotching is the ugly part and the eye barely resolves chroma
    detail, so chroma takes more without going soft), so they get a slider each.
    cv2's NLM needs 8-bit input, so this one pass round-trips through uint8.

    The one pass a drag never gets: the luma NLM alone is ~147ms on a 1100px
    scrub frame, which would drop the preview to under 7 frames a second. It's
    also the pass a downscaled preview can say least about - by 1100px a 7752px
    raw has had its sensor noise averaged away, so what a live frame would show
    is smoothing applied to already-smooth data. Denoise is judged at 100%
    zoom, where the ladder renders natively and the pixels are real."""
    ln = adj.get("luma_noise_reduction", 0)
    cn = adj.get("color_noise_reduction", 0)
    if fast or (ln <= 0 and cn <= 0):
        return arr
    denoised = _denoise_image(
        PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8), "RGB"), ln, cn, ref_short_edge
    )
    return np.asarray(denoised, dtype=np.float32) / 255.0


def apply_adjustments_linear(
    lin: np.ndarray, base_gain: float, adj: dict, include_grain: bool = True, fast: bool = False,
    tone_cache_key: str | None = None, peek: str | None = None, view=None,
    is_stale: Callable[[], bool] | None = None,
) -> PILImage.Image:
    """The develop pipeline on a scene-referred linear float base (the RAW
    demosaic, values may exceed 1.0 after the gain).

    Order: linear tone block (gain/WB/tone sliders/tonemap - always runs, since
    even neutral edits need the base gain + shoulder applied) -> denoise ->
    detail (clarity/structure/sharpen/CA/dehaze, judged on the *toned* image the
    way Lightroom does - noise and edges look the same as what's on screen) ->
    display colour block -> masks -> finishing effects.

    `tone_cache_key` names the exact array this render starts from (base +
    geometry). Passing one lets the tone block and denoise be reused across
    renders that differ only below them - the editor preview passes one, exports
    and thumbnails don't, since they render each frame once. It changes nothing
    about the output: the cut is at a point where the two passes above depend on
    their own sliders and nothing else (see _POST_DENOISE_KEYS).

    `view` (a masks.FieldView) says which tile of the frame `lin` is, for the
    editor's zoomed render: everything positional - the masks and the vignette -
    then keeps computing against the whole frame while only the tile's pixels
    are produced. The default is the whole frame, which is every other caller.

    `include_grain=False` skips the grain pass so the caller can add grain
    *after* downscaling to the output size (see generate_derivatives): grain
    baked at full resolution gets averaged away by the LANCZOS downscale to the
    preview/thumbnail, so what you saw in the editor vanished after saving.

    `fast=True` is the interactive *scrub* pipeline used while a control is being
    dragged. It runs everything it can afford at scrub resolution and skips only
    the four passes that cannot keep up.

    Measured on a 1100px scrub frame of a 40MP raw, as marginal cost over the
    25ms tone-only floor:

        grain +4   sharpness +5   chromatic aberration +5   vignette +6
        clarity +28   structure +29   mist +34   halation +39   dehaze +42
        ----------------------------------------------------- runs while dragging
        flare +84   glow +143   denoise +147

    Mist used to sit below that line at +145, back when the diffusion pass was
    one wide full-resolution Gaussian. Rebuilt as a reduced-resolution box-blur
    PSF (see _MIST_PSF) it costs about a fifth of that: measured on one frame
    against halation, which is in the table above and does run during a drag,
    mist lands just under it - hence the +34 here, scaled into the same units
    rather than re-measured in them. It is a slider you have to *see* to set,
    so being able to afford it live matters more for it than for most.

    Everything above the line runs during a drag. It used to be skipped wholesale
    for being "a convolution", which meant dragging Clarity or Structure changed
    nothing on screen until the pointer came up - a slider whose effect you
    cannot see while you move it is not a slider you can set, and no amount of
    frame rate makes up for that. Each of those passes is also gated on its own
    value being non-zero, so an edit that doesn't use them pays nothing.

    Below the line stays out: at ~150ms a frame the preview would stop tracking
    the pointer, which just trades one kind of unusable for another. Those four
    come back on the accurate render at pointer-up, so the settled preview - and
    the save - are unchanged either way."""
    # Every resolution-dependent radius below is measured against the WHOLE
    # frame, never the array in hand. A zoomed tile IS a smaller array of the
    # same photo: scaling clarity, sharpening or denoise to the tile would
    # develop it differently from the frame it is standing in for, and the user
    # would watch the look change as the native render swapped in.
    ref_h, ref_w = (view.full_h, view.full_w) if view is not None else lin.shape[:2]
    long_edge = max(ref_h, ref_w)
    short_edge = min(ref_h, ref_w)
    if develop.is_neutral(adj) and peek is None:
        # Nothing but the neutral rendering (gain + shoulder) to do. Checked
        # before the cache so a neutral edit can never take a cached stage and
        # fall through the rest of the pipeline instead of returning here.
        arr = _linear_tone_block(lin, adj, base_gain)
        return PILImage.fromarray((arr * 255.0 + 0.5).astype(np.uint8), "RGB")

    # Tone + denoise depend on their own sliders and nothing else, so when
    # `tone_cache_key` names the base being rendered (the editor preview passes
    # one; exports and thumbnails don't) the result is reusable. That is what
    # makes a Clarity drag cheap: it re-runs the detail pass and downwards, not
    # the ~360ms denoise sitting above it. See _POST_DENOISE_KEYS for the split.
    # `is_stale` (the editor preview passes one) lets a superseded render bail
    # between passes instead of finishing: the client aborts its fetch the
    # moment a newer edit state exists, but the numpy passes of an already
    # started settle render used to run to completion anyway - 2-3s of CPU and
    # memory bandwidth competing with the very scrub frames the user is
    # waiting on. Checked between the expensive stages, where a bail is free.
    def _abort_if_stale() -> None:
        if is_stale is not None and is_stale():
            raise PreviewSuperseded()

    key = _tone_stage_key(tone_cache_key, base_gain, adj, fast) if tone_cache_key else None
    arr = _tone_stage_get(key)
    if arr is None:
        arr = _linear_tone_block(lin, adj, base_gain)
        arr = _denoise_stage(arr, adj, fast, short_edge)
        _tone_stage_put(key, arr)
    _abort_if_stale()
    # Detail (spatial): clarity = large-radius local contrast, structure =
    # medium-radius local contrast, sharpness = small-radius edge enhancement.
    # These run during a drag too - they're the ones you most need to see move
    # while you set them, and at scrub size they cost tens of ms (see the
    # `fast` note in the docstring).
    cl = adj.get("clarity", 0)
    if cl:
        arr = _clarity(arr, max(4.0, long_edge / 50.0), cl / 100.0 * 1.3)
        if cl < 0:
            # Fuji's negative clarity doesn't just flatten - it diffuses like a
            # Pro-Mist filter (soft halation around brights). Layer a gentle
            # whole-highlight glow (not the light-source-only Mist) on top of the
            # band softening; strength follows the slider.
            #
            # This ran only on the pointer-up render while the diffusion pass was
            # the most expensive thing in the pipeline: dragging Clarity leftward
            # dropped the preview from ~28 frames a second to ~5 while every
            # other slider stayed fluid, so the softening tracked the pointer and
            # the glow arrived afterwards. The rebuilt pass (see _MIST_PSF) is
            # cheap enough to keep up, so the two halves of the look now move
            # together - which is the point, since the softening on its own
            # doesn't look like what the slider is going to settle at.
            arr = _mist(arr, min(50, int(-cl * 0.35)), light_sources=False,
                        ref_long_edge=long_edge)
    st = adj.get("structure", 0)
    if st:
        arr = develop_effects.apply_structure(arr, st)
    sp = adj.get("sharpness", 0)
    if sp:
        # +sharpen / -soften share the unsharp formula (negative amount blends
        # toward the blur). Radius is capped so sharpening stays a fine, tight
        # edge enhancement; Threshold gates it away from noise/smooth areas.
        arr = _unsharp(
            arr, min(2.0, max(0.6, long_edge / 2000.0)), sp / 100.0 * 1.2,
            threshold=adj.get("sharpness_threshold", 0),
        )
    ca_rc = adj.get("chromatic_aberration_red_cyan", 0)
    ca_by = adj.get("chromatic_aberration_blue_yellow", 0)
    if ca_rc or ca_by:
        arr = develop_effects.apply_chromatic_aberration(arr, ca_rc, ca_by)
    _abort_if_stale()
    # Dehaze is spatial too (transmission map from the dark channel), so it runs
    # here rather than in the per-pixel tonal pass.
    dh = adj.get("dehaze", 0)
    if dh:
        arr = _dehaze(arr, dh, long_edge)
    arr = _display_color_block(arr, adj)
    # Local (per-region) mask adjustments layer on the globally-toned image,
    # before the global finishing effects (bloom/vignette/grain).
    _abort_if_stale()
    arr, peek_field = apply_masks(arr, adj, peek=peek, view=view, ref_long_edge=long_edge)
    # Highlight-bloom / diffusion effects run on the *toned* image (like a filter
    # in front of the lens), after the tonal pass. Mist and halation are
    # affordable at scrub size (+34/+39ms); glow and flare are not (+143/+84),
    # so those two sit out a drag and are restored on the pointer-up render.
    _abort_if_stale()
    if adj.get("mist", 0) > 0:
        arr = _mist(arr, adj["mist"], ref_long_edge=long_edge)
    if not fast and adj.get("glow_amount", 0) > 0:
        arr = develop_effects.apply_glow(arr, adj["glow_amount"])
    if adj.get("halation_amount", 0) > 0:
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
            view=view,
        )
    _abort_if_stale()
    if include_grain and adj.get("grain_amount", 0) > 0:
        arr = _apply_grain(arr, adj["grain_amount"], adj.get("grain_size", 25), adj.get("grain_roughness", 50))
    # Last of all, so the marking is the flat pink it was meant to be rather than
    # something the vignette darkened and the grain crawled over.
    if peek_field is not None:
        arr = paint_mask_peek(arr, peek_field, view=view)
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


def _browsing_gain(base_gain: float, adjustments: dict | None) -> float:
    """Auto-exposure gain for the BROWSING/output renders (grid thumbnail,
    lightbox preview + its 100% full.jpg, exported copy).

    An UNEDITED raw is auto-exposed (base_gain) so it's usable while browsing -
    DR-mode files demosaic 2-3 stops dark and would be near-black otherwise.
    Once the photo carries ANY edit, the exposure the user dialled in the (native)
    editor is authoritative: drop the browsing lift back to the un-lifted base
    (gain 1.0) so grid/lightbox match exactly what the editor showed. This is the
    deliberate consequence the user accepted - a crop-only edit on a dark raw
    stops auto-exposing it. JPEG/PNG bases are already gain 1.0, so unaffected."""
    if adjustments is None or develop.is_neutral(adjustments):
        return base_gain
    return 1.0


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
    slot_timeout: float | None = None,
) -> PILImage.Image:
    """Writes thumbnail.jpg (grid) and preview.jpg (lightbox) for an image, and
    returns the decoded full-resolution base image (before edits) so a caller
    can reuse it (e.g. for the CLIP embedding) instead of decoding the RAW again.

    `slot_timeout` bounds the wait for a render slot and for another thread
    already generating this same image; raises RenderBusy when it runs out (see
    _render_admission). None - the default, used by the background workers -
    waits as long as it takes.

    Browsers can't render RAW files directly, so for RAW sources preview.jpg
    is the only viewable representation - it's a true demosaic (not the
    camera's embedded JPEG thumbnail, which would carry the camera's own
    color rendering - see extract_full_preview()), then the user's manual
    rotation/crop (if any) is layered on top before resizing.
    """
    with _locked(_gen_lock(image_id), slot_timeout), _render_admission(slot_timeout):
        out_dir = derivative_dir(image_id)
        # Both outputs are capped (PREVIEW_RENDER_MAX_PX / THUMBNAIL_MAX_PX), yet
        # a 26MP camera JPEG used to be decoded and pushed through the whole
        # float32 pipeline at full size just to be thrown away by the resizes
        # below - ~4x the pixels of the RAW path for the same result, and the
        # biggest single memory cost of an import. Ask for only what the outputs
        # need. A crop divides the budget, so cropped photos keep their
        # resolution; RAW is unaffected (its half_size demosaic already is the
        # budget) and so renders byte-identically to before.
        crop_span = min(crop[2], crop[3]) if crop else 1.0
        decode_px = math.ceil(PREVIEW_RENDER_MAX_PX / max(crop_span, 0.02))
        lin, gain = raw_service.load_linear_base(
            source_path, half_size=True, max_px=decode_px
        )
        # thumbnail.jpg is a fraction of the decoded frame, so a reduced decode
        # would silently shrink it - scale the fraction back up by the reduction
        # that actually happened, keeping the grid thumbnail the size it has
        # always been.
        thumb_scale = THUMBNAIL_SCALE * raw_service.decode_reduction(source_path, lin.shape)
        # The un-edited display rendering, built before geometry: returned to the
        # caller so the post-import worker can feed CLIP without a second decode.
        base = PILImage.fromarray(raw_service.default_tone_to_srgb(lin, gain))
        if distortion:
            lin = apply_distortion_array(lin, distortion)
        lin = apply_edits_array(lin, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
        # Grain is added per-derivative below, *after* the downscale - baked at
        # full res it would just be averaged away by the resize.
        source = apply_adjustments_linear(
            lin, _browsing_gain(gain, adjustments), adjustments if adjustments else develop.normalize({}),
            include_grain=False,
        )
        del lin

        # The lightbox preview is capped at PREVIEW_RENDER_MAX_PX (the true
        # 100%-zoom pixels come from full.jpg, rendered at full sensor
        # resolution on demand - see generate_full).
        preview = source.copy()
        preview.thumbnail((PREVIEW_RENDER_MAX_PX, PREVIEW_RENDER_MAX_PX), PILImage.LANCZOS)
        if adjustments:
            preview = _grain_pil(preview, adjustments)
            preview = add_frame(preview, adjustments)
        _save_atomic(preview, out_dir / "preview.jpg", quality=92)

        thumb = source.copy()
        # Grid thumbnail at a quarter of the original's dimensions (a lot cheaper to
        # generate than a large fixed size, so a full-library rebuild stays quick),
        # capped so huge originals don't still produce oversized thumbnails.
        tw = min(THUMBNAIL_MAX_PX, max(1, round(thumb.width * thumb_scale)))
        th = min(THUMBNAIL_MAX_PX, max(1, round(thumb.height * thumb_scale)))
        thumb.thumbnail((tw, th), PILImage.LANCZOS)
        if adjustments:
            thumb = _grain_pil(thumb, adjustments)
            thumb = add_frame(thumb, adjustments)
        _save_atomic(thumb, out_dir / "thumbnail.jpg", quality=88)

        # small.jpg is derived from the finished thumbnail (grain/frame
        # included), so the dense grid sizes show exactly the same rendering,
        # just fewer pixels. Written here so an edit can never leave a stale
        # small tier behind a fresh thumbnail.
        small = thumb.copy()
        small.thumbnail((SMALL_MAX_PX, SMALL_MAX_PX), PILImage.LANCZOS)
        _save_atomic(small, out_dir / "small.jpg", quality=85)

        # The full-resolution derivative (for 100% zoom) is now stale - drop it so it
        # is regenerated on next request with the new edits.
        (out_dir / "full.jpg").unlink(missing_ok=True)
        return base


def has_derivatives(image_id: str) -> bool:
    out_dir = settings.thumbnail_cache_root / image_id
    return (out_dir / "thumbnail.jpg").exists() and (out_dir / "preview.jpg").exists()


def ensure_derivatives(image: "Image", slot_timeout: float | None = None) -> None:
    """Generate thumbnail/preview only if they're missing. Used by the serve
    path: if the post-import worker is generating this image right now, this
    blocks until it's done and then skips the (now redundant) regeneration
    instead of decoding the same photo a second time.

    `slot_timeout` is passed straight through to generate_derivatives, so a
    request handler can bound its wait and get RenderBusy rather than occupying
    a server thread through someone else's render."""
    with _locked(_gen_lock(image.id), slot_timeout):
        if has_derivatives(image.id):
            return
        regenerate_for_image(image, slot_timeout=slot_timeout)


def ensure_small(image: "Image", slot_timeout: float | None = None) -> Path:
    """Path to small.jpg (the XS/S grid tier), deriving it on demand.

    generate_derivatives writes it alongside thumbnail.jpg, but libraries from
    before the tier existed - and photos whose derivatives were moved into
    place by an import commit or a library merge - only have thumbnail.jpg.
    Downscaling that existing file is a few milliseconds and needs no render
    slot; only a photo with no thumbnail at all falls back to the full
    on-demand render (where RenderBusy applies as usual)."""
    dest = derivative_path(image.id) / "small.jpg"
    if dest.exists():
        return dest
    with _locked(_gen_lock(image.id), slot_timeout):
        if dest.exists():
            return dest
        thumb_path = derivative_path(image.id) / "thumbnail.jpg"
        if not thumb_path.exists():
            regenerate_for_image(image, slot_timeout=slot_timeout)
            # generate_derivatives writes small.jpg too.
            if dest.exists():
                return dest
        with PILImage.open(thumb_path) as thumb_file:
            small = thumb_file.convert("RGB")
        small.thumbnail((SMALL_MAX_PX, SMALL_MAX_PX), PILImage.LANCZOS)
        _save_atomic(small, derivative_dir(image.id) / "small.jpg", quality=85)
    return dest


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
# while a slider/curve/wheel/mask handle is being dragged. Smaller than the
# accurate tier, because the whole pipeline (and the JPEG encode) scales with
# pixel count and these frames have to keep up with the pointer; together with
# the fast pipeline that skips the convolution passes (see
# apply_adjustments(fast=True)) each one lands in tens of ms. Replaced by the
# accurate 1600px render the moment the pointer is released.
#
# Measured on a 40MP raw, warm base: 750px = 16ms/frame, 1100px = 35ms, 1300px =
# 50ms, 1600px = 75ms. 750 was leaving most of the budget unspent - a drag frame
# blown up from 750px to a ~1400px canvas is a near-2x upscale, which is what
# made the picture go visibly soft the instant a slider was touched. 1100 is
# 2.2x the pixels for 19ms more, still ~28 renders a second, and lands close
# enough to the displayed size that the softening stops reading as a quality
# drop. Derived by downscaling the 1600px base (see _cached_editor_base), so it
# costs no extra decode.
SCRUB_PREVIEW_PX = 1100

# Resolution for the settled "refinement" render. NOT the image's true full
# resolution: a live preview at 40-60MP turns every numpy pass in the pipeline
# (each a float32 RGB array of the whole frame, several live at once through
# dehaze/clarity/denoise) into hundreds of MB, and several settle-renders
# overlapping in the request threadpool stacked into multiple GB and wedged the
# app. Capped here instead - the resolution-dependent passes (grain, sharpen,
# denoise, clarity radii) all scale with the long edge, so they *look* the same
# at this size as at full res, which is the whole point of the refinement pass.
FULL_EDITOR_PREVIEW_PX = 2600

# One step above the settle tier, for when 2600px is genuinely being shown
# upscaled - a hi-dpi screen at fit view, or a moderate zoom. Sized to what the
# HALF-SIZE demosaic already produces: a 40MP raw halves to 3876px, so this tier
# costs no extra decode at all (measured: 1.07s for the half-size decode either
# way), only the pipeline's own scaling with pixel count - about 2.2s against
# 1.0s at 2600. That is the whole reason it exists: it hands back detail the
# decode had already paid for and the old ladder threw away, and it means the
# jump from "soft" to "sharp" no longer has to go via the native render, which
# is 13.6s of decode plus 18.4s of pipeline on the same file.
#
# Files whose half-size decode lands below this just come back at their own
# size (_downscale_linear is a no-op when it's already smaller), so this is a
# ceiling, never an upscale.
ULTRA_EDITOR_PREVIEW_PX = 3900

# Only one settled full-quality render at a time. It's the memory-heavy path, so
# serialising it keeps peak RAM to a single pipeline's worth even when a flurry
# of slider settles each kick one off (the stale ones are aborted client-side,
# but a numpy pass already running can't be interrupted).
# Reentrant so generate_full/export_jpeg_bytes can hold it across their
# "did a concurrent render already land full.jpg?" recheck while the render
# they then call (render_edited_image) re-acquires it.
logger = logging.getLogger(__name__)

_full_render_lock = threading.RLock()


class PreviewSuperseded(Exception):
    """A newer editor-preview request for the same image arrived while this one
    was waiting (typically queued on _full_render_lock). The client has already
    aborted its fetch, so rendering would only burn CPU - the caller turns this
    into an empty 409."""


def _downscale_linear(arr: np.ndarray, max_px: int) -> np.ndarray:
    """Downscale a linear float array so its long edge is <= max_px. INTER_AREA
    in linear light is the physically correct average (LANCZOS on sRGB values
    darkened fine detail slightly)."""
    h, w = arr.shape[:2]
    scale = max_px / max(h, w)
    if scale >= 1.0:
        return arr
    nw = max(1, round(w * scale))
    nh = max(1, round(h * scale))
    return cv2.resize(arr.astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA)


# The decoded bases, newest last. An explicit cache rather than lru_cache
# because the interesting question is not "is THIS size cached" but "is a BIGGER
# one" - see _cached_editor_base.
_BASE_CACHE: "OrderedDict[tuple[str, str, int, int], tuple[np.ndarray, float]]" = OrderedDict()
_BASE_CACHE_MAX = 12
_base_cache_lock = threading.Lock()
# Bases being computed right now, so a second asker waits instead of decoding
# the same thing beside the first. Guarded by _base_cache_lock.
_BASE_INFLIGHT: dict[tuple[str, str, int, int], threading.Event] = {}


def _base_cache_clear() -> None:
    with _base_cache_lock:
        _BASE_CACHE.clear()


def _cached_editor_base(image_id: str, path_str: str, mtime_ns: int, max_px: int) -> tuple[np.ndarray, float]:
    """The decoded, downscaled LINEAR base (float16 array + auto-exposure gain)
    the editor preview renders on top of. Cached so slider moves only re-run the
    edit pipeline, not the (expensive) decode. Keyed by file mtime so an on-disk
    change invalidates; the native-decode settings toggle clears the whole cache
    (see api/routes/settings.py). float16 halves the cache RAM and still beats a
    16-bit-integer base for shadow precision; the array is marked read-only -
    callers convert to float32, which copies.

    A size that is not cached is DERIVED from any larger cached base of the same
    file rather than decoded again. That is what makes the editor's quality
    ladder cheap: measured on a 27MP JPEG, decoding the 2600px base costs 753ms
    and the 3900px one 2924ms, while the pipeline on top of a warm base is
    143ms and 510ms. Climbing the ladder used to pay a fresh decode per rung -
    seconds of nothing happening between two frames that each take a fraction of
    that to render. Downscaling a base already in hand costs milliseconds.
    """
    key = (image_id, path_str, mtime_ns, max_px)
    # Single-flight: one decode per base, however many ask for it. Without this
    # the editor's open sequence really did the work twice - the first frame and
    # the compare original both wanted the same base and each ran the full
    # decode, and the background warm-up could decode the very size a settle was
    # about to ask for. Seen in the field as two "accurate" renders of 2.3s each
    # for a base that costs 150ms warm. Whoever registers first computes; the
    # rest wait on the event and read the cache.
    while True:
        with _base_cache_lock:
            hit = _BASE_CACHE.get(key)
            if hit is not None:
                _BASE_CACHE.move_to_end(key)
                return hit
            in_flight = _BASE_INFLIGHT.get(key)
            if in_flight is None:
                done = threading.Event()
                _BASE_INFLIGHT[key] = done
                bigger_key = min(
                    (k for k in _BASE_CACHE if k[:3] == key[:3] and k[3] > max_px),
                    key=lambda k: k[3],
                    default=None,
                )
                source = _BASE_CACHE.get(bigger_key) if bigger_key is not None else None
                break
        # Outside the lock, or nobody could ever finish. A lapsed wait falls
        # through to the loop, which re-checks the cache and, if the computer
        # died without delivering, takes over the job itself.
        in_flight.wait(timeout=60)

    try:
        out = _compute_editor_base(image_id, path_str, mtime_ns, max_px, source)
        with _base_cache_lock:
            _BASE_CACHE[key] = out
            _BASE_CACHE.move_to_end(key)
            while len(_BASE_CACHE) > _BASE_CACHE_MAX:
                _BASE_CACHE.popitem(last=False)
        return out
    finally:
        # On success and on failure alike: waiters must wake either way, and a
        # failed compute leaves no in-flight entry to dangle behind it.
        with _base_cache_lock:
            _BASE_INFLIGHT.pop(key, None)
        done.set()


def _compute_editor_base(
    image_id: str,
    path_str: str,
    mtime_ns: int,
    max_px: int,
    source: tuple[np.ndarray, float] | None,
) -> tuple[np.ndarray, float]:
    if source is None and max_px == SCRUB_PREVIEW_PX:
        # Nothing bigger yet: decode the interactive size and come down from it,
        # never the scrub size on its own. The decode is the same price either
        # way and this one is about to be needed anyway.
        source = _cached_editor_base(image_id, path_str, mtime_ns, EDITOR_PREVIEW_PX)

    if source is not None:
        base, gain = source
        out_arr = _downscale_linear(base.astype(np.float32), max_px).astype(np.float16)
    else:
        # max_px is also the decode budget (see load_linear_base): the base is
        # about to be downscaled to it anyway, so decoding a 26MP JPEG at full
        # size first only cost memory. Keeps this base consistent with the one
        # generate_derivatives / render_base_preview_bytes build.
        lin, gain = raw_service.load_linear_base(Path(path_str), half_size=True, max_px=max_px)
        out_arr = _downscale_linear(lin, max_px).astype(np.float16)
    out_arr.flags.writeable = False
    return (out_arr, gain)


# Kept as an attribute so every existing caller (and test) that clears the cache
# through the function still works.
_cached_editor_base.cache_clear = _base_cache_clear


# The editor's largest preview base, decoded ahead of being asked for.
#
# The quality ladder climbs to bigger bases as the user stops moving, and each
# rung used to pay its own decode in the middle of the editing session -
# measured on a 27MP JPEG, 753ms for the 2600px base and 2924ms for the 3900px
# one, against 143ms and 510ms for the pipeline that runs on top of them. So the
# decode does not belong in the ladder at all: it happens once, on a background
# thread, from the moment the image is opened. Every rung then derives its base
# from that one (see _cached_editor_base) and costs only its pipeline.
_warm_lock = threading.Lock()
_warming: set[str] = set()


# How long the warm-up holds back before it starts decoding. The frame that was
# just asked for is what the user is waiting on, and the decode is a CPU hog
# that would otherwise race it: measured on a 27MP JPEG, warming during the
# first render pushed that render from 755ms to 1425ms. Waiting until it is
# delivered costs the warm-up nothing - it has seconds before the ladder wants
# its result.
_WARM_DELAY_S = 0.35


def warm_editor_base(image_id: str, path_str: str, mtime_ns: int) -> None:
    """Decode the biggest preview base for this image in the background.

    Cheap to call on every preview request: it returns at once if the base is
    already there or is on its way. One thread per image, and the work is the
    decode the ladder would otherwise do while the user waits."""
    key = f"{image_id}:{mtime_ns}"
    top = ULTRA_EDITOR_PREVIEW_PX
    with _base_cache_lock:
        if (image_id, path_str, mtime_ns, top) in _BASE_CACHE:
            return
    with _warm_lock:
        if key in _warming:
            return
        _warming.add(key)

    def run() -> None:
        try:
            time.sleep(_WARM_DELAY_S)
            _cached_editor_base(image_id, path_str, mtime_ns, top)
        except Exception:
            # A failed warm-up costs nothing: the ladder decodes as it always
            # did. Not worth a stack trace in the log for a photo that is
            # probably just unreadable at the moment.
            logger.debug("editor base warm-up failed for %s", image_id, exc_info=True)
        finally:
            with _warm_lock:
                _warming.discard(key)

    threading.Thread(target=run, name="editor-base-warm", daemon=True).start()


# The editor's true-100%-zoom base: the full-resolution linear decode, held for
# exactly ONE image at a time (a 26-40MP float16 frame is 150-250MB, so an LRU
# of several would dwarf the rest of the process). Guarded by _full_render_lock:
# every native render already serialises on it, so the cache needs no lock of
# its own. Keyed by mtime like _cached_editor_base so on-disk changes invalidate.
_native_editor_base: tuple[str, int, np.ndarray, float] | None = None


# Serialises the full-resolution decode itself - and nothing else. It is NOT
# _full_render_lock on purpose: the decode runs 6-20s, and holding the render
# lock for it meant every settled preview queued behind a background warm-up.
# The warm-up was built so nobody waits on this decode; a lock shared with the
# renders quietly rebuilt exactly that wait.
_native_decode_lock = threading.Lock()


def _cached_native_base(image_id: str, path_str: str, mtime_ns: int) -> tuple[np.ndarray, float]:
    global _native_editor_base
    hit = _native_editor_base
    if hit and hit[0] == image_id and hit[1] == mtime_ns:
        return hit[2], hit[3]
    with _native_decode_lock:
        # Someone else may have finished this exact decode while we waited.
        hit = _native_editor_base
        if hit and hit[0] == image_id and hit[1] == mtime_ns:
            return hit[2], hit[3]
        _native_editor_base = None  # free the old frame before decoding the next
        lin, gain = raw_service.load_linear_base(Path(path_str), half_size=False)
        out = lin.astype(np.float16)
        out.flags.writeable = False
        _native_editor_base = (image_id, mtime_ns, out, gain)
        return out, gain


_native_warm_lock = threading.Lock()
_native_warming: set[str] = set()


def editor_mtime_ns(image: "Image") -> int:
    """The file mtime the base caches are keyed by, for callers that only want
    to ask whether something is cached. 0 when the file cannot be reached -
    which simply means "not cached", the safe answer everywhere it is used."""
    from app.services.filesystem import resolve_image_path

    try:
        return resolve_image_path(image).stat().st_mtime_ns
    except OSError:
        return 0


def native_base_ready(image_id: str, mtime_ns: int) -> bool:
    hit = _native_editor_base
    return bool(hit and hit[0] == image_id and hit[1] == mtime_ns)


def warm_native_base(image_id: str, path_str: str, mtime_ns: int) -> None:
    """Decode the full-resolution base in the background.

    Nobody may be made to wait for this decode: it is 8s on a 27MP JPEG and 20s
    on a 40MP raw, and it used to run inside _full_render_lock - so the first
    zoomed render blocked every other settled render behind it for that whole
    time, which is what "the editor freezes when I zoom in" was. The render that
    triggered it is served from the preview tier instead (see
    render_editor_preview_bytes) and the true native tile follows once this
    lands."""
    key = f"{image_id}:{mtime_ns}"
    if native_base_ready(image_id, mtime_ns):
        return
    with _native_warm_lock:
        if key in _native_warming:
            return
        _native_warming.add(key)

    def run() -> None:
        try:
            # The zoom that starts this warm-up is answered with an ultra render
            # in the same breath - and a 40MP decode running beside it slowed
            # that very answer from ~3s to ~7s (both are memory-bound). So: let
            # the render in flight finish first. Taking the render lock and
            # dropping it again is exactly that wait, without holding anything
            # while the decode itself runs - the mistake this thread used to
            # make in the other direction.
            time.sleep(0.2)
            with _full_render_lock:
                pass
            # Deliberately NOT under _full_render_lock: the whole point of this
            # thread is that preview renders keep flowing while it decodes.
            # _native_decode_lock inside makes concurrent decodes impossible.
            _cached_native_base(image_id, path_str, mtime_ns)
        except Exception:
            logger.debug("native base warm-up failed for %s", image_id, exc_info=True)
        finally:
            with _native_warm_lock:
                _native_warming.discard(key)

    threading.Thread(target=run, name="native-base-warm", daemon=True).start()


def clear_editor_base_caches() -> None:
    """Drop every cached editor base (preview-sized LRU + the native frame).
    Called when a setting that changes the decode itself flips."""
    global _native_editor_base
    _cached_editor_base.cache_clear()
    _native_editor_base = None
    # The tone/denoise stage was computed from one of those bases, so it has to
    # go with them - its own key can't see a decode setting change.
    invalidate_tone_stage()


def render_editor_preview_bytes(
    image: "Image",
    rotation: int,
    crop: CropBox | None,
    adjustments: dict,
    distortion: int = 0,
    max_px: int = EDITOR_PREVIEW_PX,
    full_quality: bool = False,
    scrub: bool = False,
    ultra: bool = False,
    native: bool = False,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
    browse: bool = False,
    peek: str | None = None,
    region: tuple[float, float, float, float] | None = None,
    meta: dict | None = None,
    zoomed: bool = False,
    is_stale: Callable[[], bool] | None = None,
) -> bytes:
    """Render the editor's live preview server-side: the exact save pipeline
    (same code path as generate_derivatives/render_edited_image) on a cached,
    preview-sized base. One pipeline = the preview IS the saved look - no
    JS mirror to drift out of sync.

    Three render tiers, all one pipeline:
    - `scrub=True`: the frames drawn continuously while a control is dragged -
      a small SCRUB_PREVIEW_PX base with the convolution passes skipped
      (apply_adjustments(fast=True)). Cheap enough to keep the drag fluid.
      With `zoomed=True` it renders on the accurate tier's base instead: the
      user is inspecting detail, and the small base upscaled past 4x reads as
      blocks.
    - default: the accurate EDITOR_PREVIEW_PX render drawn the moment a drag
      ends (full pipeline).
    - `full_quality=True`: renders on a larger (but still bounded, see
      FULL_EDITOR_PREVIEW_PX) base - too slow for live drags, but fetched once
      the sliders settle so resolution-dependent passes (denoise radius, sharpen
      radius, grain) are previewed at the size they'll look like when saved.
    - `ultra=True`: one step above that (ULTRA_EDITOR_PREVIEW_PX), for when the
      settle tier is still being shown upscaled. Costs no extra decode - it's
      the size the half-size demosaic already produces - so the editor walks up
      to it before ever considering the native render.
    - `native=True`: the TRUE full-resolution render (full RAW demosaic), for
      100% zoom in the editor. Far too slow for anything live - the editor
      fetches it in the background once edits rest while zoomed in, exactly like
      the lightbox swaps in full.jpg. Serialised like the full tier; the decoded
      full-res base is kept for one image (_cached_native_base) so only the
      first zoomed render of an image pays the demosaic.

    `peek` names a mask to mark in the returned frame (see paint_mask_peek) -
    the editor's "show me what this mask covers" for the masks that have no
    shape to outline. It rides along on the render instead of being a call of
    its own, so the marking tracks the sliders on the very frames the preview
    is already drawing."""
    from app.services.filesystem import resolve_image_path

    # Drop superseded renders instead of running them: the client aborts its
    # fetch the moment a newer edit state exists, but an aborted request's
    # thread still runs to completion here. The check matters most right after
    # acquiring _full_render_lock - that's where seconds-long full/native
    # renders queued up during a busy editing session and kept the CPU pinned
    # long after anyone wanted their result.
    def _bail_if_stale() -> None:
        if is_stale is not None and is_stale():
            raise PreviewSuperseded()

    _bail_if_stale()
    path = resolve_image_path(image)
    if region is not None and not region_is_supported(adjustments):
        region = None
    # The interactive tiers (scrub and the accurate render) honour a region too,
    # cut from the decoded native base: zoomed far in, a whole 1600px frame
    # stretched across the viewport is mush, while the visible part of the
    # native frame is a few hundred pixels a side - sharper AND cheaper. Only
    # when it is genuinely cheap, though: the native base must already be
    # decoded (the settle's native request warms it; these frames are being
    # waited on and must not) and no geometry op may be active (with one,
    # mapping the tile back into the base is not a slice and costs seconds -
    # worse than the whole-frame tier it replaces). Peek rides along fine: the
    # mask field and the zebra are both computed against the whole frame (see
    # FieldView / paint_mask_peek). The full/ultra refinements are whole-frame
    # by design.
    if region is not None and not native:
        geometry_moves = bool(
            distortion or rotation or crop or flip_h or flip_v or straighten or persp_h or persp_v
        )
        if (
            full_quality
            or ultra
            or geometry_moves
            or not native_base_ready(image.id, path.stat().st_mtime_ns)
        ):
            region = None

    # Asking for native before its base exists would mean waiting out the whole
    # decode with the render lock held. Start it in the background and answer
    # with the tier below, which is on screen in a fraction of the time; the
    # caller is told what it actually got (see served_tier) and comes back for
    # the real thing once the base is there.
    if native and not native_base_ready(image.id, path.stat().st_mtime_ns):
        warm_native_base(image.id, str(path), path.stat().st_mtime_ns)
        native = False
        ultra = True
        region = None

    _bail_if_stale()
    if native:
        with _full_render_lock:
            _bail_if_stale()
            return _render_editor_bytes(
                image, path, 0, rotation, crop, adjustments, distortion,
                flip_h, flip_v, straighten, persp_h, persp_v, quality=90, fast=False, native=True,
                region=region, meta=meta,
                browse=browse, peek=peek, is_stale=is_stale,
            )
    if region is not None:
        # The interactive tile (see the gate above): scrub or accurate quality,
        # cut from the native base. Deliberately NOT under _full_render_lock -
        # the tile is small, the base is shared read-only, and these frames must
        # not queue behind a seconds-long settle render.
        return _render_editor_bytes(
            image, path, 0, rotation, crop, adjustments, distortion,
            flip_h, flip_v, straighten, persp_h, persp_v,
            quality=88 if scrub else 90, fast=scrub, native=True,
            region=region, meta=meta, browse=browse, peek=peek, is_stale=is_stale,
        )
    if full_quality or ultra:
        # Serialise + bound resolution so a burst of settle-renders can't stack
        # into many GB of concurrent full-frame numpy arrays.
        with _full_render_lock:
            _bail_if_stale()
            return _render_editor_bytes(
                image, path, ULTRA_EDITOR_PREVIEW_PX if ultra else FULL_EDITOR_PREVIEW_PX,
                rotation, crop, adjustments, distortion,
                flip_h, flip_v, straighten, persp_h, persp_v, quality=95, fast=False, browse=browse,
                peek=peek, is_stale=is_stale,
            )
    if scrub:
        # Zoomed in, the scrub frames are what the user is judging detail on,
        # and the small base blown up 4-7x reads as blocks. The accurate tier's
        # base is already cached (no extra decode), and the fast pipeline on it
        # measures 75ms/frame on a 40MP raw - still a fluid drag, at 2.1x the
        # pixels. At fit view the small base stays: 35ms/frame keeps the drag
        # glued to the pointer, and the upscale there is mild.
        return _render_editor_bytes(
            image, path, EDITOR_PREVIEW_PX if zoomed else SCRUB_PREVIEW_PX,
            rotation, crop, adjustments, distortion,
            flip_h, flip_v, straighten, persp_h, persp_v,
            quality=88 if zoomed else 82, fast=True, browse=browse,
            peek=peek, is_stale=is_stale,
        )
    return _render_editor_bytes(
        image, path, max_px, rotation, crop, adjustments, distortion,
        flip_h, flip_v, straighten, persp_h, persp_v, quality=88, fast=False, browse=browse,
        peek=peek, is_stale=is_stale,
    )


# How much extra is rendered around a zoomed tile before it is trimmed away.
# The detail passes (clarity, structure, sharpening, denoise, dehaze) each read
# a neighbourhood around every pixel, so a tile rendered to its exact bounds
# would carry a visible seam where those passes ran out of image. 96px at the
# native tier is comfortably wider than any of their radii and costs a few
# percent of a viewport-sized tile.
REGION_PAD_PX = 96


def region_is_supported(adj: dict) -> bool:
    """Whether a zoomed tile can stand in for the whole-frame render.

    Some effects cannot be computed from a tile at all, and for those the honest
    answer is to render the frame whole. None of them is what anyone zooms to
    100% to judge.

    Defined by the frame's edges: film grain sizes its particles from the
    image's long edge and draws a fresh noise field per render (a tile would
    carry both the wrong particle size and a different texture from the frame it
    replaces), and the frame border is drawn around the photo, which a tile from
    the middle of it does not have.

    Defined by light from outside the tile: the diffusion effects - mist, glow,
    halation, lens flare - spread bright areas across a large fraction of the
    picture. A light source just off the edge of the viewport lights up what IS
    in it, so the tile would have to be rendered with most of the frame around
    it as padding, which is the whole cost this exists to avoid. (The detail
    passes are a different matter: their radii are a few dozen pixels, which is
    what REGION_PAD_PX covers.)"""
    if adj.get("grain_amount", 0):
        return False
    if adj.get("frame_width", 0):
        return False
    for spreads in ("mist", "glow_amount", "halation_amount", "flare_amount"):
        if adj.get(spreads, 0):
            return False
    # Negative clarity layers the diffusion pass on top of the softening.
    if adj.get("clarity", 0) < 0:
        return False
    return True


def _region_box(
    region: tuple[float, float, float, float], full_w: int, full_h: int
) -> tuple[int, int, int, int]:
    """The padded pixel box a region asks for, clamped to the frame. The padding
    is what keeps the detail passes from running out of image at the tile's edge
    (see REGION_PAD_PX); it is trimmed off again after the render."""
    rx, ry, rw, rh = region
    x0 = max(0, min(full_w - 1, int(round(rx * full_w))))
    y0 = max(0, min(full_h - 1, int(round(ry * full_h))))
    x1 = max(x0 + 1, min(full_w, int(round((rx + rw) * full_w))))
    y1 = max(y0 + 1, min(full_h, int(round((ry + rh) * full_h))))
    return (
        max(0, x0 - REGION_PAD_PX),
        max(0, y0 - REGION_PAD_PX),
        min(full_w, x1 + REGION_PAD_PX),
        min(full_h, y1 + REGION_PAD_PX),
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
    native: bool = False,
    browse: bool = False,
    peek: str | None = None,
    region: tuple[float, float, float, float] | None = None,
    meta: dict | None = None,
    is_stale: Callable[[], bool] | None = None,
) -> bytes:
    """`region` (x, y, w, h as fractions of the finished frame) renders only
    that part of it - the editor's viewport while zoomed in, where rendering the
    other 90% of a 40MP frame is seconds of work for pixels nobody can see. The
    geometry still runs on the whole frame, so what is cut out is exactly the
    tile the caller asked for, and everything positional below keeps computing
    against the whole frame (see masks.FieldView)."""
    mtime_ns = path.stat().st_mtime_ns
    if native:
        lin16, gain = _cached_native_base(image.id, str(path), mtime_ns)
    else:
        # Off the request path: this frame renders on whatever base is already
        # there while the biggest one decodes alongside, so the rungs above it
        # never have to wait for a decode. Not while a control is being dragged
        # (fast=True): those frames arrive by the dozen and each one is being
        # waited on, so that is the worst possible moment to start a decode.
        if not fast:
            warm_editor_base(image.id, str(path), mtime_ns)
        lin16, gain = _cached_editor_base(image.id, str(path), mtime_ns, base_px)
    # Cut to the region BEFORE anything touches the pixels, whenever the
    # geometry leaves the frame where it is. This is what makes a zoomed render
    # cheap rather than merely cheaper: converting a 40MP base to float32 is a
    # ~480MB allocation and the geometry pass walks all of it, and doing that
    # first only to throw 94% of it away cost ~5s per render, against ~300ms for
    # the tile itself. With any geometry active (rotation, crop, straighten,
    # perspective, flips, distortion) the mapping from the finished frame back
    # into the base is not a plain slice, so those renders take the long way and
    # cut afterwards - correctness first; the fast path is the common one.
    geometry_moves_pixels = bool(
        distortion or rotation or crop or flip_h or flip_v or straighten or persp_h or persp_v
    )
    early_cut: tuple[int, int, int, int] | None = None
    if region is not None and not geometry_moves_pixels:
        base_h, base_w = lin16.shape[:2]
        early_cut = _region_box(region, base_w, base_h)
        px0, py0, px1, py1 = early_cut
        lin16 = lin16[py0:py1, px0:px1]

    # Last exit before the big allocations: the float32 copy of a native base
    # alone is ~480MB.
    if is_stale is not None and is_stale():
        raise PreviewSuperseded()
    arr = lin16.astype(np.float32)
    if distortion:
        arr = apply_distortion_array(arr, distortion)
    arr = apply_edits_array(arr, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
    view = None
    trim: tuple[int, int, int, int] | None = None
    if early_cut is not None:
        px0, py0, px1, py1 = early_cut
        rx, ry, rw, rh = region
        x0 = max(0, min(base_w - 1, int(round(rx * base_w))))
        y0 = max(0, min(base_h - 1, int(round(ry * base_h))))
        x1 = max(x0 + 1, min(base_w, int(round((rx + rw) * base_w))))
        y1 = max(y0 + 1, min(base_h, int(round((ry + rh) * base_h))))
        view = masks.FieldView(px0, py0, base_w, base_h)
        trim = (x0 - px0, y0 - py0, x1 - x0, y1 - y0)
        if meta is not None:
            # Where this tile belongs, in the finished frame's own pixels. The
            # client composites the tile INTO its copy of the frame, and "which
            # pixel is the top-left corner" must be the server's answer, not a
            # re-derivation that can round differently.
            meta["frame"] = (base_w, base_h)
            meta["box"] = (x0, y0)
    elif region is not None:
        full_h, full_w = arr.shape[:2]
        rx, ry, rw, rh = region
        x0 = max(0, min(full_w - 1, int(round(rx * full_w))))
        y0 = max(0, min(full_h - 1, int(round(ry * full_h))))
        x1 = max(x0 + 1, min(full_w, int(round((rx + rw) * full_w))))
        y1 = max(y0 + 1, min(full_h, int(round((ry + rh) * full_h))))
        # Grow by the padding, render that, and cut the padding off at the end.
        px0, py0 = max(0, x0 - REGION_PAD_PX), max(0, y0 - REGION_PAD_PX)
        px1, py1 = min(full_w, x1 + REGION_PAD_PX), min(full_h, y1 + REGION_PAD_PX)
        arr = arr[py0:py1, px0:px1]
        view = masks.FieldView(px0, py0, full_w, full_h)
        trim = (x0 - px0, y0 - py0, x1 - x0, y1 - y0)
        if meta is not None:
            meta["frame"] = (full_w, full_h)
            meta["box"] = (x0, y0)
    # Names the exact array the tone/denoise stage would be computed from, so the
    # cache can only ever be reused for it: the base (image + mtime + tier) plus
    # every geometry op applied above, plus which exposure the render is judged
    # at. The native tier is left out on purpose - one copy of that stage is
    # ~480MB, too much of the process to hold for a second of denoise.
    tone_key = None if native else json.dumps(
        [image.id, mtime_ns, base_px, rotation, crop, distortion, flip_h, flip_v,
         straighten, persp_h, persp_v, browse, region],
        sort_keys=True, separators=(",", ":"), default=str,
    )
    # The editor renders the raw NATIVE (base_gain=1.0), never the browsing
    # auto-exposure: opening a photo shows its true sensor exposure so you develop
    # from the real data with full DR headroom. The Exposure slider (in adjustments)
    # is the only lift. For JPEG/PNG sources the base gain is already 1.0, so this
    # is a no-op there - only raws differ from the auto-exposed grid/lightbox.
    #
    # `browse=True` is the one exception: the "Original" half of the editor's
    # split view, which is the photo as the library shows it. A DR-mode raw
    # demosaics 2-3 stops dark, so comparing an edit against the native render
    # would only ever say "the edit is brighter" - the honest before/after is
    # against the auto-exposed picture the user actually saw before opening it.
    img = apply_adjustments_linear(
        arr, gain if browse else 1.0, adjustments, fast=fast, tone_cache_key=tone_key,
        peek=peek, view=view, is_stale=is_stale,
    )
    if trim is not None:
        tx, ty, tw, th = trim
        img = img.crop((tx, ty, tx + tw, ty + th))
    img = add_frame(img, adjustments)
    if is_stale is not None and is_stale():
        raise PreviewSuperseded()
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def render_framed_base_image(
    image: "Image",
    rotation: int,
    crop: CropBox | None,
    distortion: int = 0,
    flip_h: bool = False,
    flip_v: bool = False,
    straighten: float = 0.0,
    persp_h: int = 0,
    persp_v: int = 0,
    max_px: int = EDITOR_PREVIEW_PX,
) -> PILImage.Image:
    """The photo with its geometry applied but *no* tonal edits - the exact frame
    a mask lives in, in its neutral rendering.

    This is what semantic segmentation runs on. Geometry has to be applied (the
    mask is stored in the framed image's coordinates, like every other mask), but
    the develop settings must not be: whether something is sky doesn't depend on
    the exposure slider, and feeding a heavily-pushed frame to the model only
    makes the recognition worse. The base gain IS applied - unlike the editor's
    native rendering, which leaves a RAW dark, the model wants an ordinarily
    exposed picture."""
    from app.services.filesystem import resolve_image_path

    path = resolve_image_path(image)
    lin16, gain = _cached_editor_base(image.id, str(path), path.stat().st_mtime_ns, max_px)
    arr = lin16.astype(np.float32)
    if distortion:
        arr = apply_distortion_array(arr, distortion)
    arr = apply_edits_array(arr, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
    return PILImage.fromarray(raw_service.default_tone_to_srgb(arr, gain))


def render_base_preview_bytes(image: "Image", max_px: int = PREVIEW_MAX_PX) -> bytes:
    """A JPEG of the auto-oriented original with *no* edits applied - no rotation,
    crop or tonal changes. The editor applies all of those live on top of this
    clean base (initialised from the photo's saved edits), so nothing is applied
    twice and the whole edit stays a preview until the user saves."""
    from app.services.filesystem import resolve_image_path

    lin, gain = raw_service.load_linear_base(
        resolve_image_path(image), half_size=True, max_px=max_px
    )
    source = PILImage.fromarray(raw_service.default_tone_to_srgb(lin, gain))
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
    max_px: int | None = None,
) -> PILImage.Image:
    """TRUE full-resolution RGB render with the given lens/geometry and tonal
    edits baked in - the only path that demosaics a RAW at full sensor size
    (half_size=False). Used for the flattened edited *copy* and the 100%-zoom
    full.jpg. Serialised by _full_render_lock: a 40MP linear float32 frame is
    ~460MB, so exactly one of these may be in flight at a time.

    `max_px` is a decode-economy hint for bounded renders (export with a size
    cap): decoding the full sensor only to throw most of it away dominated
    sized-export time. The decode target is padded for the crop (the cap
    applies to the *cropped* frame) plus a margin for the straighten/
    perspective trims, so the output never comes out softer than an
    unbounded render downscaled to the same cap. A RAW drops to the 4x
    cheaper half-size demosaic only when that still covers the target;
    JPEG/PNG decode at the smallest sufficient DCT scale."""
    from app.services.filesystem import resolve_image_path

    path = resolve_image_path(image)
    decode_px = None
    if max_px:
        pad = 1.0
        if crop:
            pad = 1.0 / max(0.05, min(float(crop[2]), float(crop[3])))
        decode_px = int(max_px * pad * 1.3)

    with _full_render_lock:
        if decode_px is None:
            # Unbounded render: reuse (and fill) the editor's native-base cache
            # - the full-resolution linear decode kept for 100% zoom. "Save
            # copy" after working zoomed in, and the full.jpg warmer right
            # after a save, then skip the ~14s demosaic entirely; a cold first
            # render pays it once and leaves the base for the next one. It's
            # the same float16 base the editor's 100% preview renders from, so
            # the saved pixels match what the user saw there exactly.
            lin16, gain = _cached_native_base(image.id, str(path), path.stat().st_mtime_ns)
            lin = lin16.astype(np.float32)
        else:
            half_size = False
            if raw_service.is_raw(path):
                dims = raw_service.raw_dimensions(path)
                half_size = bool(dims and max(dims) // 2 >= decode_px)
            lin, gain = raw_service.load_linear_base(path, half_size=half_size, max_px=decode_px)
        if distortion:
            lin = apply_distortion_array(lin, distortion)
        lin = apply_edits_array(lin, rotation, crop, flip_h, flip_v, straighten, persp_h, persp_v)
        # Same browsing rule as the derivatives: an unedited raw's 100%-zoom
        # full.jpg is auto-exposed to match its lightbox preview; an edited one
        # renders native + the user's adjustments, matching the editor.
        source = apply_adjustments_linear(lin, _browsing_gain(gain, adjustments), adjustments)
        del lin
        source = add_frame(source, adjustments)
        return source.convert("RGB")


def render_full_from_stored_edits(image: "Image", max_size: int | None = None) -> PILImage.Image:
    """Full-resolution render of a photo with its *saved* edits baked in,
    optionally downscaled so the long edge fits max_size. Backs the cached
    100%-zoom full.jpg and the user-facing export."""
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
        max_px=max_size,
    )
    if max_size and max(rendered.size) > max_size:
        rendered.thumbnail((max_size, max_size), PILImage.LANCZOS)
    return rendered


# Background warmer for the full.jpg cache: after an edit save, pre-render the
# 100%-zoom/export JPEG so the user's next export (or 100% zoom) of that photo
# is near-instant instead of paying the ~14s full RAW render. One daemon
# worker, latest-state-wins per image, and a small delay so a burst of rapid
# saves coalesces into one render. The render itself serialises on
# _full_render_lock like every other native-resolution render.
_FULL_WARM_DELAY_S = 4.0
_full_warm_lock = threading.Lock()
_full_warm_pending: set[str] = set()
_full_warm_thread: "threading.Thread | None" = None


def warm_full_cache(image_id: str) -> None:
    global _full_warm_thread
    with _full_warm_lock:
        _full_warm_pending.add(image_id)
        if _full_warm_thread is None or not _full_warm_thread.is_alive():
            _full_warm_thread = threading.Thread(target=_full_warm_run, name="full-warm", daemon=True)
            _full_warm_thread.start()


def _full_warm_run() -> None:
    import time as _time

    from app.db.session import SessionLocal

    while True:
        _time.sleep(_FULL_WARM_DELAY_S)
        with _full_warm_lock:
            if not _full_warm_pending:
                return
            image_id = _full_warm_pending.pop()
        try:
            # A newer save invalidates full.jpg (generate_derivatives unlinks
            # it), so an existing file is always current - nothing to do.
            if (derivative_dir(image_id) / "full.jpg").exists():
                continue
            db = SessionLocal()
            try:
                from app.db.models import Image as ImageRow

                image = db.get(ImageRow, image_id)
                if image is not None and image.deleted_at is None:
                    generate_full(image)
            finally:
                db.close()
        except Exception:
            logger.exception("full.jpg warm-up failed for %s", image_id)


def _encode_jpeg_file(path: Path, quality: int, max_size: int | None) -> bytes:
    """Decode an already-finished JPEG/PNG and re-encode it at the export
    quality/size - the cheap tail shared by every export fast path. draft()
    must run before any pixel access (it picks the DCT decode scale), and its
    target is orientation-agnostic (long edge), so calling it on the
    pre-transpose size is fine."""
    im = PILImage.open(path)
    if max_size:
        w, h = im.size
        long_edge = max(w, h)
        if long_edge > max_size:
            scale = max_size / long_edge
            im.draft("RGB", (max(1, round(w * scale)), max(1, round(h * scale))))
    # full.jpg carries no orientation tag (a no-op); an untouched original
    # does, and the render pipeline honours it - so must the fast path.
    im = ImageOps.exif_transpose(im).convert("RGB")
    if max_size and max(im.size) > max_size:
        im.thumbnail((max_size, max_size), PILImage.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _is_untouched(image: "Image") -> bool:
    """No geometry edits and a neutral develop object. For a gain-1.0 source
    (JPEG/PNG) the whole render pipeline is then an exact identity - the tone
    block's own comment: "neutral JPEGs (g=1) pass through untouched"."""
    return (
        not image.edit_rotation
        and image.edit_crop_x is None
        and not (getattr(image, "edit_distortion", 0) or 0)
        and not bool(getattr(image, "edit_flip_h", False))
        and not bool(getattr(image, "edit_flip_v", False))
        and not float(getattr(image, "edit_straighten", 0.0) or 0.0)
        and not int(getattr(image, "edit_persp_h", 0) or 0)
        and not int(getattr(image, "edit_persp_v", 0) or 0)
        and develop.is_neutral(adjustments_from_image(image))
    )


def export_jpeg_bytes(image: "Image", quality: int, max_size: int | None = None) -> bytes:
    """Export-optimised JPEG bytes of a photo with its saved edits baked in.

    Prefers the cached 100%-zoom full.jpg - the exact full-resolution pixels
    the lightbox shows, invalidated whenever the edit changes - because
    decoding + re-encoding a finished JPEG takes ~1-2s where the true render
    takes ~14s per 40MP RAW (single-threaded X-Trans demosaic). An untouched
    JPEG/PNG skips the render outright: the neutral pipeline reproduces the
    original pixels exactly, so re-encoding the original is the same output
    at a tenth of the cost. When no fast path applies the true render runs
    once and *fills* the cache, so every following export (and the lightbox's
    100% zoom) of that photo is fast."""
    from app.services.filesystem import resolve_image_path

    full_path = derivative_dir(image.id) / "full.jpg"
    if full_path.exists():
        return _encode_jpeg_file(full_path, quality, max_size)

    source_path = resolve_image_path(image)
    if not raw_service.is_raw(source_path) and _is_untouched(image):
        return _encode_jpeg_file(source_path, quality, max_size)

    with _full_render_lock:
        # A concurrent native render (the post-save warmer, the lightbox /full
        # endpoint, a sibling export) may have landed full.jpg while this
        # thread waited on the lock. Without the recheck the "edit, export
        # right away" flow rendered the same 14s frame twice back to back.
        if full_path.exists():
            return _encode_jpeg_file(full_path, quality, max_size)
        rendered = render_full_from_stored_edits(image, max_size=max_size)
        buf = io.BytesIO()
        rendered.save(buf, "JPEG", quality=quality)
        data = buf.getvalue()
        # Only a full-resolution render is a valid 100%-zoom cache; a sized
        # export was decoded economically (possibly the half-size demosaic).
        if not max_size:
            try:
                _save_atomic(rendered, full_path, quality=90)
            except Exception:
                logger.exception("Could not fill the full.jpg cache for %s", image.id)
        return data


def generate_full(image: "Image", is_stale: Callable[[], bool] | None = None) -> Path:
    """Render + cache the full-resolution edited JPEG (for true 100% zoom in the
    lightbox), returning its path. Cheap to serve once cached; cleared whenever
    the edit changes (see generate_derivatives). Holding the render lock across
    an existence recheck dedupes concurrent callers (warmer, /full endpoint,
    export): the second one waits, then serves the first one's file instead of
    rendering the same pixels again.

    `is_stale` is the same superseded mechanism as render_editor_preview_bytes:
    interactive /full requests pass it so a zoom the user has long zapped past
    bails (PreviewSuperseded) instead of burning ~14s of the serialized render
    lock per abandoned photo - that queue was what made the whole app crawl
    after a stretch of zoom-and-page browsing. An already-cached file is served
    regardless of staleness; background callers (warmer, export) pass nothing
    and always render."""
    out = derivative_dir(image.id) / "full.jpg"

    def _bail_if_stale() -> None:
        if is_stale is not None and is_stale():
            raise PreviewSuperseded()

    if not out.exists():
        _bail_if_stale()
    with _full_render_lock:
        if out.exists():
            return out
        _bail_if_stale()
        rendered = render_full_from_stored_edits(image)
        _save_atomic(rendered, out, quality=90)
    return out


def adjustments_from_image(image: "Image") -> dict:
    """The full develop adjustments dict for an Image row (parsed from the
    edit_adjustments JSON and normalized to defaults), ready for
    apply_adjustments / generate_derivatives."""
    return develop.loads(getattr(image, "edit_adjustments", None))


def regenerate_for_image(image: "Image", slot_timeout: float | None = None) -> None:
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
        slot_timeout=slot_timeout,
    )
