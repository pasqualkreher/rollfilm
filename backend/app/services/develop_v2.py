"""Process version 2 of the develop pipeline's pixel maths.

An edit whose ``process`` is "2" (see develop.ENUM_SPEC) renders four things
differently from the original pipeline; everything else is shared. Edits saved
before this existed carry no key, read as "1" and never come through here, so
they look exactly as they did.

1. The colour tools - HSL mixer, global hue, colour grading, saturation and
   vibrance - work in Oklab instead of HSL / gamma-encoded RGB. HSL is not
   perceptual: turning a hue changes how bright it looks, saturating a blue
   sky drifts it toward purple, and a pushed colour leaves the gamut one
   channel at a time, which bends its hue again. In Oklab hue, chroma and
   lightness are separate numbers, and colours that leave sRGB are brought
   back toward their own grey rather than clipped per channel.
2. Highlights and Shadows read the tone they act on from a smoothed copy of
   the picture (an edge-aware base) instead of from each pixel. A lifted
   shadow then keeps the contrast of the detail inside it, where the plain
   curve flattens it - the difference between "the shadows are brighter" and
   "the shadows are grey".
3. Sharpening acts on luminance only (no colour fringes at edges) and is kept
   from overshooting the tones already next to the edge (no halos).
4. A mask's local adjustments are applied under the picture's highlight
   shoulder instead of on top of it, so darkening a bright sky brings its
   detail back the way the global Exposure slider would.

Same conventions as the rest of the pipeline: HxWx3 float32, no-ops when
neutral, radii measured against the whole frame.
"""

from __future__ import annotations

import math

import numpy as np

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

COLOR_BANDS: tuple[str, ...] = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")


def is_v2(adj: dict) -> bool:
    """Process version 2 and everything built on it."""
    return adj.get("process") in ("2", "3")


def measured_film_sims(adj: dict) -> bool:
    """Process version 3: the film simulations are the cubes fitted to the
    camera's own JPEGs (film_sims), where one exists."""
    return adj.get("process") == "3"


# ------------------------------------------------------------------ transfers

def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4)).astype(np.float32)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055).astype(np.float32)


# The two transfers as 16-bit tables: a gather instead of a pow per value, a
# third of the cost on a preview frame, and 16 bits of a 0..1 value is far
# below anything the 8-bit output can show.
_TABLE_AXIS = np.arange(65536, dtype=np.float32) / np.float32(65535.0)
_DECODE_TABLE = _srgb_to_linear(_TABLE_AXIS)
_ENCODE_TABLE = _linear_to_srgb(_TABLE_AXIS)


def _through_table(c: np.ndarray, table: np.ndarray) -> np.ndarray:
    """`c` (0..1, clipped here) through a 65536-entry table."""
    return table[(np.clip(c, 0.0, 1.0) * 65535.0 + 0.5).astype(np.uint16)]


# --------------------------------------------------------------------- Oklab
# Björn Ottosson's Oklab (https://bottosson.github.io/posts/oklab/), from and
# to linear sRGB.

_RGB_TO_LMS = np.array(
    [
        [0.4122214708, 0.5363325363, 0.0514459929],
        [0.2119034982, 0.6806995451, 0.1073969566],
        [0.0883024619, 0.2817188376, 0.6299787005],
    ],
    dtype=np.float32,
)
_LMS_TO_LAB = np.array(
    [
        [0.2104542553, 0.7936177850, -0.0040720468],
        [1.9779984951, -2.4285922050, 0.4505937099],
        [0.0259040371, 0.7827717662, -0.8086757660],
    ],
    dtype=np.float32,
)
_LAB_TO_LMS = np.array(
    [
        [1.0, 0.3963377774, 0.2158037573],
        [1.0, -0.1055613458, -0.0638541728],
        [1.0, -0.0894841775, -1.2914855480],
    ],
    dtype=np.float32,
)
_LMS_TO_RGB = np.array(
    [
        [4.0767416621, -3.3077115913, 0.2309699292],
        [-1.2684380046, 2.6097574011, -0.3413193965],
        [-0.0041960863, -0.7034186147, 1.7076147010],
    ],
    dtype=np.float32,
)


def _mix(arr: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """A 3x3 channel mix. cv2.transform on images (an order of magnitude
    faster than numpy's matmul over a trailing axis of 3); plain matmul for
    the handful of single colours the tables below are built from."""
    if arr.ndim == 3:
        import cv2

        return cv2.transform(arr, matrix)
    return arr @ matrix.T


def linear_to_oklab(lin: np.ndarray) -> np.ndarray:
    lms = _mix(np.maximum(lin, 0.0), _RGB_TO_LMS)
    if lms.ndim == 3:
        import cv2

        # Non-negative by construction, so cv2's pow is the cube root - at
        # under half the cost of np.cbrt.
        lms = cv2.pow(lms, 1.0 / 3.0)
    else:
        np.cbrt(lms, out=lms)
    return _mix(lms, _LMS_TO_LAB)


# Chroma is searched in this many halvings when a colour has to be brought back
# into sRGB: 1/128 of its chroma, well under what 8 bits can show.
_GAMUT_STEPS = 7
_GAMUT_SLACK = 1e-4


def _lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    lms = _mix(lab, _LAB_TO_LMS)
    lms *= lms * lms
    return _mix(lms, _LMS_TO_RGB)


def oklab_to_linear(lab: np.ndarray) -> np.ndarray:
    """Linear sRGB of an Oklab array, fitted into the sRGB gamut. A colour
    outside it has its chroma reduced - same lightness, same hue - until it
    fits. Clipping the channels one by one bends the hue instead (a pushed
    blue goes purple), and so does pulling the colour toward grey in RGB."""
    rgb = _lab_to_rgb(lab)
    hi = np.maximum(np.maximum(rgb[..., 0], rgb[..., 1]), rgb[..., 2])
    lo = np.minimum(np.minimum(rgb[..., 0], rgb[..., 1]), rgb[..., 2])
    out = (hi > 1.0 + _GAMUT_SLACK) | (lo < -_GAMUT_SLACK)
    if out.any():
        # (N, 1, 3): the shape cv2.transform takes, so the search below runs
        # at image speed on just the pixels that need it.
        px = lab[out][:, None, :]
        px[..., 0] = np.clip(px[..., 0], 0.0, 1.0)
        fits = np.zeros(px.shape[0], dtype=np.float32)
        over = np.ones(px.shape[0], dtype=np.float32)
        trial = px.copy()
        for _ in range(_GAMUT_STEPS):
            mid = 0.5 * (fits + over)
            trial[:, 0, 1] = px[:, 0, 1] * mid
            trial[:, 0, 2] = px[:, 0, 2] * mid
            t = _lab_to_rgb(trial)[:, 0, :]
            ok = (t.max(axis=1) <= 1.0 + _GAMUT_SLACK) & (t.min(axis=1) >= -_GAMUT_SLACK)
            fits = np.where(ok, mid, fits)
            over = np.where(ok, over, mid)
        trial[:, 0, 1] = px[:, 0, 1] * fits
        trial[:, 0, 2] = px[:, 0, 2] * fits
        rgb[out] = _lab_to_rgb(trial)[:, 0, :]
    return np.clip(rgb, 0.0, 1.0, out=rgb)


def _hsv_hue_to_rgb(hue: float) -> np.ndarray:
    """The fully saturated colour at an HSV hue (degrees), linear = encoded
    here since every channel is 0 or 1 or on the ramp between."""
    h = (hue % 360.0) / 60.0
    x = 1.0 - abs(h % 2.0 - 1.0)
    table = [(1, x, 0), (x, 1, 0), (0, 1, x), (0, x, 1), (x, 0, 1), (1, 0, x)]
    return np.array(table[int(h) % 6], dtype=np.float32)


def _oklab_of_hue(hue: float) -> np.ndarray:
    return linear_to_oklab(_srgb_to_linear(_hsv_hue_to_rgb(hue))[None, :])[0]


def _oklch_hue(hue: float) -> float:
    lab = _oklab_of_hue(hue)
    return math.degrees(math.atan2(float(lab[2]), float(lab[1]))) % 360.0


# The mixer's eight bands, as the Oklab hue angle of the colour each one is
# named for (the same colours the HSL mixer centres its bands on, so "Orange"
# still means orange). They come out in rising order, red near 29 degrees.
_BAND_HSL_HUES = (0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0)
_BAND_CENTRES = tuple(_oklch_hue(h) for h in _BAND_HSL_HUES)
assert all(b > a for a, b in zip(_BAND_CENTRES, _BAND_CENTRES[1:])), _BAND_CENTRES

# The colour-grading wheels name their hue the HSV way (0 = red, 120 = green);
# this is the Oklab direction each of those hues points in.
_WHEEL_DIRS = np.array(
    [(lambda v: v[1:] / max(float(np.hypot(v[1], v[2])), 1e-9))(_oklab_of_hue(float(h))) for h in range(360)],
    dtype=np.float32,
)

# Hue lookup resolution: half a degree.
_HUE_N = 720
_HUE_AXIS = (np.arange(_HUE_N, dtype=np.float32) + 0.5) * (360.0 / _HUE_N)

_RANGE_EXP = 4.0  # as in the HSL mixer: the blend exponent at Range +-100

# Vibrance spares skin: a window around the Oklab hue skin tones share.
_SKIN_HUE = 55.0
_SKIN_WIDTH = 28.0
_skin_d = np.abs(_HUE_AXIS - _SKIN_HUE)
_SKIN_WINDOW = np.where(
    _skin_d < _SKIN_WIDTH, 0.5 + 0.5 * np.cos(np.pi * _skin_d / _SKIN_WIDTH), 0.0
).astype(np.float32)


def _mixer_tables(mix: dict, ranges: dict, hue_deg: float):
    """Per-hue tables of what the mixer does: (cos, sin) of the hue rotation,
    the chroma scale and the luminance amount. Built once per render on the
    half-degree hue axis, so the per-pixel work is a lookup."""
    bands = np.array([list(mix.get(b, [0, 0, 0]))[:3] for b in COLOR_BANDS], dtype=np.float32)
    exps = [float(_RANGE_EXP ** (float((ranges or {}).get(b, 0)) / 100.0)) for b in COLOR_BANDS]
    centres = np.array(_BAND_CENTRES, dtype=np.float32)
    rel = (_HUE_AXIS - centres[0]) % 360.0
    edges = np.concatenate([(centres - centres[0]), [360.0]]).astype(np.float32)
    idx = np.clip(np.searchsorted(edges, rel, side="right") - 1, 0, 7)
    nxt = (idx + 1) % 8
    t = (rel - edges[idx]) / (edges[idx + 1] - edges[idx])
    a = np.array(exps, dtype=np.float32)[idx]
    b = np.array(exps, dtype=np.float32)[nxt]
    ta = np.power(t, a)
    tb = np.power(1.0 - t, b)
    f = ta / (ta + tb + 1e-9)
    vals = bands[idx] * (1.0 - f)[:, None] + bands[nxt] * f[:, None]
    # +-100 turns a band up to +-180 degrees, as in the HSL mixer; the global
    # hue slider turns everything on top.
    rot = np.radians(vals[:, 0] * 1.8 + float(hue_deg))
    return (
        np.cos(rot).astype(np.float32),
        np.sin(rot).astype(np.float32),
        np.maximum(1.0 + vals[:, 1] / 100.0, 0.0).astype(np.float32),
        (vals[:, 2] / 100.0).astype(np.float32),
    )


def _wheel_neutral(w: dict) -> bool:
    return not (w.get("saturation", 0) or w.get("luminance", 0))


# How far a grading wheel at full saturation moves a colour (Oklab chroma) and
# how far its luminance slider moves lightness at +-100.
_GRADE_CHROMA = 0.12
_GRADE_LIGHT = 0.25


def perceptual_color_active(adj: dict) -> bool:
    mix = adj.get("hsl") or {}
    grading = adj.get("color_grading") or {}
    return bool(
        adj.get("saturation", 0)
        or adj.get("vibrance", 0)
        or adj.get("hue", 0)
        or any(any(v) for v in mix.values())
        or not all(
            _wheel_neutral(grading.get(z) or {}) for z in ("shadows", "midtones", "highlights", "global")
        )
    )


# The pass is per-pixel, so a big frame goes through in bands of rows: the
# Oklab copy and its temporaries are then a band's worth instead of several
# whole frames (measured on a 40MP render: 1.2GB of peak memory, on machines
# where that is the difference between RAM and swap).
_BAND_PIXELS = 2_000_000


def apply_perceptual_color(arr: np.ndarray, adj: dict) -> np.ndarray:
    """The mixer, global hue, colour grading, saturation and vibrance on a
    display sRGB float array (0..1), in one trip through Oklab."""
    if not perceptual_color_active(adj):
        return arr
    h, w = arr.shape[:2]
    if h * w <= 2 * _BAND_PIXELS:
        return _perceptual_color(arr, adj)
    out = np.empty_like(arr, dtype=np.float32)
    rows = max(1, _BAND_PIXELS // w)
    for y0 in range(0, h, rows):
        out[y0 : y0 + rows] = _perceptual_color(arr[y0 : y0 + rows], adj)
    return out


def _perceptual_color(arr: np.ndarray, adj: dict) -> np.ndarray:
    lab = linear_to_oklab(_through_table(arr, _DECODE_TABLE))
    L = lab[..., 0]
    a = lab[..., 1]
    b = lab[..., 2]

    mix = adj.get("hsl") or {}
    hue_deg = float(adj.get("hue", 0) or 0)
    sat = adj.get("saturation", 0) / 100.0
    vib = adj.get("vibrance", 0) / 100.0
    mixer_on = bool(hue_deg or any(any(v) for v in mix.values()))

    hue_idx = None
    if mixer_on or vib > 0:
        hue = np.degrees(np.arctan2(b, a))
        hue_idx = (np.mod(hue, 360.0) * (_HUE_N / 360.0)).astype(np.int32)
        np.clip(hue_idx, 0, _HUE_N - 1, out=hue_idx)
        del hue

    if mixer_on:
        cos_t, sin_t, chroma_t, lum_t = _mixer_tables(mix, adj.get("hsl_range") or {}, hue_deg)
        cos_r = cos_t[hue_idx]
        sin_r = sin_t[hue_idx]
        scale = chroma_t[hue_idx]
        na = (a * cos_r - b * sin_r) * scale
        nb = (a * sin_r + b * cos_r) * scale
        if lum_t.any():
            # Luminance brightens or darkens the band's colour as a whole (all
            # three of L, a, b), so it stays the same colour. Greys have a hue
            # only by accident; the ramp on chroma keeps them out of it.
            chroma = np.hypot(a, b)
            weight = np.clip((chroma - 0.012) / 0.06, 0.0, 1.0)
            gain = np.power(np.maximum(1.0 + 0.9 * lum_t[hue_idx] * weight, 0.0), 0.8)
            L *= gain
            na *= gain
            nb *= gain
        a[...] = na
        b[...] = nb
        del na, nb, cos_r, sin_r, scale

    grading = adj.get("color_grading") or {}
    wheels = [(z, grading.get(z) or {}) for z in ("shadows", "midtones", "highlights", "global")]
    if not all(_wheel_neutral(w) for _, w in wheels):
        tone = np.clip(L, 0.0, 1.0)
        balance = grading.get("balance", 0) / 100.0
        blend = grading.get("blending", 50) / 100.0
        piv = float(np.clip(0.5 + balance * 0.35, 0.15, 0.85))
        sh_w = np.clip((piv - tone) / piv, 0.0, 1.0)
        hi_w = np.clip((tone - piv) / (1.0 - piv + 1e-6), 0.0, 1.0)
        sh_w = sh_w * sh_w * (3.0 - 2.0 * sh_w)
        hi_w = hi_w * hi_w * (3.0 - 2.0 * hi_w)
        mid_w = np.clip(1.0 - sh_w - hi_w, 0.0, 1.0) * (0.6 + 0.4 * blend)
        weights = {"shadows": sh_w, "midtones": mid_w, "highlights": hi_w, "global": None}
        da = np.zeros_like(L)
        db = np.zeros_like(L)
        dl = np.zeros_like(L)
        for zone, wheel in wheels:
            if _wheel_neutral(wheel):
                continue
            w = weights[zone]
            amount = wheel.get("saturation", 0) / 100.0 * _GRADE_CHROMA
            if amount:
                direction = _WHEEL_DIRS[int(round(float(wheel.get("hue", 0)))) % 360]
                da += (amount * direction[0]) if w is None else w * (amount * direction[0])
                db += (amount * direction[1]) if w is None else w * (amount * direction[1])
            light = wheel.get("luminance", 0) / 100.0 * _GRADE_LIGHT
            if light:
                dl += light if w is None else w * light
        a += da
        b += db
        L += dl
        np.clip(L, 0.0, 1.0, out=L)
        del da, db, dl, sh_w, hi_w, mid_w, tone

    if sat or vib:
        k = max(1.0 + sat, 0.0)
        if vib:
            # Vibrance pushes the muted colours and holds back the vivid ones;
            # going up it also spares skin tones.
            chroma = np.hypot(a, b)
            weight = 1.0 - 0.65 * np.clip(chroma / 0.22, 0.0, 1.0)
            if vib > 0 and hue_idx is not None:
                weight *= 1.0 - 0.5 * _SKIN_WINDOW[hue_idx]
            factor = np.maximum(1.0 + vib * weight, 0.0) * k
            a *= factor
            b *= factor
        elif k != 1.0:
            a *= k
            b *= k

    return _through_table(oklab_to_linear(lab), _ENCODE_TABLE)


# ---------------------------------------------------------------- local tone
# Highlights / Shadows decide how far to move a pixel from how bright its
# SURROUNDINGS are, not from the pixel itself. The surroundings are an
# edge-aware smooth of log luminance (a guided filter with the picture as its
# own guide): flat inside a region, following its outline. Every pixel of a
# shadow region then gets the same lift, so the texture inside it keeps its
# contrast; the plain curve lifts the darkest pixels most and flattens it.
#
# The filter runs on a small copy of the frame and only its two coefficient
# maps are scaled back up (the "fast guided filter"), so the cost does not
# grow with the frame and no frame-sized temporaries are needed: a band of
# rows asks for its own slice (base_rows).

# Long edge of the small copy the surroundings are measured on, and the
# filter's reach on it (so about a fiftieth of the frame either side).
_LOCAL_SMALL_PX = 512
_LOCAL_RADIUS = 10
# How much log-luminance variation (stops, squared) still counts as "the same
# region". Above it the base follows the picture - an edge; below it smooths.
_LOCAL_EPS = 0.5
_LOCAL_L_MIN, _LOCAL_L_MAX = -9.0, 6.0
_MIDDLE_GREY = 0.18


class LocalToneGuide:
    """The surroundings map of one frame, for the Highlights/Shadows sliders.
    `base_rows(l, y0)` gives the smoothed log luminance (stops from middle
    grey) for rows y0.. of the frame, given those rows' own `l`."""

    __slots__ = ("_a", "_b", "_sx", "_sy")

    def __init__(self, rgb_weights: np.ndarray, lin: np.ndarray, ref_long_edge: float | None = None):
        """`lin` is the linear frame (or the tile of it) being toned;
        `rgb_weights` turns one of its pixels into the luminance the tone
        curve will see (luma weights x gain x white balance)."""
        import cv2

        h, w = lin.shape[:2]
        f = min(1.0, _LOCAL_SMALL_PX / float(ref_long_edge or max(h, w)))
        sw, sh = max(1, int(round(w * f))), max(1, int(round(h * f)))
        if lin.dtype != np.float32:
            step = max(1, int(1.0 / max(f, 1e-6)) // 2)
            lin = lin[::step, ::step].astype(np.float32)
        small = cv2.resize(lin, (sw, sh), interpolation=cv2.INTER_AREA) if (sw, sh) != (lin.shape[1], lin.shape[0]) else lin
        y = small.reshape(sh, sw, 3) @ rgb_weights.astype(np.float32)
        l = np.clip(np.log2(np.maximum(y, 1e-6) / _MIDDLE_GREY), _LOCAL_L_MIN, _LOCAL_L_MAX).astype(np.float32)
        k = (2 * _LOCAL_RADIUS + 1, 2 * _LOCAL_RADIUS + 1)
        mean = cv2.blur(l, k, borderType=cv2.BORDER_REFLECT)
        var = cv2.blur(l * l, k, borderType=cv2.BORDER_REFLECT) - mean * mean
        a = var / (var + _LOCAL_EPS)
        b = (1.0 - a) * mean
        self._a = cv2.blur(a, k, borderType=cv2.BORDER_REFLECT)
        self._b = cv2.blur(b, k, borderType=cv2.BORDER_REFLECT)
        self._sx = sw / float(w)
        self._sy = sh / float(h)

    def base_rows(self, l: np.ndarray, y0: int = 0) -> np.ndarray:
        import cv2

        rows, w = l.shape[:2]
        # dst (x, y) -> src: pixel centres line up across the two scales.
        m = np.array(
            [
                [self._sx, 0.0, 0.5 * self._sx - 0.5],
                [0.0, self._sy, (y0 + 0.5) * self._sy - 0.5],
            ],
            dtype=np.float64,
        )
        flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
        a = cv2.warpAffine(self._a, m, (w, rows), flags=flags, borderMode=cv2.BORDER_REPLICATE)
        b = cv2.warpAffine(self._b, m, (w, rows), flags=flags, borderMode=cv2.BORDER_REPLICATE)
        a *= np.clip(l, _LOCAL_L_MIN, _LOCAL_L_MAX)
        a += b
        return a


def local_tone_active(adj: dict) -> bool:
    return is_v2(adj) and bool(adj.get("highlights", 0) or adj.get("shadows", 0))


# ----------------------------------------------------------------- sharpening

# How much of the overshoot past the neighbouring tones is let through. Zero
# would be a hard clamp (edges go plasticky); this keeps a trace of bite.
_SHARPEN_OVERSHOOT = 0.35


def sharpen(arr: np.ndarray, radius: float, amount: float, threshold: float = 0.0) -> np.ndarray:
    """Sharpening on luminance, applied to RGB as one shared ratio so an edge
    gains contrast and no colour, with the result held near the range of the
    tones already around each pixel so no bright or dark line is drawn beside
    the edge. `threshold` as in the unsharp mask it replaces (0..80, in 0..255
    luma units): detail weaker than it is left alone."""
    import cv2

    y = np.clip(arr, 0.0, 1.0).astype(np.float32) @ _LUMA
    blur = cv2.GaussianBlur(y, (0, 0), radius)
    hp = y - blur
    if threshold > 0:
        hp *= np.clip(np.abs(hp) / (threshold / 255.0), 0.0, 1.0)
    y_out = y + amount * hp
    kernel = np.ones((3, 3), np.uint8)
    lo = cv2.erode(y, kernel)
    hi = cv2.dilate(y, kernel)
    over = np.clip(y_out, lo, hi)
    y_out = over + _SHARPEN_OVERSHOOT * (y_out - over)
    np.maximum(y, 1e-6, out=y)
    ratio = np.maximum(y_out, 0.0) / y
    # Capped where brightening would push a channel past 1 (see _clarity).
    peak = np.maximum(np.maximum(arr[..., 0], arr[..., 1]), arr[..., 2])
    np.maximum(peak, 1e-6, out=peak)
    np.minimum(ratio, np.reciprocal(peak), out=ratio)
    return np.clip(arr * ratio[..., None], 0.0, 1.0)


# ------------------------------------------------- scene-referred local tone

def inverse_shoulder_ratio(y: np.ndarray, white: float) -> np.ndarray:
    """The luminance ratio that undoes raw.reinhard_ratio for white point
    `white`: display-linear luminance in, the scene luminance it came from
    out (as a ratio, to scale RGB by). Identity for white <= 1."""
    w2 = max(float(white), 1.0) ** 2
    if w2 <= 1.0 + 1e-9:
        return np.ones_like(y, dtype=np.float32)
    d = np.clip(y, 0.0, 1.0)
    # d = s(1 + s/W^2)/(1 + s)  =>  s^2/W^2 + s(1 - d) - d = 0
    one_d = 1.0 - d
    scene = 0.5 * w2 * (-one_d + np.sqrt(one_d * one_d + 4.0 * d / w2))
    return np.where(d > 1e-6, scene / np.maximum(d, 1e-6), 1.0).astype(np.float32)
