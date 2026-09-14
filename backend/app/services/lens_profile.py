"""Automatic lens correction from the correction data the camera writes into its RAW.

Fujifilm bodies store the mounted lens's distortion, lateral chromatic
aberration and vignetting as radial tables in every RAF - the same tables the
camera applies to its own JPEG, and they come with third-party lenses too (the
Sigma 18-50 writes them like an XF lens does). So these files need no lens
database: read the tables (exiftool decodes them), then undo the three effects
on the linear base, before any other geometry and before the tone block.

The tables are read the way darktable's "embedded metadata" lens correction
reads the same tags. They are sampled at `knots` - radii in the SOURCE
(uncorrected) frame as a fraction of its half-diagonal - and give:

- distortion: percent. With m = 1 + d/100, a source point at radius rs belongs
  at rs / m in the corrected frame.
- ca_r / ca_b: the red / blue channel's radius relative to green, minus one.
- vignetting: the brightness left at that radius, percent of the centre's.

Everything is linear light, so the vignetting gain is a plain division.

The correction is on by default for every photo that carries the data (the
develop keys in develop.LENS_KEYS switch it off or scale it per photo). The
frame keeps its pixel size: the corrected picture is scaled to fill it with no
empty edges (_autoscale), so crops and masks stored as fractions stay put."""

from __future__ import annotations

import functools
import logging
import math
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import exiftool
import numpy as np

from app.services import develop
from app.services.exif import new_helper

logger = logging.getLogger(__name__)

_RAF_TAGS = [
    "RAF:GeometricDistortionParams",
    "RAF:ChromaticAberrationParams",
    "RAF:VignettingParams",
    "MakerNotes:CropMode",
]


@dataclass(frozen=True)
class LensProfile:
    knots: tuple[float, ...]
    distortion: tuple[float, ...]
    ca_r: tuple[float, ...]
    ca_b: tuple[float, ...]
    vignetting: tuple[float, ...]


def _floats(value) -> list[float] | None:
    """exiftool hands a numeric list back as one space-separated string (or a
    list, depending on the version); either way, floats or None."""
    if value is None:
        return None
    parts = value if isinstance(value, (list, tuple)) else str(value).split()
    try:
        out = [float(p) for p in parts]
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(v) for v in out) else None


def _same(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9)


def parse_fujifilm(distortion, chromatic_aberration, vignetting, crop_mode=None) -> LensProfile | None:
    """The profile from a RAF's three correction tags, or None when they're
    missing or don't have a layout we know. Two layouts exist: 9 knots
    (19/29/19 values, X-Trans IV/V) and 11 knots (23/31/23, X-Trans I-III).
    All three tables must be sampled at the same knots."""
    d, c, v = _floats(distortion), _floats(chromatic_aberration), _floats(vignetting)
    if not d or not c or not v:
        return None
    layout = (len(d), len(c), len(v))
    if layout == (19, 29, 19):
        n = 9
        knots = [d[i + 1] for i in range(n)]
        if any(not _same(c[i + 1], knots[i]) or not _same(v[i + 1], knots[i]) for i in range(n)):
            return None
        dist = [d[i + 10] for i in range(n)]
        ca_r = [c[i + 10] for i in range(n)]
        ca_b = [c[i + 19] for i in range(n)]
        vig = [v[i + 10] for i in range(n)]
    elif layout == (23, 31, 23):
        # The older layout leaves the first knot out of the CA table: its CA is 0.
        n = 11
        knots = [d[i + 1] for i in range(n)]
        for i in range(n):
            kc = c[i] if i else 0.0
            if not _same(kc, knots[i]) or not _same(v[i + 1], knots[i]):
                return None
        dist = [d[i + 12] for i in range(n)]
        ca_r = [c[i + 10] if i else 0.0 for i in range(n)]
        ca_b = [c[i + 20] if i else 0.0 for i in range(n)]
        vig = [v[i + 12] for i in range(n)]
    else:
        return None

    if any(b <= a for a, b in zip(knots, knots[1:])) or knots[0] < 0 or min(vig) <= 0:
        return None
    # Crop modes 2 and 4 (the 1.25x sports finder) record the tables for the
    # full frame, so the smaller frame's half-diagonal reaches further out on them.
    try:
        cropf = 1.25 if int(float(crop_mode)) in (2, 4) else 1.0
    except (TypeError, ValueError):
        cropf = 1.0
    knots = [k * cropf for k in knots]
    # Anchor the tables at the optical centre, where nothing is corrected.
    if knots[0] > 0:
        knots, dist, ca_r, ca_b, vig = [0.0] + knots, [0.0] + dist, [0.0] + ca_r, [0.0] + ca_b, [100.0] + vig
    return LensProfile(tuple(knots), tuple(dist), tuple(ca_r), tuple(ca_b), tuple(vig))


# ---- Reading the tags --------------------------------------------------------
# A helper process of its own, serialised by a lock: PyExifTool's helper is
# not thread-safe, and the render paths that ask for a profile run on several
# threads at once. Reads are ~8ms per RAF and cached per file version.
_helper: exiftool.ExifToolHelper | None = None
_helper_lock = threading.Lock()


def _read_tags(path: Path) -> dict:
    global _helper
    with _helper_lock:
        if _helper is None:
            _helper = new_helper()
        return _helper.get_tags([str(path)], _RAF_TAGS)[0]


@functools.lru_cache(maxsize=4096)
def _cached_profile(path_str: str, mtime_ns: int) -> LensProfile | None:
    try:
        tags = _read_tags(Path(path_str))
    except Exception:
        logger.exception("Could not read lens correction data from %s", path_str)
        return None
    return parse_fujifilm(
        tags.get("RAF:GeometricDistortionParams"),
        tags.get("RAF:ChromaticAberrationParams"),
        tags.get("RAF:VignettingParams"),
        tags.get("MakerNotes:CropMode"),
    )


def profile_for(path: Path) -> LensProfile | None:
    """The embedded lens profile of a photo file, or None. Only Fujifilm RAFs
    carry one we read; a camera JPEG has its corrections baked in already."""
    if path.suffix.lower() != ".raf":
        return None
    try:
        mtime_ns = path.stat().st_mtime_ns
    except OSError:
        return None
    return _cached_profile(str(path), mtime_ns)


# ---- Applying it -------------------------------------------------------------

def strengths(adjustments: dict | None) -> tuple[float, float] | None:
    """(distortion, vignetting) strength as 0..1 fractions, or None when the
    photo has the correction switched off. No develop object = the defaults."""
    adj = adjustments if adjustments is not None else develop.normalize({})
    if not adj.get("lens_profile", 1):
        return None
    return adj.get("lens_distortion", 100) / 100.0, adj.get("lens_vignetting", 100) / 100.0


def is_active(path: Path, adjustments: dict | None) -> bool:
    return strengths(adjustments) is not None and profile_for(path) is not None


# The radial tables, resampled over the corrected frame's radius (fraction of
# the half-diagonal). Past the last entry everything is clamped.
_LUT_MAX_R = 1.6
_LUT_SIZE = 4097


@dataclass(frozen=True)
class _Luts:
    scale: np.ndarray  # source radius / corrected radius
    ca_r: np.ndarray
    ca_b: np.ndarray
    gain: np.ndarray  # vignetting gain, applied at the source radius


@functools.lru_cache(maxsize=16)
def _luts(profile: LensProfile, fd: float, fv: float) -> _Luts:
    knots = np.asarray(profile.knots, dtype=np.float64)
    rs = np.linspace(0.0, _LUT_MAX_R * 1.5, 16385)
    m = 1.0 + fd * np.interp(rs, knots, profile.distortion) / 100.0
    ro = rs / np.maximum(m, 1e-3)
    grid = np.linspace(0.0, _LUT_MAX_R, _LUT_SIZE)
    if not np.all(np.diff(ro) > 0):
        # A table that folds back on itself can't be inverted; leave the
        # geometry alone rather than tear the picture.
        logger.warning("Lens distortion table is not monotonic; skipping distortion")
        m = np.ones_like(rs)
        ro = rs
    scale = np.interp(grid, ro, m)
    rs_of_ro = grid * scale
    vig = 1.0 - fv * (1.0 - np.interp(rs_of_ro, knots, profile.vignetting) / 100.0)
    gain = 1.0 / np.clip(vig, 1.0 / 16.0, None)
    return _Luts(
        scale=scale.astype(np.float32),
        ca_r=np.interp(rs_of_ro, knots, profile.ca_r).astype(np.float32),
        ca_b=np.interp(rs_of_ro, knots, profile.ca_b).astype(np.float32),
        gain=gain.astype(np.float32),
    )


def _lookup(table: np.ndarray, r: np.ndarray) -> np.ndarray:
    return np.interp(r, np.linspace(0.0, _LUT_MAX_R, _LUT_SIZE), table).astype(np.float32)


def _autoscale(luts: _Luts, w2: float, h2: float) -> float:
    """The zoom that fills the frame: the largest view of the corrected picture
    that samples nothing outside the source. Checked along the frame's edges
    (one quadrant - the correction is radially symmetric), for the widest of
    the three channels. Fixed-point iteration: each step rescales by how far
    the worst edge point overshoots (or undershoots) the source edge."""
    diag = math.hypot(w2, h2)
    t = np.linspace(0.0, 1.0, 257)
    px = np.concatenate([w2 * t, np.full_like(t, w2)])
    py = np.concatenate([np.full_like(t, h2), h2 * t])
    z = 1.0
    for _ in range(12):
        r = np.hypot(px, py) / (diag * z)
        s = _lookup(luts.scale, r) * (1.0 + np.maximum(0.0, np.maximum(_lookup(luts.ca_r, r), _lookup(luts.ca_b, r))))
        q = max(float(np.max(px * s / z / w2)), float(np.max(py * s / z / h2)))
        nz = z * q
        if abs(nz - z) < 1e-7:
            return nz
        z = nz
    return z


def correct(arr: np.ndarray, path: Path, adjustments: dict | None) -> np.ndarray:
    """The linear HxWx3 float32 `arr` with the photo's embedded lens profile
    undone, as a new array of the same size - or `arr` itself when the file has
    no profile or the photo has the correction off. Never modifies `arr`."""
    st = strengths(adjustments)
    if st is None:
        return arr
    profile = profile_for(path)
    if profile is None:
        return arr
    return apply_profile(arr, profile, *st)


def apply_profile(arr: np.ndarray, profile: LensProfile, fd: float = 1.0, fv: float = 1.0) -> np.ndarray:
    h, w = arr.shape[:2]
    if h < 2 or w < 2 or (fd <= 0 and fv <= 0 and not any(profile.ca_r) and not any(profile.ca_b)):
        return arr
    luts = _luts(profile, round(fd, 4), round(fv, 4))
    w2, h2 = w / 2.0, h / 2.0
    diag = math.hypot(w2, h2)
    z = _autoscale(luts, w2, h2)
    # A sub-pixel-everywhere CA shift isn't worth two more remaps.
    ca_px = max(float(np.max(np.abs(luts.ca_r))), float(np.max(np.abs(luts.ca_b)))) * diag
    ca = ca_px >= 0.1
    vignette = fv > 0

    # The maps are smooth radial functions, so they're computed on a coarse
    # grid and upsampled with cv2.resize - pixel-exact numpy maps cost ~1s at
    # 40MP. The grid starts a full step outside the frame so every pixel lies
    # between samples (a resize clamps, it doesn't extrapolate, at its edges).
    step = 8 if min(h, w) >= 512 else max(1, min(h, w) // 64)
    pad = step
    gw = -(-(w + 2 * pad) // step)
    gh = -(-(h + 2 * pad) // step)
    # Centre-relative position of each coarse sample, in fine pixels.
    xs = ((np.arange(gw) + 0.5) * step - 0.5 - pad) + 0.5 - w2
    ys = ((np.arange(gh) + 0.5) * step - 0.5 - pad) + 0.5 - h2
    X = np.broadcast_to(xs[None, :] / z, (gh, gw))
    Y = np.broadcast_to(ys[:, None] / z, (gh, gw))
    r = np.hypot(X, Y) / diag
    s = _lookup(luts.scale, r)
    coarse: dict[str, np.ndarray] = {
        "gx": (X * s + w2 - 0.5).astype(np.float32),
        "gy": (Y * s + h2 - 0.5).astype(np.float32),
    }
    if ca:
        for ch, table in (("r", luts.ca_r), ("b", luts.ca_b)):
            k = s * (1.0 + _lookup(table, r))
            coarse[ch + "x"] = (X * k + w2 - 0.5).astype(np.float32)
            coarse[ch + "y"] = (Y * k + h2 - 0.5).astype(np.float32)
    if vignette:
        coarse["gain"] = _lookup(luts.gain, r)

    planes = cv2.split(np.ascontiguousarray(arr, dtype=np.float32))
    out = np.empty((h, w, 3), dtype=np.float32)
    # Bands bound the maps' memory on a native frame; an editor-sized frame
    # goes in one piece, where the per-band overhead would dominate.
    band = h if h * w <= 6_000_000 else max(1, 512 // step) * step
    for y0 in range(0, h, band):
        y1 = min(h, y0 + band)
        k0 = max(0, (y0 + pad) // step - 1)
        k1 = min(gh, (y1 - 1 + pad) // step + 2)
        r0 = y0 + pad - k0 * step

        def up(name: str) -> np.ndarray:
            b = cv2.resize(coarse[name][k0:k1], (gw * step, (k1 - k0) * step), interpolation=cv2.INTER_LINEAR)
            return np.ascontiguousarray(b[r0 : r0 + (y1 - y0), pad : pad + w])

        gx, gy = up("gx"), up("gy")
        for c, prefix in ((0, "r"), (1, "g"), (2, "b")):
            mx, my = (up(prefix + "x"), up(prefix + "y")) if ca and prefix != "g" else (gx, gy)
            out[y0:y1, :, c] = cv2.remap(
                planes[c], mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
            )
        if vignette:
            out[y0:y1] *= up("gain")[:, :, None]
    return out
