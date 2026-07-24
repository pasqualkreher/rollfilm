"""Built-in film simulation looks for the develop pipeline.

Each look approximates a Fujifilm film simulation (Provia, Velvia, Classic
Chrome, ...) as a parametric recipe: white-balance nudge, hue-windowed
colour twists, chroma-weighted deepening (the Color Chrome idea), a tone
curve, split toning, or a B&W channel mix. A recipe is baked once into a
33x33x33 RGB cube and applied to images by trilinear interpolation, so the
per-pixel cost is one LUT sample no matter how many operations a look
stacks - and shipping a user-facing .cube loader later only needs to feed
this same cube format.

Contract matches develop_effects: apply_film_sim takes and returns an HxWx3
float32 array in 0..1 (display-referred sRGB) and returns the input
untouched for the neutral look / zero intensity. Runs at the head of the
display colour block in services/thumbnails.py, so the "film stock" is the
base the user's curves/HSL/grading layer on top of - like a camera baking
the simulation before in-body adjustments.

The recipes are hand-tuned approximations of the in-camera looks, not
measured camera profiles: colour placement and tonality follow each stock's
documented character (Velvia's deepened saturated primaries, Classic
Chrome's muted reds and hard shadows, Eterna's flat low-chroma tone, ...).
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from app.services.develop import ENUM_SPEC
from app.services.develop_color import _pchip_lut

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Cube edge resolution. 33 is the conventional .cube size: fine enough that
# trilinear interpolation of smooth recipes is visually transparent, small
# enough (~430 KB float32) to bake lazily and keep every look cached.
_CUBE_N = 33

# One recipe per look; every field optional:
#   wb:     (r, g, b) channel gains - subtle cast baked into the stock
#   hues:   [(centre_deg, width_deg, hue_shift_deg, sat_mult, lum_mult), ...]
#           raised-cosine windows on the hue wheel (wraparound), like the
#           chrome-blue window in thumbnails._apply_chrome
#   sat:    global HSL saturation multiplier
#   deepen: chroma-weighted darkening 0..1 (Color Chrome-style depth)
#   curve:  tone-curve control points on the 0..255 grid (PCHIP, per channel)
#   split:  (shadow_hue, shadow_amt, highlight_hue, highlight_amt) toning
#   bw:     (r, g, b) channel-mix weights - makes the look monochrome
_SHARED_ACROS_CURVE = [(0, 0), (52, 40), (128, 127), (208, 214), (255, 255)]
_RECIPES: dict[str, dict] = {
    # Standard: gentle S-curve, slightly rich but honest colour.
    "provia": {
        "curve": [(0, 0), (60, 52), (128, 130), (200, 206), (255, 255)],
        "sat": 1.10,
        "deepen": 0.10,
        "hues": [(215, 80, 0.0, 1.06, 1.0)],
    },
    # Vivid: punchy contrast, deepened saturated primaries (reds/greens/blues).
    "velvia": {
        "curve": [(0, 0), (52, 40), (128, 131), (206, 216), (255, 255)],
        "sat": 1.32,
        "deepen": 0.24,
        "hues": [(0, 50, -2.0, 1.18, 0.98),
                 (120, 70, -6.0, 1.15, 0.97),
                 (225, 70, -4.0, 1.18, 0.96)],
    },
    # Soft: smooth highlight rolloff, protected skin tones, still-vivid blues.
    "astia": {
        "curve": [(0, 2), (64, 62), (128, 131), (200, 204), (255, 253)],
        "sat": 1.12,
        "deepen": 0.08,
        "hues": [(25, 45, 2.0, 0.94, 1.02), (210, 80, 0.0, 1.10, 1.0)],
    },
    # Documentary: muted colour (reds most), hard shadow tonality, teal-leaning
    # blues, slightly warm-dry cast.
    "classic_chrome": {
        "wb": (1.01, 1.0, 0.985),
        "curve": [(0, 0), (48, 38), (128, 124), (210, 214), (255, 252)],
        "sat": 0.84,
        "deepen": 0.20,
        "hues": [(0, 45, 4.0, 0.78, 0.96),
                 (30, 40, -4.0, 0.88, 1.0),
                 (210, 70, -8.0, 0.92, 0.94)],
    },
    # Film-negative print look: greens swung toward cyan, warm reds, cyan
    # shadows against warm highlights, punchy midtone contrast.
    "classic_neg": {
        "curve": [(0, 4), (56, 42), (128, 128), (204, 214), (255, 250)],
        "sat": 0.90,
        "deepen": 0.16,
        "hues": [(10, 40, 8.0, 1.05, 1.0),
                 (110, 70, 18.0, 0.82, 0.96),
                 (220, 60, -6.0, 0.88, 0.95)],
        "split": (200, 0.05, 45, 0.05),
    },
    # Faded-print warmth: amber highlights over rich, slightly lifted shadows.
    "nostalgic_neg": {
        "wb": (1.02, 1.0, 0.97),
        "curve": [(0, 6), (60, 52), (128, 132), (204, 210), (255, 250)],
        "sat": 0.95,
        "deepen": 0.12,
        "hues": [(35, 50, 3.0, 1.05, 1.02), (200, 70, 0.0, 0.90, 0.97)],
        "split": (30, 0.03, 42, 0.06),
    },
    # Cinema: flat low-contrast tone, lifted blacks, soft highlights, low chroma.
    "eterna": {
        "curve": [(0, 10), (64, 68), (128, 128), (196, 190), (255, 244)],
        "sat": 0.72,
        "deepen": 0.10,
        "split": (210, 0.03, 45, 0.02),
    },
    # B&W: orthopanchromatic-style mix with deep blacks and a fine shoulder;
    # the Ye/R variants mimic contrast filters (darkening skies as R grows).
    "acros": {"bw": (0.25, 0.60, 0.15), "curve": _SHARED_ACROS_CURVE},
    "acros_ye": {"bw": (0.35, 0.55, 0.10), "curve": _SHARED_ACROS_CURVE},
    "acros_r": {"bw": (0.55, 0.38, 0.07), "curve": _SHARED_ACROS_CURVE},
    "monochrome": {
        "bw": (0.30, 0.59, 0.11),
        "curve": [(0, 2), (64, 60), (128, 128), (200, 202), (255, 253)],
    },
}

# The enum values develop.py registers: neutral first, then the looks in
# display order (the frontend list mirrors this order). A recipe the schema
# doesn't know (or vice versa) could never be selected, so fail at import.
SIM_NAMES: tuple[str, ...] = ("none", *_RECIPES.keys())
assert SIM_NAMES == ENUM_SPEC["film_sim"][1], (
    "film_sims.SIM_NAMES out of sync with develop.ENUM_SPEC['film_sim']: "
    f"{set(SIM_NAMES) ^ set(ENUM_SPEC['film_sim'][1])}"
)


def _rgb_to_hsl(arr: np.ndarray):
    """Vectorised RGB->HSL on ...x3 float 0..1 (hue in degrees 0..360)."""
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = arr.max(axis=-1)
    mn = arr.min(axis=-1)
    c = mx - mn
    lum = (mx + mn) / 2.0
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = np.where(c <= 1e-12, 0.0, c / (1.0 - np.abs(2.0 * lum - 1.0) + 1e-12))
        hue = np.zeros_like(mx)
        m = (mx == r) & (c > 1e-12)
        hue[m] = ((g - b)[m] / c[m]) % 6.0
        m = (mx == g) & (c > 1e-12)
        hue[m] = (b - r)[m] / c[m] + 2.0
        m = (mx == b) & (c > 1e-12)
        hue[m] = (r - g)[m] / c[m] + 4.0
    return hue * 60.0, np.clip(sat, 0.0, 1.0), lum


def _hsl_to_rgb(hue: np.ndarray, sat: np.ndarray, lum: np.ndarray) -> np.ndarray:
    c = (1.0 - np.abs(2.0 * lum - 1.0)) * sat
    hp = (hue % 360.0) / 60.0
    x = c * (1.0 - np.abs(hp % 2.0 - 1.0))
    z = np.zeros_like(c)
    seg = np.floor(hp).astype(np.int32) % 6
    r = np.select([seg == 0, seg == 1, seg == 2, seg == 3, seg == 4], [c, x, z, z, x], c)
    g = np.select([seg == 0, seg == 1, seg == 2, seg == 3, seg == 4], [x, c, c, x, z], z)
    b = np.select([seg == 0, seg == 1, seg == 2, seg == 3, seg == 4], [z, z, x, c, c], x)
    m = lum - c / 2.0
    return np.stack([r + m, g + m, b + m], axis=-1)


def _hue_window(hue: np.ndarray, centre: float, width: float) -> np.ndarray:
    """Raised-cosine weight around a hue centre with wheel wraparound."""
    ang = np.abs(hue - centre)
    ang = np.minimum(ang, 360.0 - ang)
    return np.where(ang < width, 0.5 + 0.5 * np.cos(np.pi * ang / width), 0.0)


def _bake(recipe: dict, grid: np.ndarray) -> np.ndarray:
    """Run a recipe over the identity cube samples (Nx3 float 0..1)."""
    arr = grid.copy()
    wb = recipe.get("wb")
    if wb:
        arr = arr * np.asarray(wb, dtype=np.float32)

    bw = recipe.get("bw")
    if bw:
        w = np.asarray(bw, dtype=np.float64)
        mono = np.clip(arr @ (w / w.sum()), 0.0, 1.0)
        arr = np.repeat(mono[..., None], 3, axis=-1)
    else:
        hue, sat, lum = _rgb_to_hsl(np.clip(arr, 0.0, 1.0))
        for centre, width, shift, sat_mult, lum_mult in recipe.get("hues", ()):
            w = _hue_window(hue, centre, width) * np.clip(sat * 2.0, 0.0, 1.0)
            hue = hue + shift * w
            sat = sat * (1.0 + (sat_mult - 1.0) * w)
            lum = lum * (1.0 + (lum_mult - 1.0) * w)
        sat = np.clip(sat * recipe.get("sat", 1.0), 0.0, 1.0)
        arr = _hsl_to_rgb(hue, sat, np.clip(lum, 0.0, 1.0))
        deepen = recipe.get("deepen", 0.0)
        if deepen:
            # Chroma-weighted darkening in RGB keeps channel ratios, so tones
            # gain density instead of clipping (same idea as _apply_chrome).
            chroma = arr.max(axis=-1) - arr.min(axis=-1)
            arr = arr * (1.0 - deepen * np.power(np.clip(chroma * 1.3, 0.0, 1.0), 1.5))[..., None]

    curve = recipe.get("curve")
    if curve:
        lut = _pchip_lut([list(p) for p in curve])
        xs = np.linspace(0.0, 1.0, 256, dtype=np.float32)
        arr = np.stack([np.interp(np.clip(arr[..., c], 0.0, 1.0), xs, lut) for c in range(3)], axis=-1)

    split = recipe.get("split")
    if split:
        sh_hue, sh_amt, hi_hue, hi_amt = split
        luma = np.clip(arr @ _LUMA, 0.0, 1.0)
        for tint_hue, amt, weight in ((sh_hue, sh_amt, (1.0 - luma) ** 2), (hi_hue, hi_amt, luma**2)):
            ones = np.ones_like(luma)
            tint = _hsl_to_rgb(ones * tint_hue, ones, ones * 0.5)
            arr = arr + (tint - 0.5) * (amt * weight)[..., None]

    return np.clip(arr, 0.0, 1.0)


@lru_cache(maxsize=None)
def _sim_cube(sim: str) -> np.ndarray | None:
    """The look's baked NxNxNx3 float32 cube, indexed [r][g][b], or None."""
    recipe = _RECIPES.get(sim)
    if recipe is None:
        return None
    axis = np.linspace(0.0, 1.0, _CUBE_N, dtype=np.float32)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([r, g, b], axis=-1).reshape(-1, 3)
    return _bake(recipe, grid).reshape(_CUBE_N, _CUBE_N, _CUBE_N, 3).astype(np.float32)


def _sample_cube(arr: np.ndarray, cube: np.ndarray) -> np.ndarray:
    """Trilinear interpolation of an HxWx3 0..1 array through the cube.

    Gathers the 8 lattice corners through a flattened (N^3, 3) view with 1-D
    take() calls - one multi-axis fancy-index per corner on the 4-D cube costs
    several times more, which matters at editor-preview resolution."""
    n = cube.shape[0]
    flat = cube.reshape(-1, 3)
    x = np.clip(arr, 0.0, 1.0).reshape(-1, 3) * (n - 1)
    i0 = np.minimum(x.astype(np.int32), n - 2)
    f = (x - i0).astype(np.float32)
    fr, fg, fb = f[:, 0:1], f[:, 1:2], f[:, 2:3]
    base = (i0[:, 0] * n + i0[:, 1]) * n + i0[:, 2]  # index of the low corner
    # Blend the corners axis by axis: b (stride 1), then g (stride n), then r
    # (stride n*n).
    c00 = flat.take(base, axis=0) * (1 - fb) + flat.take(base + 1, axis=0) * fb
    c01 = flat.take(base + n, axis=0) * (1 - fb) + flat.take(base + n + 1, axis=0) * fb
    c10 = flat.take(base + n * n, axis=0) * (1 - fb) + flat.take(base + n * n + 1, axis=0) * fb
    c11 = flat.take(base + n * n + n, axis=0) * (1 - fb) + flat.take(base + n * n + n + 1, axis=0) * fb
    c0 = c00 * (1 - fg) + c01 * fg
    c1 = c10 * (1 - fg) + c11 * fg
    return (c0 * (1 - fr) + c1 * fr).astype(np.float32).reshape(arr.shape)


def apply_film_sim(arr: np.ndarray, sim: str | None, intensity: float = 100) -> np.ndarray:
    """Apply a built-in look to a display-referred sRGB float array (0..1),
    blended by ``intensity`` percent. Neutral look / zero intensity: no-op."""
    if not sim or sim == "none" or intensity <= 0:
        return arr
    cube = _sim_cube(sim)
    if cube is None:
        return arr
    base = np.clip(arr, 0.0, 1.0).astype(np.float32)
    out = _sample_cube(base, cube)
    w = min(100.0, float(intensity)) / 100.0
    if w < 1.0:
        out = base + (out - base) * w
    return out
