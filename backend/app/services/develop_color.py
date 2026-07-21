"""Tone curves, colour grading and colour calibration for the develop pipeline.

Standalone numpy (no PIL / no imports from thumbnails, to avoid an import cycle).
All functions take and return an HxWx3 float32 array in 0..1 (RGB) and no-op when
their inputs are neutral. Wired into the tonal pass in services/thumbnails.py.

Shapes/keys match services/develop.py:
  - point_curves:      {luma|red|green|blue: [[x,y], ...]} on a 0..255 grid
  - parametric_curve:  {luma|red|green|blue: {highlights,lights,darks,shadows,
                        white_level,black_level,split1,split2,split3}}
  - color_grading:     {shadows|midtones|highlights|global: {hue,saturation,
                        luminance}, blending, balance}
  - color_calibration: {shadows_tint, red_hue, red_saturation, green_hue,
                        green_saturation, blue_hue, blue_saturation}
"""

from __future__ import annotations

import numpy as np

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
_IDENTITY_CURVE = [[0, 0], [255, 255]]
_GRID = np.linspace(0.0, 1.0, 256, dtype=np.float32)


# ----------------------------------------------------------------------------- curves

def _pchip_lut(points: list) -> np.ndarray:
    """256-entry float32 LUT (0..1) from control points on a 0..255 grid, using
    monotone cubic (Fritsch-Carlson) interpolation - smooth like a real tone
    curve but guaranteed not to overshoot/kink."""
    pts = sorted(([float(p[0]), float(p[1])] for p in points if len(p) >= 2), key=lambda p: p[0])
    # De-duplicate identical x (keep the last), need >= 2 to interpolate.
    xs, ys = [], []
    for x, y in pts:
        if xs and abs(x - xs[-1]) < 1e-6:
            ys[-1] = y
        else:
            xs.append(x)
            ys.append(y)
    if len(xs) < 2:
        return _GRID.copy()
    xs = np.array(xs, dtype=np.float64)
    ys = np.array(ys, dtype=np.float64)
    n = len(xs)
    h = np.diff(xs)
    delta = np.diff(ys) / h
    d = np.zeros(n)
    for i in range(1, n - 1):
        if delta[i - 1] * delta[i] <= 0:
            d[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])
    d[0] = delta[0]
    d[-1] = delta[-1]
    xq = np.arange(256, dtype=np.float64)
    idx = np.clip(np.searchsorted(xs, xq) - 1, 0, n - 2)
    out = np.empty(256, dtype=np.float64)
    for seg in range(n - 1):
        m = idx == seg
        if not m.any():
            continue
        t = (xq[m] - xs[seg]) / h[seg]
        t2 = t * t
        t3 = t2 * t
        h00 = 2 * t3 - 3 * t2 + 1
        h10 = t3 - 2 * t2 + t
        h01 = -2 * t3 + 3 * t2
        h11 = t3 - t2
        out[m] = h00 * ys[seg] + h10 * h[seg] * d[seg] + h01 * ys[seg + 1] + h11 * h[seg] * d[seg + 1]
    out[xq <= xs[0]] = ys[0]
    out[xq >= xs[-1]] = ys[-1]
    return np.clip(out / 255.0, 0.0, 1.0).astype(np.float32)


def _param_lut(p: dict) -> np.ndarray:
    """256-entry float32 LUT (0..1) from a parametric curve channel: region
    sliders (shadows/darks/lights/highlights) plus black/white level, blended as
    overlapping midtone-weighted bumps on the identity line."""
    x = _GRID
    y = x * 255.0

    def tent(centre: float, width: float) -> np.ndarray:
        return np.clip(1.0 - np.abs(x - centre) / width, 0.0, 1.0)

    y = y + p.get("shadows", 0) / 100.0 * 55.0 * tent(0.08, 0.34)
    y = y + p.get("darks", 0) / 100.0 * 55.0 * tent(0.35, 0.34)
    y = y + p.get("lights", 0) / 100.0 * 55.0 * tent(0.65, 0.34)
    y = y + p.get("highlights", 0) / 100.0 * 55.0 * tent(0.92, 0.34)
    y = y + p.get("black_level", 0) / 100.0 * 40.0 * (1.0 - x)
    y = y + p.get("white_level", 0) / 100.0 * 40.0 * x
    return np.clip(y / 255.0, 0.0, 1.0).astype(np.float32)


def _apply_lut(channel: np.ndarray, lut: np.ndarray) -> np.ndarray:
    return np.interp(channel, _GRID, lut).astype(np.float32)


def _is_identity_points(points) -> bool:
    return (not points) or points == _IDENTITY_CURVE


def _param_channel_neutral(p: dict) -> bool:
    return not any(p.get(k, 0) for k in ("highlights", "lights", "darks", "shadows", "white_level", "black_level"))


def apply_curves(arr: np.ndarray, adj: dict) -> np.ndarray:
    """Apply the active tone curve (point or parametric per curve_mode). The
    luma/master channel maps all of R,G,B through one LUT (a tone curve); the
    red/green/blue channels map their own channel only."""
    mode = adj.get("curve_mode", "point")
    channels = ("red", "green", "blue")
    if mode == "point":
        pc = adj.get("point_curves") or {}
        master = pc.get("luma")
        if not _is_identity_points(master):
            lut = _pchip_lut(master)
            for c in range(3):
                arr[..., c] = _apply_lut(arr[..., c], lut)
        for ci, ch in enumerate(channels):
            pts = pc.get(ch)
            if not _is_identity_points(pts):
                arr[..., ci] = _apply_lut(arr[..., ci], _pchip_lut(pts))
    else:
        pc = adj.get("parametric_curve") or {}
        master = pc.get("luma") or {}
        if not _param_channel_neutral(master):
            lut = _param_lut(master)
            for c in range(3):
                arr[..., c] = _apply_lut(arr[..., c], lut)
        for ci, ch in enumerate(channels):
            cp = pc.get(ch) or {}
            if not _param_channel_neutral(cp):
                arr[..., ci] = _apply_lut(arr[..., ci], _param_lut(cp))
    return np.clip(arr, 0.0, 1.0)


# ----------------------------------------------------------------------- colour grading

def _hue_shift_vec(hue: float, sat: float) -> np.ndarray:
    """A zero-sum RGB chroma direction for a hue (0..360) at the given saturation
    (0..100). Zero-sum so it tints colour without shifting luma."""
    h = (hue % 360.0) / 60.0
    c = 1.0
    x = c * (1.0 - abs(h % 2.0 - 1.0))
    table = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)]
    r, g, b = table[int(h) % 6]
    v = np.array([r, g, b], dtype=np.float32)
    v = v - v.mean()
    return v * (sat / 100.0)


def _wheel_neutral(w: dict) -> bool:
    return not (w.get("saturation", 0) or w.get("luminance", 0))


def apply_color_grading(arr: np.ndarray, g: dict) -> np.ndarray:
    """3-way colour grading: tint + lift shadows/midtones/highlights (and a global
    wheel) by luminance range. `balance` shifts the shadow/highlight pivot,
    `blending` softens the range crossover."""
    shadows = g.get("shadows", {})
    midtones = g.get("midtones", {})
    highlights = g.get("highlights", {})
    glob = g.get("global", {})
    if all(_wheel_neutral(w) for w in (shadows, midtones, highlights, glob)):
        return arr

    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    balance = g.get("balance", 0) / 100.0
    blend = g.get("blending", 50) / 100.0
    piv = float(np.clip(0.5 + balance * 0.35, 0.15, 0.85))

    sh_w = np.clip((piv - luma) / piv, 0.0, 1.0)
    hi_w = np.clip((luma - piv) / (1.0 - piv + 1e-6), 0.0, 1.0)
    # Smootherstep so the ranges cross over gently; blending widens the midtone
    # overlap (more blending -> softer, less isolated ranges).
    sh_w = sh_w * sh_w * (3.0 - 2.0 * sh_w)
    hi_w = hi_w * hi_w * (3.0 - 2.0 * hi_w)
    mid_w = np.clip(1.0 - sh_w - hi_w, 0.0, 1.0) * (0.6 + 0.4 * blend)

    tint_strength = 0.5
    lum_strength = 0.35
    for wheel, weight in ((shadows, sh_w), (midtones, mid_w), (highlights, hi_w), (glob, None)):
        if _wheel_neutral(wheel):
            continue
        w = 1.0 if weight is None else weight[..., None]
        tint = _hue_shift_vec(wheel.get("hue", 0), wheel.get("saturation", 0))
        if wheel.get("saturation", 0):
            arr = arr + w * tint * tint_strength
        lum = wheel.get("luminance", 0) / 100.0
        if lum:
            arr = arr + w * (lum * lum_strength)
    return np.clip(arr, 0.0, 1.0)


# -------------------------------------------------------------------- colour calibration

def _rgb_to_hsl(arr):
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


def _hsl_to_rgb(hue, sat, lum):
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


def apply_color_calibration(arr: np.ndarray, cal: dict) -> np.ndarray:
    """Camera-calibration-style primary shifts: rotate/saturate the red, green and
    blue primaries, plus a shadows tint. Approximated as hue/saturation shifts on
    three wide hue bands centred on the primaries (0/120/240 deg)."""
    sh_tint = cal.get("shadows_tint", 0)
    primaries = (
        (0.0, cal.get("red_hue", 0), cal.get("red_saturation", 0)),
        (120.0, cal.get("green_hue", 0), cal.get("green_saturation", 0)),
        (240.0, cal.get("blue_hue", 0), cal.get("blue_saturation", 0)),
    )
    if not sh_tint and not any(h or s for _, h, s in primaries):
        return arr

    hue, sat, lum = _rgb_to_hsl(arr)
    hue_shift = np.zeros_like(hue)
    sat_scale = np.ones_like(hue)
    for centre, h_adj, s_adj in primaries:
        if not h_adj and not s_adj:
            continue
        ang = np.abs(hue - centre)
        ang = np.minimum(ang, 360.0 - ang)
        # Wide raised-cosine window (+/-90 deg) around the primary.
        win = np.where(ang < 90.0, 0.5 + 0.5 * np.cos(np.pi * ang / 90.0), 0.0)
        hue_shift += win * (h_adj / 100.0 * 30.0)  # up to +/-30 deg
        sat_scale *= 1.0 + win * (s_adj / 100.0 * 0.5)
    hue = (hue + hue_shift) % 360.0
    sat = np.clip(sat * sat_scale, 0.0, 1.0)
    out = _hsl_to_rgb(hue, sat, lum)
    if sh_tint:
        # Shadows tint: green(-)/magenta(+) weighted toward the shadows.
        shadow_w = np.clip(1.0 - lum * 2.0, 0.0, 1.0)[..., None]
        tint = np.array([1.0, -1.0, 1.0], dtype=np.float32) * (sh_tint / 100.0 * 0.06)
        out = np.clip(out + shadow_w * tint, 0.0, 1.0)
    return out.astype(np.float32)
