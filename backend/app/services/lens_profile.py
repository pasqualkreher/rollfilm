"""Automatic lens correction for RAWs: from the correction data the camera
writes into the file where there is any, from the Lensfun database otherwise.

Sources, in order (first one a file has wins; see profile_for):

- Fujifilm RAF: radial tables (below).
- Sony ARW: 16-knot splines for distortion, lateral CA and vignetting.
- OM System / Olympus ORF: distortion and CA polynomials.
- Panasonic RW2: a distortion polynomial.
- DNG: the WarpRectilinear / FixVignetteRadial opcodes (OpcodeList3) and the
  GainMap lens-shading maps (OpcodeList2) phones write - LibRaw applies none
  of them, so a phone DNG came out with its corners ~0.6 EV dark.
- Everything else with a lens Lensfun knows (Canon, Nikon, Pentax, Ricoh,
  adapted lenses...): its calibration, sampled into the same radial form.

The camera-data readers follow darktable's "embedded metadata" lens module
(src/common/exif.cc, src/iop/lens.cc), which RawTherapee's lensmetadata.cc
also adopts; the formulas are theirs. A JPEG is never corrected: the camera
(or phone) has baked its corrections in already.

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

import base64
import functools
import logging
import math
import struct
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


@dataclass(frozen=True)
class RadialProfile:
    """darktable's form of a correction, the one every non-Fuji source maps
    to. `knots` are radii in the CORRECTED frame (fraction of its
    half-diagonal); at each, `dist` is the green channel's source radius over
    that corrected radius, and `ca_r` / `ca_b` the red / blue channel's source
    radius relative to green's, minus one. Vignetting is sampled on its own
    knots in the SOURCE frame: `vig` is the brightness left there (1 = none)."""

    knots: tuple[float, ...]
    dist: tuple[float, ...]
    ca_r: tuple[float, ...]
    ca_b: tuple[float, ...]
    vig_knots: tuple[float, ...] = ()
    vig: tuple[float, ...] = ()


@dataclass(frozen=True)
class GainMap:
    """One DNG GainMap opcode (lens shading): a grid of gains over a rectangle
    of the raw image, for one CFA site (pitch 2) or for colour planes."""

    top: int
    left: int
    bottom: int
    right: int
    plane: int
    planes: int
    row_pitch: int
    col_pitch: int
    rows: int
    cols: int
    spacing_v: float
    spacing_h: float
    origin_v: float
    origin_h: float
    map_planes: int
    gains: tuple[float, ...]


@dataclass(frozen=True)
class LensfunLens:
    """A Lensfun match, resolved into a RadialProfile per frame aspect (the
    calibration is normalised to the frame, so it depends on its shape)."""

    camera_maker: str
    camera_model: str
    lens_maker: str
    lens_model: str
    focal: float
    aperture: float
    distance: float


@dataclass(frozen=True)
class Correction:
    """Everything profile_for found for one file. `label` names the source
    for the editor ("Camera data" or the Lensfun lens)."""

    source: str  # fujifilm | sony | olympus | panasonic | dng | lensfun
    label: str
    radial: LensProfile | RadialProfile | None = None
    lensfun: LensfunLens | None = None
    gain_maps: tuple[GainMap, ...] = ()
    # LibRaw's `flip` for the file: gain maps are laid out in sensor
    # orientation, the decoded frame is already turned upright.
    flip: int = 0
    raw_size: tuple[int, int] = (0, 0)  # visible sensor area, raw orientation (w, h)
    margins: tuple[int, int] = (0, 0)  # (top, left) of that area in the raw image
    cfa: tuple[tuple[int, int], tuple[int, int]] = ((0, 1), (1, 2))  # site -> 0 R, 1 G, 2 B


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


# Radial samples a polynomial source is turned into.
_POLY_KNOTS = 33


def _poly_knots() -> list[float]:
    return [i / (_POLY_KNOTS - 1) for i in range(_POLY_KNOTS)]


def parse_sony(distortion, chromatic_aberration, vignetting) -> RadialProfile | None:
    """ARW SubIFD DistortionCorrParams / ChromaticAberrationCorrParams /
    VignettingCorrParams: a count n (<= 16) then n spline values (2n for CA:
    red, then blue), sampled at (i + 0.5) / (n - 1) of the half-diagonal."""
    d, c, v = _floats(distortion), _floats(chromatic_aberration), _floats(vignetting)
    if not d or not c or not v:
        return None
    n = int(d[0])
    if not (2 <= n <= 16) or len(d) != n + 1 or int(c[0]) != 2 * n or len(c) != 2 * n + 1 or int(v[0]) != n or len(v) != n + 1:
        return None
    knots = [(i + 0.5) / (n - 1) for i in range(n)]
    dist = [d[i + 1] * 2.0**-14 + 1.0 for i in range(n)]
    ca_r = [c[i + 1] * 2.0**-21 for i in range(n)]
    ca_b = [c[n + i + 1] * 2.0**-21 for i in range(n)]
    vig = [2.0 ** (0.5 - 2.0 ** (v[i + 1] * 2.0**-13 - 1.0)) for i in range(n)]
    if min(dist) <= 0 or min(vig) <= 0:
        return None
    return RadialProfile(tuple(knots), tuple(dist), tuple(ca_r), tuple(ca_b), tuple(knots), tuple(vig))


def parse_olympus(distortion, chromatic_aberration) -> RadialProfile | None:
    """ORF image-processing tags 0x150a (distortion: k2, k4, k6, and the
    corner radius scale) and 0x150c (CA: three terms each for red and blue).
    '0 0 0 1' / all zeros mean no data."""
    d, c = _floats(distortion), _floats(chromatic_aberration)
    has_d = bool(d and len(d) == 4 and any(x != 0 for x in d[:3]))
    has_c = bool(c and len(c) == 6 and any(x != 0 for x in c))
    if not has_d and not has_c:
        return None
    drs, dk2, dk4, dk6 = (d[3], d[0], d[1], d[2]) if has_d else (1.0, 0.0, 0.0, 0.0)
    car0, car2, car4, cab0, cab2, cab4 = c if has_c else (0.0,) * 6
    knots = _poly_knots()
    dist, ca_r, ca_b = [], [], []
    for r in knots:
        # Rin = Rout*drs * (1 + dk2 (Rout drs)^2 + dk4 (..)^4 + dk6 (..)^6), corner = 1.
        rs2 = (r * drs) ** 2
        g = drs * (1.0 + rs2 * (dk2 + rs2 * (dk4 + rs2 * dk6)))
        dist.append(g)
        # CA acts on the distorted radius: Rin_c = Rin * ((1 + ca0) + ca2 Rin^2 + ca4 Rin^4).
        rd = g * r
        rd2 = rd * rd
        ca_r.append((car0 + rd2 * (car2 + rd2 * car4)))
        ca_b.append((cab0 + rd2 * (cab2 + rd2 * cab4)))
    if min(dist) <= 0:
        return None
    return RadialProfile(tuple(knots), tuple(dist), tuple(ca_r), tuple(ca_b))


def parse_panasonic(enabled, scale, p04, p08, p11) -> RadialProfile | None:
    """RW2 DistortionInfo, as exiftool decodes it (DistortionScale already
    1 / (1 + v/32768), the params v/32768): Ru = Rd * (1 + scale (a Rd^2 +
    b Rd^4 + c Rd^6)) with a = Param08, b = Param04, c = Param11, both radii
    on the half-diagonal. Inverted per corrected radius by fixed-point steps."""
    try:
        if int(float(enabled)) & 0x0F != 1:
            return None
        sc, a, b, c = float(scale), float(p08), float(p04), float(p11)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(x) for x in (sc, a, b, c)) or (a == 0 and b == 0 and c == 0):
        return None
    knots = _poly_knots()
    dist = []
    for r in knots:
        rd = r
        for _ in range(12):
            rd2 = rd * rd
            f = 1.0 + sc * (a * rd2 + b * rd2 * rd2 + c * rd2 * rd2 * rd2)
            rd = r / f if f > 1e-6 else r
        dist.append(rd / r if r > 0 else 1.0)
    zeros = (0.0,) * len(knots)
    return RadialProfile(tuple(knots), tuple(dist), zeros, zeros)


def _b64(value) -> bytes | None:
    """exiftool -b hands binary tags to JSON as 'base64:...'."""
    if not isinstance(value, str) or not value.startswith("base64:"):
        return None
    try:
        return base64.b64decode(value[7:])
    except (ValueError, TypeError):
        return None


def _opcodes(buf: bytes | None):
    """(id, params) of each opcode in a DNG opcode list (all big-endian)."""
    if not buf or len(buf) < 4:
        return
    count = struct.unpack_from(">I", buf, 0)[0]
    off = 4
    for _ in range(count):
        if off + 16 > len(buf):
            return
        opcode_id, _ver, _flags, size = struct.unpack_from(">IIII", buf, off)
        if off + 16 + size > len(buf):
            return
        yield opcode_id, buf[off + 16 : off + 16 + size]
        off += 16 + size


def parse_dng(opcode_list2: bytes | None, opcode_list3: bytes | None) -> tuple[RadialProfile | None, tuple[GainMap, ...]]:
    """WarpRectilinear (1) and FixVignetteRadial (3) from OpcodeList3, GainMap
    (9) from OpcodeList2. The warp maps a corrected radius r (on the
    half-diagonal) to the source at r * (k0 + k1 r^2 + k2 r^4 + k3 r^6), per
    plane; the vignette divides by 1 + k0 r^2 + ... + k4 r^10. Tangential
    terms and an off-centre optical axis are ignored, as darktable does."""
    warp: list[tuple[float, ...]] | None = None
    cvig: tuple[float, ...] | None = None
    for opcode_id, param in _opcodes(opcode_list3):
        if opcode_id == 1 and len(param) >= 4:
            planes = struct.unpack_from(">I", param, 0)[0]
            if planes in (1, 3) and len(param) >= 4 + 8 * (6 * planes + 2):
                warp = [struct.unpack_from(">6d", param, 4 + 48 * p) for p in range(planes)]
        elif opcode_id == 3 and len(param) >= 56:
            cvig = struct.unpack_from(">5d", param, 0)
    maps: list[GainMap] = []
    for opcode_id, param in _opcodes(opcode_list2):
        if opcode_id != 9 or len(param) < 76:
            continue
        top, left, bottom, right, plane, planes, rp, cp, rows, cols = struct.unpack_from(">10I", param, 0)
        sv, sh, ov, oh = struct.unpack_from(">4d", param, 40)
        mplanes = struct.unpack_from(">I", param, 72)[0]
        n = rows * cols * mplanes
        if n <= 0 or len(param) < 76 + 4 * n or bottom <= top or right <= left:
            continue
        gains = struct.unpack_from(f">{n}f", param, 76)
        if not all(math.isfinite(g) and 0 < g < 16 for g in gains):
            continue
        maps.append(GainMap(top, left, bottom, right, plane, planes, rp, cp, rows, cols, sv, sh, ov, oh, mplanes, tuple(gains)))

    radial = None
    if warp is not None or cvig is not None:
        knots = _poly_knots()
        if warp is not None:
            per_plane = [
                [k[0] + k[1] * r**2 + k[2] * r**4 + k[3] * r**6 for r in knots] for k in warp
            ]
            if len(per_plane) == 1:
                per_plane = per_plane * 3
        else:
            per_plane = [[1.0] * len(knots)] * 3
        red, green, blue = per_plane
        if min(green) <= 0:
            green = red = blue = [1.0] * len(knots)
        vig: tuple[float, ...] = ()
        if cvig is not None:
            vig = tuple(
                1.0 / max(1e-3, 1.0 + sum(cvig[i] * r ** (2 * i + 2) for i in range(5))) for r in knots
            )
        radial = RadialProfile(
            tuple(knots),
            tuple(green),
            tuple(r_ / g - 1.0 for r_, g in zip(red, green)),
            tuple(b_ / g - 1.0 for b_, g in zip(blue, green)),
            tuple(knots) if vig else (),
            vig,
        )
    return radial, tuple(maps)


# ---- Lensfun -----------------------------------------------------------------
# The fallback for files without camera data. Loaded on first use (the XML
# database takes ~0.1s); a missing module just means no fallback.

_lensfun_db = None
_lensfun_lock = threading.Lock()


def _lensfun():
    global _lensfun_db
    with _lensfun_lock:
        if _lensfun_db is None:
            try:
                import lensfunpy

                _lensfun_db = lensfunpy.Database()
            except Exception:
                logger.exception("Lensfun database unavailable; no lens correction without camera data")
                _lensfun_db = False
        return _lensfun_db or None


def _has_calibration(lens) -> bool:
    return bool(lens.calib_distortion or lens.calib_tca or lens.calib_vignetting)


def find_lensfun_lens(make, model, lens_names, focal, aperture, distance) -> LensfunLens | None:
    """The Lensfun calibration for a camera + lens, or None. The lens is looked
    up by each of its EXIF names in turn (Lensfun's matcher is fuzzy, but an
    unknown lens gives no hit rather than a wrong one). A fixed-lens camera
    whose EXIF has no usable lens name gets its one built-in lens."""
    db = _lensfun()
    if db is None or not make or not model:
        return None
    try:
        focal_f = float(focal)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(focal_f) or focal_f <= 0:
        return None
    try:
        aperture_f = float(aperture)
        if not math.isfinite(aperture_f) or aperture_f <= 0:
            raise ValueError
    except (TypeError, ValueError):
        aperture_f = 8.0
    try:
        distance_f = float(distance)
        if not math.isfinite(distance_f) or distance_f <= 0:
            raise ValueError
    except (TypeError, ValueError):
        distance_f = 1000.0
    try:
        cams = db.find_cameras(str(make).strip(), str(model).strip())
        if not cams:
            return None
        cam = cams[0]
        lens = None
        for name in lens_names:
            if not name:
                continue
            hits = [l for l in db.find_lenses(cam, None, str(name).strip()) if _has_calibration(l)]
            if hits:
                lens = hits[0]
                break
        if lens is None:
            # A compact's own lens: the camera's mount carries only it (and
            # its converter variants, named "... with <converter>").
            fixed = [l for l in db.find_lenses(cam) if _has_calibration(l)]
            plain = [l for l in fixed if " with " not in l.model]
            if 0 < len(fixed) <= 4 and plain:
                lens = plain[0]
        if lens is None:
            return None
        return LensfunLens(cam.maker, cam.model, lens.maker, lens.model, focal_f, aperture_f, distance_f)
    except Exception:
        logger.exception("Lensfun lookup failed for %s %s", make, model)
        return None


@functools.lru_cache(maxsize=64)
def lensfun_profile(ref: LensfunLens, aspect: float) -> RadialProfile | None:
    """Sample the Lensfun calibration of `ref` into a RadialProfile, for a
    frame of this width/height ratio: Lensfun's own maps are computed on a
    small frame of that shape and read along its diagonal (every model it
    has is radially symmetric). Unscaled (scale 1) - _autoscale does the fill."""
    db = _lensfun()
    if db is None:
        return None
    import lensfunpy

    try:
        cam = db.find_cameras(ref.camera_maker, ref.camera_model)[0]
        lens = next(l for l in db.find_lenses(cam, ref.lens_maker, ref.lens_model) if l.model == ref.lens_model)
    except Exception:
        return None
    w = 1200
    h = max(2, int(round(w / max(0.1, aspect))))
    flags = lensfunpy.ModifyFlags.ALL
    if lens.type != lensfunpy.LensType.RECTILINEAR:
        # A fisheye stays a fisheye: only its vignetting and CA are undone.
        flags = lensfunpy.ModifyFlags.TCA | lensfunpy.ModifyFlags.VIGNETTING
    mod = lensfunpy.Modifier(lens, cam.crop_factor, w, h)
    # (lensfunpy's initialize reports nothing back; each apply_* below says
    # itself whether the lens had data for it.)
    mod.initialize(
        ref.focal, ref.aperture, ref.distance, scale=1.0, targeom=lens.type,
        pixel_format=np.float32, flags=flags,
    )
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    half_diag = math.hypot(cx, cy)
    # Pixels along the diagonal from the centre to the corner.
    ts = np.linspace(0.0, 1.0, 97)
    xs = np.clip(np.round(cx + ts * cx).astype(int), 0, w - 1)
    ys = np.clip(np.round(cy + ts * cy).astype(int), 0, h - 1)
    ro = np.hypot(xs - cx, ys - cy) / half_diag
    keep = np.concatenate([[True], np.diff(ro) > 1e-6])
    xs, ys, ro = xs[keep], ys[keep], ro[keep]

    knots = [0.0]
    dist, ca_r, ca_b = [1.0], [0.0], [0.0]
    coords = mod.apply_subpixel_geometry_distortion()  # (h, w, 3, 2): source x, y per channel
    if coords is not None:
        src = coords[ys, xs]  # (n, 3, 2)
        rs = np.hypot(src[..., 0] - cx, src[..., 1] - cy) / half_diag  # (n, 3)
        for i in range(1, len(ro)):
            knots.append(float(ro[i]))
            dist.append(float(rs[i, 1] / ro[i]))
            ca_r.append(float(rs[i, 0] / rs[i, 1] - 1.0) if rs[i, 1] > 0 else 0.0)
            ca_b.append(float(rs[i, 2] / rs[i, 1] - 1.0) if rs[i, 1] > 0 else 0.0)
        dist[0] = dist[1]
    vig_knots: tuple[float, ...] = ()
    vig: tuple[float, ...] = ()
    if flags & lensfunpy.ModifyFlags.VIGNETTING:
        ones = np.ones((h, w, 3), dtype=np.float32)
        if mod.apply_color_modification(ones):
            gain = ones[ys, xs, 1].astype(np.float64)
            vig_knots = tuple(float(r) for r in ro)
            vig = tuple(float(1.0 / max(1e-3, g)) for g in gain)
    if len(knots) < 2 and not vig:
        return None
    if len(knots) < 2:
        knots, dist, ca_r, ca_b = [0.0, 1.0], [1.0, 1.0], [0.0, 0.0], [0.0, 0.0]
    return RadialProfile(tuple(knots), tuple(dist), tuple(ca_r), tuple(ca_b), vig_knots, vig)


# ---- Reading the tags --------------------------------------------------------
# A helper process of its own, serialised by a lock: PyExifTool's helper is
# not thread-safe, and the render paths that ask for a profile run on several
# threads at once. Reads are ~8ms per RAF and cached per file version.
# -u for Olympus's unnamed image-processing tags, -b for the DNG opcode lists
# (JSON carries them as base64).
_TAGS = _RAF_TAGS + [
    "EXIF:DistortionCorrParams",
    "EXIF:ChromaticAberrationCorrParams",
    "EXIF:VignettingCorrParams",
    "MakerNotes:Olympus_ImageProcessing_0x150a",
    "MakerNotes:Olympus_ImageProcessing_0x150c",
    "PanasonicRaw:DistortionCorrection",
    "PanasonicRaw:DistortionScale",
    "PanasonicRaw:DistortionParam04",
    "PanasonicRaw:DistortionParam08",
    "PanasonicRaw:DistortionParam11",
    "EXIF:OpcodeList2",
    "EXIF:OpcodeList3",
    "EXIF:Make",
    "EXIF:Model",
    "EXIF:LensModel",
    "MakerNotes:LensModel",
    "MakerNotes:LensType",
    "Composite:LensID",
    "EXIF:FocalLength",
    "EXIF:FNumber",
    "MakerNotes:FocusDistance",
]
_helper: exiftool.ExifToolHelper | None = None
_helper_lock = threading.Lock()


def _read_tags(path: Path) -> dict:
    global _helper
    with _helper_lock:
        if _helper is None:
            _helper = new_helper()
        return _helper.get_tags([str(path)], _TAGS, params=["-u", "-b"])[0]


def close_helper() -> None:
    """End this module's exiftool process on backend shutdown (exif.close_helper)."""
    global _helper
    with _helper_lock:
        helper, _helper = _helper, None
    if helper is not None:
        try:
            helper.terminate()
        except Exception:
            pass


def _lens_names(tags: dict) -> list[str]:
    """The lens's EXIF names, best first. With -n some makers' LensID /
    LensType come back as numbers, which name nothing."""
    names = []
    for key in ("EXIF:LensModel", "MakerNotes:LensModel", "Composite:LensID", "MakerNotes:LensType"):
        v = tags.get(key)
        if isinstance(v, str) and v.strip() and not all(p.replace(".", "", 1).lstrip("-").isdigit() for p in v.split()):
            names.append(v.strip())
    return names


def _raw_layout(path: Path) -> tuple[int, tuple[int, int], tuple[int, int], tuple[tuple[int, int], tuple[int, int]]]:
    """(flip, visible size (w, h), (top, left) margins, CFA colour per 2x2
    site as 0 R / 1 G / 2 B) - what laying a DNG gain map onto the decoded
    frame needs."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        sizes = raw.sizes
        desc = raw.color_desc.decode(errors="replace") if raw.color_desc else "RGBG"
        pattern = raw.raw_pattern
        colour = {"R": 0, "G": 1, "B": 2}

        def site(y: int, x: int) -> int:
            if pattern is None:
                return 1
            idx = int(pattern[y % pattern.shape[0]][x % pattern.shape[1]])
            return colour.get(desc[idx] if idx < len(desc) else "G", 1)

        cfa = ((site(0, 0), site(0, 1)), (site(1, 0), site(1, 1)))
        return int(sizes.flip), (int(sizes.width), int(sizes.height)), (int(sizes.top_margin), int(sizes.left_margin)), cfa


def _correction_from_tags(path: Path, tags: dict) -> Correction | None:
    fuji = parse_fujifilm(
        tags.get("RAF:GeometricDistortionParams"),
        tags.get("RAF:ChromaticAberrationParams"),
        tags.get("RAF:VignettingParams"),
        tags.get("MakerNotes:CropMode"),
    )
    if fuji is not None:
        return Correction("fujifilm", "Camera data", radial=fuji)
    sony = parse_sony(
        tags.get("EXIF:DistortionCorrParams"),
        tags.get("EXIF:ChromaticAberrationCorrParams"),
        tags.get("EXIF:VignettingCorrParams"),
    )
    if sony is not None:
        return Correction("sony", "Camera data", radial=sony)
    olympus = parse_olympus(
        tags.get("MakerNotes:Olympus_ImageProcessing_0x150a"),
        tags.get("MakerNotes:Olympus_ImageProcessing_0x150c"),
    )
    if olympus is not None:
        return Correction("olympus", "Camera data", radial=olympus)
    panasonic = parse_panasonic(
        tags.get("PanasonicRaw:DistortionCorrection"),
        tags.get("PanasonicRaw:DistortionScale"),
        tags.get("PanasonicRaw:DistortionParam04"),
        tags.get("PanasonicRaw:DistortionParam08"),
        tags.get("PanasonicRaw:DistortionParam11"),
    )
    if panasonic is not None:
        return Correction("panasonic", "Camera data", radial=panasonic)
    radial, maps = parse_dng(_b64(tags.get("EXIF:OpcodeList2")), _b64(tags.get("EXIF:OpcodeList3")))
    if radial is not None or maps:
        layout: dict = {}
        if maps:
            try:
                flip, size, margins, cfa = _raw_layout(path)
                layout = {"flip": flip, "raw_size": size, "margins": margins, "cfa": cfa}
            except Exception:
                logger.exception("Could not read the raw layout of %s; its gain maps are skipped", path)
                maps = ()
        if radial is not None or maps:
            return Correction("dng", "Camera data", radial=radial, gain_maps=maps, **layout)
    ref = find_lensfun_lens(
        tags.get("EXIF:Make"), tags.get("EXIF:Model"), _lens_names(tags),
        tags.get("EXIF:FocalLength"), tags.get("EXIF:FNumber"), tags.get("MakerNotes:FocusDistance"),
    )
    if ref is not None:
        return Correction("lensfun", f"Lensfun: {ref.lens_model}", lensfun=ref)
    return None


@functools.lru_cache(maxsize=4096)
def _cached_profile(path_str: str, mtime_ns: int) -> Correction | None:
    try:
        tags = _read_tags(Path(path_str))
    except Exception:
        logger.exception("Could not read lens correction data from %s", path_str)
        return None
    try:
        return _correction_from_tags(Path(path_str), tags)
    except Exception:
        logger.exception("Could not parse lens correction data from %s", path_str)
        return None


def profile_for(path: Path) -> Correction | None:
    """The lens correction for a photo file, or None. RAWs only: a camera or
    phone JPEG has its corrections baked in already."""
    from app.services import raw as raw_service

    if not raw_service.is_raw(path):
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
def _luts(profile: LensProfile | RadialProfile, fd: float, fv: float) -> _Luts:
    if isinstance(profile, RadialProfile):
        return _radial_luts(profile, fd, fv)
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


def _radial_luts(profile: RadialProfile, fd: float, fv: float) -> _Luts:
    grid = np.linspace(0.0, _LUT_MAX_R, _LUT_SIZE)
    knots = np.asarray(profile.knots, dtype=np.float64)
    g = np.interp(grid, knots, profile.dist)
    scale = 1.0 + fd * (g - 1.0)
    if not np.all(np.diff(grid * scale) > 0):
        logger.warning("Lens distortion profile is not monotonic; skipping distortion")
        scale = np.ones_like(grid)
    rs_of_ro = grid * scale
    if profile.vig:
        vig = 1.0 - fv * (1.0 - np.interp(rs_of_ro, profile.vig_knots, profile.vig))
        gain = 1.0 / np.clip(vig, 1.0 / 16.0, None)
    else:
        gain = np.ones_like(grid)
    return _Luts(
        scale=scale.astype(np.float32),
        ca_r=np.interp(grid, knots, profile.ca_r).astype(np.float32),
        ca_b=np.interp(grid, knots, profile.ca_b).astype(np.float32),
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


def windowable(path: Path, adjustments: dict | None) -> bool:
    """Whether correct_window can produce this photo's correction (no DNG
    gain maps in play - those run over the whole frame)."""
    st = strengths(adjustments)
    corr = profile_for(path) if st is not None else None
    return not (corr is not None and corr.gain_maps and st[1] > 0)


def correct_window(
    base: np.ndarray, path: Path, adjustments: dict | None, box: tuple[int, int, int, int]
) -> np.ndarray | None:
    """correct(base)[y0:y1, x0:x1] as float32 (box = x0, y0, x1, y1 in `base`'s
    pixels), computed from the box's own neighbourhood - see
    apply_profile_window. None when the correction can't be windowed (DNG
    gain maps, which are applied over the whole frame): the caller then takes
    the whole-frame path."""
    x0, y0, x1, y1 = box
    st = strengths(adjustments)
    corr = profile_for(path) if st is not None else None
    if st is None or corr is None:
        return base[y0:y1, x0:x1].astype(np.float32)
    fd, fv = st
    if corr.gain_maps and fv > 0:
        return None
    radial = corr.radial
    if radial is None and corr.lensfun is not None and base.shape[0] > 1:
        radial = lensfun_profile(corr.lensfun, round(base.shape[1] / base.shape[0], 3))
    if radial is None:
        return base[y0:y1, x0:x1].astype(np.float32)
    return apply_profile_window(base, radial, box, fd, fv)


def correct(arr: np.ndarray, path: Path, adjustments: dict | None) -> np.ndarray:
    """The linear HxWx3 float32 `arr` with the photo's lens correction applied,
    as a new array of the same size - or `arr` itself when the file has no
    correction or the photo has it off. Never modifies `arr`."""
    st = strengths(adjustments)
    if st is None:
        return arr
    corr = profile_for(path)
    if corr is None:
        return arr
    fd, fv = st
    out = arr
    if corr.gain_maps and fv > 0:
        out = apply_gain_maps(out, corr, fv)
    radial = corr.radial
    if radial is None and corr.lensfun is not None and arr.shape[0] > 1:
        radial = lensfun_profile(corr.lensfun, round(arr.shape[1] / arr.shape[0], 3))
    if radial is not None:
        out = apply_profile(out, radial, fd, fv)
    return out


def _gain_grid(gm: GainMap, plane: int, raw_rows: np.ndarray, raw_cols: np.ndarray) -> np.ndarray:
    """One map plane, bilinearly spread over the frame pixels whose raw-image
    coordinates are raw_rows x raw_cols. Separable: two small interpolation
    matrices around the (rows x cols) grid, so a 50MP frame never needs a
    full-size coordinate map."""
    grid = np.asarray(gm.gains, dtype=np.float32).reshape(gm.rows, gm.cols, gm.map_planes)[
        :, :, min(plane, gm.map_planes - 1)
    ]

    def weights(coords: np.ndarray, lo: int, hi: int, origin: float, spacing: float, points: int) -> np.ndarray:
        pos = (coords - lo) / max(1, hi - lo)  # relative position in the map's area
        idx = np.clip((pos - origin) / spacing, 0, points - 1) if spacing > 0 else np.zeros_like(pos)
        i0 = np.floor(idx).astype(int)
        i1 = np.minimum(i0 + 1, points - 1)
        f = (idx - i0).astype(np.float32)
        m = np.zeros((len(coords), points), dtype=np.float32)
        rows = np.arange(len(coords))
        np.add.at(m, (rows, i0), 1.0 - f)
        np.add.at(m, (rows, i1), f)
        return m

    wy = weights(raw_rows, gm.top, gm.bottom, gm.origin_v, gm.spacing_v, gm.rows)
    wx = weights(raw_cols, gm.left, gm.right, gm.origin_h, gm.spacing_h, gm.cols)
    return (wy @ grid) @ wx.T


def apply_gain_maps(arr: np.ndarray, corr: Correction, fv: float = 1.0) -> np.ndarray:
    """The DNG lens-shading gain maps on a decoded (demosaiced, upright,
    possibly half-size) frame. A CFA map (pitch 2) belongs to one colour site;
    after demosaicing its gain goes to that colour's channel (the two green
    sites' maps averaged) - the maps are smooth, so this matches applying them
    to the mosaic well within their own precision. `fv` scales them like the
    vignetting slider scales every other source."""
    h, w = arr.shape[:2]
    quarter = corr.flip in (5, 6)
    rh, rw = (w, h) if quarter else (h, w)  # the frame in sensor orientation
    vis_w, vis_h = corr.raw_size
    top, left = corr.margins
    # Raw-image coordinate of each frame pixel's centre (a half-size decode
    # covers the same area with half the pixels).
    raw_rows = (np.arange(rh) + 0.5) * ((vis_h or rh) / rh) + top
    raw_cols = (np.arange(rw) + 0.5) * ((vis_w or rw) / rw) + left
    sums = np.zeros((3, rh, rw), dtype=np.float32)
    counts = np.zeros(3, dtype=np.float32)
    for gm in corr.gain_maps:
        if gm.row_pitch == 2 and gm.col_pitch == 2:
            targets = [(corr.cfa[gm.top % 2][gm.left % 2], 0)]
        else:
            targets = [(c, i) for i, c in enumerate(range(gm.plane, min(3, gm.plane + gm.planes)))]
        for channel, plane in targets:
            sums[channel] += _gain_grid(gm, plane, raw_rows, raw_cols)
            counts[channel] += 1
    if not counts.any():
        return arr
    out = np.array(arr, dtype=np.float32, copy=True)
    for c in range(3):
        if not counts[c]:
            continue
        g = sums[c] / counts[c]
        # Into the decoded orientation (LibRaw flip: 3 = 180, 5 = 90 CCW, 6 = 90 CW).
        if corr.flip == 3:
            g = g[::-1, ::-1]
        elif corr.flip == 5:
            g = np.rot90(g, 1)
        elif corr.flip == 6:
            g = np.rot90(g, -1)
        if fv != 1.0:
            g = 1.0 + fv * (g - 1.0)
        out[:, :, c] *= g
    return out


class _ProfileMaps:
    """A profile's warp (and CA / vignetting) for one frame size, on the
    coarse grid apply_profile upsamples from. `window` hands out any rectangle
    of the full-resolution maps; a rectangle is the same pixels the whole-frame
    upsample would give there (an integer-factor INTER_LINEAR resize is shift
    invariant, and the one-sample margins keep every window edge off the
    resize's own clamped border)."""

    def __init__(self, h: int, w: int, profile: LensProfile | RadialProfile, fd: float, fv: float):
        no_vig = isinstance(profile, RadialProfile) and not profile.vig
        self.noop = h < 2 or w < 2 or (
            fd <= 0 and (fv <= 0 or no_vig) and not any(profile.ca_r) and not any(profile.ca_b)
        )
        if self.noop:
            return
        luts = _luts(profile, round(fd, 4), round(fv, 4))
        w2, h2 = w / 2.0, h / 2.0
        diag = math.hypot(w2, h2)
        z = _autoscale(luts, w2, h2)
        # A sub-pixel-everywhere CA shift isn't worth two more remaps.
        ca_px = max(float(np.max(np.abs(luts.ca_r))), float(np.max(np.abs(luts.ca_b)))) * diag
        self.ca = ca_px >= 0.1
        self.vignette = fv > 0 and not no_vig

        # The maps are smooth radial functions, so they're computed on a coarse
        # grid and upsampled with cv2.resize - pixel-exact numpy maps cost ~1s at
        # 40MP. The grid starts a full step outside the frame so every pixel lies
        # between samples (a resize clamps, it doesn't extrapolate, at its edges).
        self.step = step = 8 if min(h, w) >= 512 else max(1, min(h, w) // 64)
        self.pad = pad = step
        self.gw = gw = -(-(w + 2 * pad) // step)
        self.gh = gh = -(-(h + 2 * pad) // step)
        # Centre-relative position of each coarse sample, in fine pixels.
        xs = ((np.arange(gw) + 0.5) * step - 0.5 - pad) + 0.5 - w2
        ys = ((np.arange(gh) + 0.5) * step - 0.5 - pad) + 0.5 - h2
        X = np.broadcast_to(xs[None, :] / z, (gh, gw))
        Y = np.broadcast_to(ys[:, None] / z, (gh, gw))
        r = np.hypot(X, Y) / diag
        s = _lookup(luts.scale, r)
        self.coarse: dict[str, np.ndarray] = {
            "gx": (X * s + w2 - 0.5).astype(np.float32),
            "gy": (Y * s + h2 - 0.5).astype(np.float32),
        }
        if self.ca:
            for ch, table in (("r", luts.ca_r), ("b", luts.ca_b)):
                k = s * (1.0 + _lookup(table, r))
                self.coarse[ch + "x"] = (X * k + w2 - 0.5).astype(np.float32)
                self.coarse[ch + "y"] = (Y * k + h2 - 0.5).astype(np.float32)
        if self.vignette:
            self.coarse["gain"] = _lookup(luts.gain, r)

    def window(self, name: str, y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
        step, pad = self.step, self.pad
        k0 = max(0, (y0 + pad) // step - 1)
        k1 = min(self.gh, (y1 - 1 + pad) // step + 2)
        j0 = max(0, (x0 + pad) // step - 1)
        j1 = min(self.gw, (x1 - 1 + pad) // step + 2)
        r0 = y0 + pad - k0 * step
        c0 = x0 + pad - j0 * step
        b = cv2.resize(
            self.coarse[name][k0:k1, j0:j1],
            ((j1 - j0) * step, (k1 - k0) * step),
            interpolation=cv2.INTER_LINEAR,
        )
        return np.ascontiguousarray(b[r0 : r0 + (y1 - y0), c0 : c0 + (x1 - x0)])

    def channel_maps(self, y0: int, y1: int, x0: int, x1: int) -> list[tuple[np.ndarray, np.ndarray]]:
        """(map_x, map_y) for R, G, B over the window."""
        gx, gy = self.window("gx", y0, y1, x0, x1), self.window("gy", y0, y1, x0, x1)
        maps = []
        for prefix in ("r", "g", "b"):
            if self.ca and prefix != "g":
                maps.append((self.window(prefix + "x", y0, y1, x0, x1), self.window(prefix + "y", y0, y1, x0, x1)))
            else:
                maps.append((gx, gy))
        return maps


# How the remap samples the source. Bilinear halved the detail energy of
# every corrected raw (measured on a 40MP RAF, Laplacian variance 214 -> 121
# on the half-size base, 100 -> 54 at 100%): every pixel lands at a fractional
# offset, and the autoscale zoom magnifies slightly on top, so each output
# pixel averages two source pixels. Bicubic reads a 4x4 neighbourhood and
# keeps ~90% of the detail (193 / 83) at the same cost. It can overshoot, so
# the result is clamped at 0 (linear light has no negative energy; the clip
# above 1 is the tone block's). The window variant must read the same taps:
# _REMAP_HALO is how many source pixels beyond the sampled position they
# reach (floor-1 .. floor+2).
_REMAP_INTERPOLATION = cv2.INTER_CUBIC
_REMAP_HALO = 2


# The maps of the last few frame sizes: a zoomed editor asks for the native
# frame's maps once per tile (and once per noise-probe block), and the coarse
# grid is ~0.6M samples per map there. A handful of MB each.
@functools.lru_cache(maxsize=3)
def _profile_maps(h: int, w: int, profile: LensProfile | RadialProfile, fd: float, fv: float) -> _ProfileMaps:
    return _ProfileMaps(h, w, profile, fd, fv)


def apply_profile(arr: np.ndarray, profile: LensProfile | RadialProfile, fd: float = 1.0, fv: float = 1.0) -> np.ndarray:
    h, w = arr.shape[:2]
    maps = _profile_maps(h, w, profile, round(fd, 4), round(fv, 4))
    if maps.noop:
        return arr
    planes = cv2.split(np.ascontiguousarray(arr, dtype=np.float32))
    out = np.empty((h, w, 3), dtype=np.float32)
    # Bands bound the maps' memory on a native frame; an editor-sized frame
    # goes in one piece, where the per-band overhead would dominate.
    band = h if h * w <= 6_000_000 else max(1, 512 // maps.step) * maps.step
    for y0 in range(0, h, band):
        y1 = min(h, y0 + band)
        for c, (mx, my) in enumerate(maps.channel_maps(y0, y1, 0, w)):
            out[y0:y1, :, c] = cv2.remap(
                planes[c], mx, my, _REMAP_INTERPOLATION, borderMode=cv2.BORDER_REPLICATE
            )
        np.maximum(out[y0:y1], 0.0, out=out[y0:y1])
        if maps.vignette:
            out[y0:y1] *= maps.window("gain", y0, y1, 0, w)[:, :, None]
    return out


def apply_profile_window(
    base: np.ndarray,
    profile: LensProfile | RadialProfile,
    box: tuple[int, int, int, int],
    fd: float = 1.0,
    fv: float = 1.0,
) -> np.ndarray:
    """apply_profile(base)[y0:y1, x0:x1] (box = x0, y0, x1, y1), without
    touching the rest of the frame: the maps are upsampled over the box only,
    and only the source rectangle they reach is converted to float32. The
    editor's zoomed tiles use it - the whole-frame path converted and warped
    all 40MP (a ~480MB float32 copy, 0.6-4s) per slider frame to keep a
    screenful of it. `base` may be float16."""
    x0, y0, x1, y1 = box
    h, w = base.shape[:2]
    maps = _profile_maps(h, w, profile, round(fd, 4), round(fv, 4))
    if maps.noop:
        return base[y0:y1, x0:x1].astype(np.float32)
    channel_maps = maps.channel_maps(y0, y1, x0, x1)
    # The source rectangle every sample of every channel reads from, with the
    # interpolation's taps on each side (_REMAP_HALO). Clamped to the frame,
    # where the cut's edge IS the frame's edge, so BORDER_REPLICATE replicates
    # the same pixels.
    halo = _REMAP_HALO
    sx0 = max(0, int(math.floor(min(float(mx.min()) for mx, _ in channel_maps))) - halo)
    sx1 = min(w, int(math.ceil(max(float(mx.max()) for mx, _ in channel_maps))) + halo + 1)
    sy0 = max(0, int(math.floor(min(float(my.min()) for _, my in channel_maps))) - halo)
    sy1 = min(h, int(math.ceil(max(float(my.max()) for _, my in channel_maps))) + halo + 1)
    if sx1 <= sx0 or sy1 <= sy0:  # the box maps entirely outside the frame
        sx0, sx1 = (0, w) if sx1 <= sx0 else (sx0, sx1)
        sy0, sy1 = (0, h) if sy1 <= sy0 else (sy0, sy1)
    src = np.ascontiguousarray(base[sy0:sy1, sx0:sx1], dtype=np.float32)
    out = np.empty((y1 - y0, x1 - x0, 3), dtype=np.float32)
    # Shifting a float32 map by an integer is exact (the map values' ulp is
    # below 1), so the remap samples the very positions the full one does.
    shifted: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for c, (mx, my) in enumerate(channel_maps):
        key = id(mx)
        if key not in shifted:
            shifted[key] = (mx - np.float32(sx0), my - np.float32(sy0))
        smx, smy = shifted[key]
        out[:, :, c] = cv2.remap(
            src[:, :, c], smx, smy, _REMAP_INTERPOLATION, borderMode=cv2.BORDER_REPLICATE
        )
    np.maximum(out, 0.0, out=out)
    if maps.vignette:
        out *= maps.window("gain", y0, y1, x0, x1)[:, :, None]
    return out
