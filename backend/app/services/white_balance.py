"""The colour temperature a RAW was shot at, in Kelvin.

The editor's white-balance slider is a relative one underneath (warmer/cooler
than the camera's choice); to label it in Kelvin, the way the camera does, it
needs to know where the camera's choice sits. Read from the file's metadata
only - nothing is decoded - and remembered per file.

Three sources, best first:
  - a ColorTemperature tag (the camera was set to a Kelvin value, or reports
    the one its auto mode picked);
  - Fuji: the as-shot channel levels against the two calibration points the
    RAF carries (WB_GRBLevelsStandard: Standard Light A and D65), interpolated
    in mired along log(R/B) - which is very nearly linear in mired;
  - LibRaw's XYZ->camera matrix, where it has one for the model: the as-shot
    neutral through the inverse matrix, then McCamy's formula.
None when the file gives no usable hint; the editor then keeps the plain
relative slider.

For a Fuji RAF the same calibration also says what the camera itself would do
at any other Kelvin setting: its channel multipliers there, interpolated the
same way. `kelvin_gains` turns that into the red/blue gains (relative to the
as-shot balance, green = 1) the editor's slider applies - so 6500 K here is
the picture the camera's 6500 K gives, rather than a generic black-body
estimate. The gains are the camera's own, taken through LibRaw's camera->sRGB
matrix where it has one for the model (the render applies them after that
matrix); measured on an X-E5, where it has none, they come out to the third
decimal of a re-decode at the camera's multipliers.
"""

from __future__ import annotations

import logging
import math
import os
import threading
from collections import OrderedDict
from pathlib import Path

from app.services import camera_matrix

logger = logging.getLogger(__name__)

# EXIF LightSource codes -> Kelvin, for the calibration pairs.
_ILLUMINANT_K = {17: 2856.0, 18: 4874.0, 19: 6774.0, 20: 5503.0, 21: 6504.0, 22: 7504.0, 23: 5003.0}

_KELVIN_MIN, _KELVIN_MAX = 1800, 15000

_TAGS = ["ColorTemperature", "WB_GRBLevels", "WB_GRBLevelsStandard"]

# Its own exiftool process: a -stay_open helper cannot be shared across
# threads (see exif.new_helper), and request threads call in here.
_lock = threading.Lock()
_helper = None
_cache: "OrderedDict[tuple[str, int], dict]" = OrderedDict()
_CACHE_MAX = 512


def _numbers(value) -> list[float]:
    try:
        return [float(part) for part in str(value).split()]
    except ValueError:
        return []


def _fuji_calibration(standard) -> tuple[float, float, float, float] | None:
    """The RAF's two calibration lights as (ln R/G at A, ln R/G at D65,
    ln B/G at A, ln B/G at D65). `standard` is one "G R B illuminant" group
    per light."""
    cal = _numbers(standard)
    points = {}
    for i in range(0, len(cal) - 3, 4):
        g, r, b, illuminant = cal[i : i + 4]
        if g > 0 and r > 0 and b > 0:
            points[int(illuminant)] = (math.log(r / g), math.log(b / g))
    if 17 not in points or 21 not in points:
        return None
    (r_a, b_a), (r_d, b_d) = points[17], points[21]
    if r_a == r_d or b_a == b_d:
        return None
    return r_a, r_d, b_a, b_d


# Fuji's Kelvin scale, measured: 145 frames shot in the camera's Kelvin mode
# (5100, 5500, 6600 and 7300 K, X-T30 II), their as-shot multipliers with the
# WB shift taken back out, expressed as a fraction of the way from the file's
# Standard Light A point (0) to its D65 point (1) - which makes the curve
# carry over to other bodies, whose two points differ. Along the mired axis
# (d = mired(A) - mired(K)):
#   red   runs straight:                 u = 0.00528 d
#   blue  runs straight up to 5100 K     u = 0.005006 d
#         and bends upward past it       u = 0.771 + 0.0078 x + 0.000033 x^2,
#                                        x = d - 154
# The straight line through A and D65 that the two points alone suggest is
# close for red and falls short for blue at high Kelvin (by 14% of gain at
# 7300 K): the camera's 6500 K is the black body's, not D65's. Below 2856 K
# and above 7300 K the curve is extrapolated - no frame was shot there.
_MIRED_A = 1e6 / 2856.0


def _fuji_u(kelvin: float) -> tuple[float, float]:
    d = _MIRED_A - 1e6 / kelvin
    red = 0.00528 * d
    if d <= 154.0:
        blue = 0.005006 * d
    else:
        x = d - 154.0
        blue = 0.771 + 0.0078 * x + 0.000033 * x * x
    return red, blue


def _fuji_levels_at(kelvin: float, cal: tuple[float, float, float, float]) -> tuple[float, float]:
    """(ln R/G, ln B/G) of the camera's multipliers at `kelvin`."""
    r_a, r_d, b_a, b_d = cal
    u_r, u_b = _fuji_u(kelvin)
    return r_a + u_r * (r_d - r_a), b_a + u_b * (b_d - b_a)


def _from_fuji_levels(levels, standard) -> float | None:
    """The Kelvin setting whose red/blue balance is the as-shot one. `levels`
    is "G R B" as shot."""
    shot = _numbers(levels)
    cal = _fuji_calibration(standard)
    if len(shot) < 3 or cal is None or min(shot[:3]) <= 0:
        return None
    target = math.log(shot[1] / shot[2])

    def balance(kelvin: float) -> float:
        r, b = _fuji_levels_at(kelvin, cal)
        return r - b

    lo, hi = float(_KELVIN_MIN), float(_KELVIN_MAX)
    at_lo, at_hi = balance(lo), balance(hi)
    if not min(at_lo, at_hi) <= target <= max(at_lo, at_hi):
        return None
    rising = at_hi > at_lo
    for _ in range(50):
        mid = (lo + hi) / 2.0
        if (balance(mid) < target) == rising:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


# The Kelvin settings the gain table is sampled at - the camera's own range.
_TABLE_KELVINS = tuple(range(2500, 10001, 100))


def _through_matrix(cam: list[float], matrix) -> list[float] | None:
    """Camera-space gains (green = 1) as the red/blue gains the render applies
    after the camera->sRGB matrix, for a neutral: [red, blue], green = 1."""
    if matrix is not None:
        cam = [sum(matrix[i][j] * cam[j] for j in range(3)) for i in range(3)]
    if min(cam) <= 0:
        return None
    return [round(cam[0] / cam[1], 5), round(cam[2] / cam[1], 5)]


def _fuji_gains(as_shot_kelvin: float, standard, matrix) -> list[list[float]] | None:
    """[[kelvin, red gain, blue gain], ...] (green = 1): the camera's
    multipliers at each Kelvin over those at the as-shot Kelvin. Relative to
    the curve, not to the as-shot levels themselves, so whatever tint the
    camera's auto mode chose stays in the picture and the slider starts from
    the picture as shot."""
    cal = _fuji_calibration(standard)
    if cal is None:
        return None
    base_r, base_b = _fuji_levels_at(as_shot_kelvin, cal)
    table = []
    for kelvin in _TABLE_KELVINS:
        r, b = _fuji_levels_at(float(kelvin), cal)
        gains = _through_matrix([math.exp(r - base_r), 1.0, math.exp(b - base_b)], matrix)
        if gains is None:
            return None
        table.append([kelvin, *gains])
    return table


def _planck_xyz(kelvin: float) -> tuple[float, float, float]:
    """XYZ (Y = 1) of the black body at `kelvin` (Kim et al.'s locus fit)."""
    t = min(25000.0, max(1667.0, kelvin))
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x / y, 1.0, (1.0 - x - y) / y


# Linear sRGB -> XYZ (D65).
_XYZ_FROM_SRGB = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
]


def _libraw_matrices(path: Path):
    """(XYZ->camera, camera->sRGB with rows normalised, as-shot multipliers),
    each None where LibRaw has nothing for this model - it then leaves the
    camera's channels as they are (measured on an X-E5), and so do the gains."""
    import numpy as np
    import rawpy

    with rawpy.imread(str(path)) as raw:
        wb = np.array(raw.camera_whitebalance[:3], dtype=float)
        xyz_cam = np.array(raw.rgb_xyz_matrix[:3], dtype=float)
        cam_rgb = np.array(raw.color_matrix, dtype=float)[:, :3]
    if not xyz_cam.any() and not cam_rgb.any():
        # A model that borrows a sibling's matrix in the decode (see
        # camera_matrix) has to borrow it here as well: the gains are applied
        # after that matrix.
        borrowed = camera_matrix.borrowed_xyz_to_camera(path)
        if borrowed is not None:
            xyz_cam = borrowed
    has_xyz = bool(xyz_cam.any())
    to_srgb = None
    if cam_rgb.any():
        sums = cam_rgb.sum(axis=1, keepdims=True)
        if not (sums == 0).any():
            to_srgb = (cam_rgb / sums).tolist()
    elif has_xyz:
        # rawpy only hands out a camera->sRGB matrix the file itself carries;
        # for the rest LibRaw builds it from its XYZ->camera table, the way
        # dcraw does: sRGB->camera with each row scaled to sum to 1 (white
        # stays white), inverted.
        srgb_cam = xyz_cam @ _XYZ_FROM_SRGB
        srgb_cam = srgb_cam / srgb_cam.sum(axis=1, keepdims=True)
        to_srgb = np.linalg.inv(srgb_cam).tolist()
    return (
        xyz_cam if has_xyz else None,
        to_srgb,
        wb if (wb > 0).all() else None,
    )


def _libraw_model(xyz_cam, cam_rgb, wb) -> tuple[float | None, list[list[float]] | None]:
    """Any camera LibRaw has a colour matrix for: the as-shot Kelvin from the
    as-shot neutral (through the inverse matrix, McCamy's formula), and the
    gain table from what the camera's channels see of a black body at each
    Kelvin - the multipliers that would neutralise it, over those at the
    as-shot Kelvin."""
    import numpy as np

    if xyz_cam is None or wb is None:
        return None, None
    xyz = np.linalg.solve(xyz_cam, 1.0 / wb)
    total = float(xyz.sum())
    if total <= 0:
        return None, None
    x, y = float(xyz[0]) / total, float(xyz[1]) / total
    n = (x - 0.3320) / (0.1858 - y)
    kelvin = 449.0 * n**3 + 3525.0 * n**2 + 6823.3 * n + 5520.33
    if not _KELVIN_MIN <= kelvin <= _KELVIN_MAX:
        return None, None

    def neutral(k: float):
        return xyz_cam @ np.array(_planck_xyz(k))

    base = neutral(kelvin)
    if (base <= 0).any():
        return kelvin, None
    table = []
    for k in _TABLE_KELVINS:
        seen = neutral(float(k))
        if (seen <= 0).any():
            return kelvin, None
        cam = (base / seen) / (base[1] / seen[1])
        gains = _through_matrix(cam.tolist(), cam_rgb)
        if gains is None:
            return kelvin, None
        table.append([k, *gains])
    return kelvin, table


def close_helper() -> None:
    """End this module's exiftool process on backend shutdown (exif.close_helper)."""
    global _helper
    helper, _helper = _helper, None
    if helper is not None:
        try:
            helper.terminate()
        except Exception:
            pass


def _read(path: Path) -> tuple[float | None, list[list[float]] | None]:
    global _helper
    import exiftool

    try:
        if _helper is None:
            _helper = exiftool.ExifToolHelper(executable=os.environ.get("EXIFTOOL_PATH") or "exiftool")
        metadata = _helper.get_tags([str(path)], _TAGS)[0]
    except Exception:
        logger.debug("white balance tags unreadable for %s", path, exc_info=True)
        metadata = {}
    tags = {key.split(":")[-1]: value for key, value in metadata.items()}

    try:
        xyz_cam, cam_rgb, wb = _libraw_matrices(path)
    except Exception:
        logger.debug("no LibRaw colour data for %s", path, exc_info=True)
        xyz_cam = cam_rgb = wb = None

    # Fuji first: the camera's own calibration beats a generic black body.
    standard = tags.get("WB_GRBLevelsStandard")
    fuji = _from_fuji_levels(tags.get("WB_GRBLevels"), standard)
    if fuji:
        return fuji, _fuji_gains(fuji, standard, cam_rgb)
    try:
        kelvin, gains = _libraw_model(xyz_cam, cam_rgb, wb)
    except Exception:
        logger.debug("no LibRaw white balance for %s", path, exc_info=True)
        kelvin, gains = None, None
    if kelvin:
        return kelvin, gains
    try:
        kelvin = float(tags.get("ColorTemperature"))
        if _KELVIN_MIN <= kelvin <= _KELVIN_MAX:
            return kelvin, None
    except (TypeError, ValueError):
        pass
    return None, None


def white_balance_info(path: Path) -> dict:
    """{"kelvin": the as-shot colour temperature of a RAW rounded to 10 K (or
    None), "gains": the camera's Kelvin table (see kelvin_gains in the module
    docstring; None when the file carries no calibration)}."""
    from app.services.raw import is_raw

    nothing = {"kelvin": None, "gains": None}
    if not is_raw(path):
        return nothing
    try:
        key = (str(path), path.stat().st_mtime_ns)
    except OSError:
        return nothing
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        kelvin, gains = _read(path)
        known = bool(kelvin and _KELVIN_MIN <= kelvin <= _KELVIN_MAX)
        result = {
            "kelvin": int(round(kelvin / 10.0) * 10) if known else None,
            "gains": gains if known else None,
        }
        _cache[key] = result
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
        return result


def as_shot_kelvin(path: Path) -> int | None:
    return white_balance_info(path)["kelvin"]
