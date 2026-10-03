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

Process version 3 on a RAW renders the looks Fujifilm itself publishes from
Fujifilm's own cubes (film_luts/official/<sim>.npy): the 3D LUTs for F-Log2
footage, ten looks - Provia, Velvia, Astia, Classic Chrome, Reala Ace, Pro
Neg. Std, Classic Neg., Eterna, Eterna Bleach Bypass, Acros. They are
scene-referred: the tone block hands apply_official the linear picture, which
is encoded as F-Log2 / F-Gamut and looked up, and the cube's output IS the
display picture - Fujifilm's tone curve and highlight roll-off for that look,
in place of this app's shoulder (see thumbnails._linear_tone_block). Nothing
in that path is fitted to anything; 18% grey in is 18% grey out. The cubes
were first fitted to the JPEGs the camera wrote into its RAFs, but those
carry the recipe they were shot with (tone, colour, colour chrome), which
does not come back out cleanly - Classic Neg. showed it.

What Fujifilm's pack lacks keeps a display-referred cube in this module's own
format (film_luts/<sim>.npy), applied where the recipes are: Pro Neg. Hi,
Monochrome, Sepia and the yellow / red / green filter variants from Stuart
Sowerby's "Fuji XTrans III" HaldCLUTs (no licence to redistribute: see the
note in tools/film_sim_fit/official.py before shipping those nine), and
Nostalgic Neg., which nobody publishes, from the camera JPEGs after all
(tools/film_sim_fit/fit.py). A look without any cube keeps its recipe, and
edits made on an earlier process version keep the recipes throughout.

Process version 4 renders them as the camera renders a still. Fujifilm's cubes
are made for video: fed the same light they come out ~0.9 stops darker than
the camera's JPEG of the same look, and they hold a long shoulder where the
still has reached white by sensor clipping. Below middle grey the two tone
curves are one curve, so both differences can be taken out in front of the
cube, on the scene values, and the cube stays untouched: a fixed gain (the
anchor) and a lift of the highlights that puts sensor clipping on white (the
stills shoulder) - see _stills_factors, measured in tools/film_sim_fit/
reference.py. The looks Fujifilm publishes no cube for get one of the same
kind there (film_luts/derived/<sim>.npy, tools/film_sim_fit/derive.py: the
published look they are closest to, plus what sets them apart from it), so all
of them share one tone path.
"""

from __future__ import annotations

import logging
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.develop import ENUM_SPEC
from app.services.develop_color import _pchip_lut

logger = logging.getLogger(__name__)

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# The measured cubes (process version 3), one .npy per look that has one.
_MEASURED_DIR = Path(__file__).parent / "film_luts"
# Fujifilm's own cubes (F-Log2 / F-Gamut in, BT.709 out), copied by
# tools/film_sim_fit/import_official.py.
_OFFICIAL_DIR = _MEASURED_DIR / "official"
OFFICIAL_SIMS = frozenset({
    "provia", "velvia", "astia", "classic_chrome", "reala_ace", "pro_neg_std",
    "classic_neg", "eterna", "eterna_bleach_bypass", "acros",
})
# Cubes of the same kind for the looks Fujifilm publishes none for, built on
# Fujifilm's by tools/film_sim_fit/derive.py (process version 4).
_DERIVED_DIR = _MEASURED_DIR / "derived"

# Process version 4, the look as a still (tools/film_sim_fit/reference.py).
# The anchor: how much more light Fujifilm's video cubes want than the scene
# value for their grey ramp to lie on the camera JPEG's - the same for every
# look to within 0.03 stops.
_STILLS_ANCHOR = 1.89
# The stills shoulder: at a scene luminance of 0.10, 0.12 .. 1.00 of sensor
# clipping, how many stops more than the anchor the cube has to be given to
# show what the still shows there. Nothing up to an eighth of clipping (a third
# of a stop over middle grey), three stops at clipping - which is where the
# cube reaches white.
_STILLS_SHOULDER_X = np.linspace(0.10, 1.0, 46)
_STILLS_SHOULDER = np.array([
    0.0, 0.0, 0.01, 0.03, 0.06, 0.09, 0.12, 0.15, 0.17, 0.2, 0.24, 0.31, 0.4, 0.51, 0.61, 0.72,
    0.86, 1.0, 1.16, 1.34, 1.5, 1.64, 1.78, 1.91, 2.02, 2.12, 2.2, 2.28, 2.34, 2.42, 2.46, 2.52,
    2.56, 2.57, 2.64, 2.67, 2.68, 2.75, 2.77, 2.77, 2.77, 2.88, 2.88, 2.88, 2.88, 3.04,
])

# Linear BT.709 -> F-Gamut (BT.2020 primaries, D65).
_FGAMUT_FROM_709 = np.array([[0.627404, 0.329283, 0.043313],
                             [0.069097, 0.919540, 0.011362],
                             [0.016391, 0.088013, 0.895595]], dtype=np.float32)
# F-Log2 OETF (Fujifilm's data sheet): scene reflectance -> code value 0..1.
_FLOG2_A, _FLOG2_B, _FLOG2_C, _FLOG2_D = 5.555556, 0.064829, 0.245281, 0.384316
_FLOG2_E, _FLOG2_F, _FLOG2_CUT = 8.799461, 0.092864, 0.000889

# A frame is looked up in bands of this many rows: the lookup's coordinate
# maps are frame-sized float32 temporaries, and on a 40MP render they are what
# pushed an 8GB machine into swap.
_SAMPLE_BAND_ROWS = 1024

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
#   tone:   (hue, amount) one tint over the whole tonal range (sepia)
_SHARED_ACROS_CURVE = [(0, 0), (52, 40), (128, 127), (208, 214), (255, 255)]
_SHARED_MONO_CURVE = [(0, 2), (64, 60), (128, 128), (200, 202), (255, 253)]
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
    # True-to-life: Provia's honesty with a touch less saturation and a
    # slightly firmer tone - the newest stock, made to look like the scene.
    "reala_ace": {
        "curve": [(0, 0), (58, 50), (128, 129), (202, 208), (255, 255)],
        "sat": 1.04,
        "deepen": 0.08,
        "hues": [(120, 70, -2.0, 0.96, 1.0)],
    },
    # Portrait, studio light: restrained colour with gentle skin, a clear
    # but not hard tone.
    "pro_neg_hi": {
        "curve": [(0, 0), (58, 50), (128, 128), (200, 206), (255, 254)],
        "sat": 0.94,
        "deepen": 0.06,
        "hues": [(25, 45, 1.0, 0.94, 1.02)],
    },
    # Portrait, soft light: the same palette on the flattest colour tone of
    # the set - open shadows, long highlights.
    "pro_neg_std": {
        "curve": [(0, 3), (64, 62), (128, 128), (196, 198), (255, 252)],
        "sat": 0.90,
        "deepen": 0.04,
        "hues": [(25, 45, 1.0, 0.94, 1.02)],
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
    # Silver left in the print: very low colour on a hard, dense tone.
    "eterna_bleach_bypass": {
        "curve": [(0, 0), (50, 34), (128, 124), (206, 220), (255, 255)],
        "sat": 0.55,
        "deepen": 0.22,
        "split": (210, 0.02, 45, 0.02),
    },
    # B&W: orthopanchromatic-style mix with deep blacks and a fine shoulder;
    # the Ye/R/G variants mimic contrast filters (R darkens skies, G lifts foliage
# and darkens skin).
    "acros": {"bw": (0.25, 0.60, 0.15), "curve": _SHARED_ACROS_CURVE},
    "acros_ye": {"bw": (0.35, 0.55, 0.10), "curve": _SHARED_ACROS_CURVE},
    "acros_r": {"bw": (0.55, 0.38, 0.07), "curve": _SHARED_ACROS_CURVE},
    "acros_g": {"bw": (0.13, 0.72, 0.15), "curve": _SHARED_ACROS_CURVE},
    # Plain B&W: a luminance mix on a gentle curve; Ye/R/G as for Acros.
    "monochrome": {"bw": (0.30, 0.59, 0.11), "curve": _SHARED_MONO_CURVE},
    "monochrome_ye": {"bw": (0.38, 0.54, 0.08), "curve": _SHARED_MONO_CURVE},
    "monochrome_r": {"bw": (0.58, 0.36, 0.06), "curve": _SHARED_MONO_CURVE},
    "monochrome_g": {"bw": (0.16, 0.72, 0.12), "curve": _SHARED_MONO_CURVE},
    # The monochrome picture toned warm brown throughout.
    "sepia": {"bw": (0.30, 0.59, 0.11), "curve": _SHARED_MONO_CURVE, "tone": (34, 0.16)},
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

    tone = recipe.get("tone")
    if tone:
        tone_hue, amt = tone
        ones = np.ones(arr.shape[:-1], dtype=np.float32)
        tint = _hsl_to_rgb(ones * tone_hue, ones, ones * 0.5)
        # Strongest in the midtones, fading to clean black and paper white.
        luma = np.clip(arr @ _LUMA, 0.0, 1.0)
        arr = arr + (tint - 0.5) * (amt * 4.0 * luma * (1.0 - luma))[..., None]

    return np.clip(arr, 0.0, 1.0)


def _measured_cube(sim: str) -> np.ndarray | None:
    """The look's cube as fitted to the camera's JPEGs, or None if it has none
    (or the file is unusable - the recipe then stands in)."""
    path = _MEASURED_DIR / f"{sim}.npy"
    if sim not in _RECIPES or not path.is_file():
        return None
    try:
        cube = np.load(path).astype(np.float32)
    except (OSError, ValueError):
        logger.exception("Unreadable measured film simulation %s", path)
        return None
    if cube.ndim != 4 or cube.shape[3] != 3 or len(set(cube.shape[:3])) != 1:
        logger.error("Measured film simulation %s has shape %s", path, cube.shape)
        return None
    return np.clip(cube, 0.0, 1.0)


def has_measured(sim: str) -> bool:
    return _sim_cube(sim, True) is not _sim_cube(sim, False)


@lru_cache(maxsize=None)
def _sim_cube(sim: str, measured: bool = False) -> np.ndarray | None:
    """The look's NxNxNx3 float32 cube, indexed [r][g][b], or None: the
    measured one where asked for and there is one, else the baked recipe."""
    if measured:
        cube = _measured_cube(sim)
        return cube if cube is not None else _sim_cube(sim, False)
    recipe = _RECIPES.get(sim)
    if recipe is None:
        return None
    axis = np.linspace(0.0, 1.0, _CUBE_N, dtype=np.float32)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([r, g, b], axis=-1).reshape(-1, 3)
    return _bake(recipe, grid).reshape(_CUBE_N, _CUBE_N, _CUBE_N, 3).astype(np.float32)


def _load_scene_cube(path: Path) -> np.ndarray | None:
    try:
        cube = np.load(path).astype(np.float32)
    except (OSError, ValueError):
        logger.exception("Unreadable official film simulation %s", path)
        return None
    if cube.ndim != 4 or cube.shape[3] != 3 or len(set(cube.shape[:3])) != 1:
        logger.error("Official film simulation %s has shape %s", path, cube.shape)
        return None
    return np.clip(cube, 0.0, 1.0)


@lru_cache(maxsize=None)
def official_cube(sim: str) -> np.ndarray | None:
    """Fujifilm's cube for the look (F-Log2 code values in, display out),
    indexed [r][g][b], or None where Fujifilm publishes none or the file is
    missing or unusable."""
    path = _OFFICIAL_DIR / f"{sim}.npy"
    if sim not in OFFICIAL_SIMS or not path.is_file():
        return None
    return _load_scene_cube(path)


@lru_cache(maxsize=None)
def derived_cube(sim: str) -> np.ndarray | None:
    """The cube built on Fujifilm's for a look Fujifilm publishes none for
    (same form as official_cube), or None if there is none."""
    path = _DERIVED_DIR / f"{sim}.npy"
    if sim not in _RECIPES or sim in OFFICIAL_SIMS or not path.is_file():
        return None
    return _load_scene_cube(path)


def renders_as_still(adj: dict) -> bool:
    """Process version 4: a look rendered from a scene cube gets the anchor
    and the stills shoulder, and the derived cubes count."""
    return adj.get("process") == "4"


def _scene_cube(sim: str, still: bool) -> np.ndarray | None:
    cube = official_cube(sim)
    return derived_cube(sim) if cube is None and still else cube


def official_sim(adj: dict, raw_source: bool) -> str | None:
    """The look this edit renders from a scene cube, or None: process version
    3 or 4, a RAW underneath, a look Fujifilm publishes (on 4 also one built
    on those), intensity above zero. The tone block then applies it
    (apply_official) and the display colour block leaves the simulation
    alone."""
    sim = adj.get("film_sim")
    if not raw_source or adj.get("process") not in ("3", "4") or not sim or sim == "none":
        return None
    if adj.get("lut_intensity", 100) <= 0 or _scene_cube(sim, renders_as_still(adj)) is None:
        return None
    return sim


# The stills factors are tabulated over scene luminance at this many points
# between the knee and sensor clipping.
_STILLS_TABLE_N = 1024


def _stills_factors(white: float) -> tuple[np.ndarray, np.ndarray]:
    """What a scene luminance is multiplied by in front of the cube for the
    look to come out as a still, as a table (luminances, evenly spaced from
    the knee to `white`; factors): the anchor everywhere, and from the knee up
    the stills shoulder on top, so that `white` - the scene value the sensor
    clips at, i.e. the gain the frame was lifted by - lands where the cube
    reaches white. Below the first luminance the first factor holds, above the
    last one the last.

    The shoulder is measured for a frame at the camera's own exposure (white =
    1). A frame lifted further (a DR200 / DR400 file, Exposure pushed) has its
    clipping point higher up the cube's own shoulder and needs less: the same
    shape stretched over the longer way from knee to clipping, scaled by how
    much of the three stops is still missing - none of it from 3 stops up."""
    white = max(float(white), 1.0)
    knee = float(_STILLS_SHOULDER_X[np.flatnonzero(_STILLS_SHOULDER > 0)[0] - 1])
    top = float(_STILLS_SHOULDER[-1])
    missing = max(0.0, 1.0 - math.log2(white) / top)
    y = np.linspace(knee, white, _STILLS_TABLE_N)
    # Where this luminance sits between knee and clipping, in stops, mapped
    # onto the same fraction of the way in the measured frame.
    at = knee * (1.0 / knee) ** (np.log2(y / knee) / math.log2(white / knee))
    stops = missing * np.interp(at, _STILLS_SHOULDER_X, _STILLS_SHOULDER)
    return y, _STILLS_ANCHOR * 2.0 ** stops


def apply_official(scene: np.ndarray, sim: str, stills_white: float | None = None) -> np.ndarray:
    """Scene-linear BT.709 RGB (HxWx3 float32, 0.18 = middle grey, highlights
    above 1.0 welcome - F-Log2 holds them to about 58) through Fujifilm's cube
    for `sim`: display sRGB float32 0..1 out. The cube's BT.709 code values are
    shown as they are, as every editor shows graded footage on a computer
    screen.

    `stills_white` (process version 4) renders the look as a still: the scene
    value the sensor clips at. Each pixel is scaled by its luminance's factor
    (_stills_factors), colour ratios kept, before the cube sees it."""
    still = stills_white is not None
    cube = _scene_cube(sim, still)
    if still:
        import cv2

        lums, factors = _stills_factors(stills_white)
        first, per_step = np.float32(lums[0]), np.float32(1.0 / (lums[1] - lums[0]))
        factors = factors.astype(np.float32).reshape(1, -1)
    out = np.empty(scene.shape, dtype=np.float32)
    for y0 in range(0, scene.shape[0], _SAMPLE_BAND_ROWS):
        band = scene[y0:y0 + _SAMPLE_BAND_ROWS]
        if still:
            # The factor table read like the cube is: as a picture one row
            # high, through cv2.remap (np.interp takes 70 ms a frame for this).
            band = np.ascontiguousarray(band, dtype=np.float32)
            at = cv2.transform(band, _LUMA.reshape(1, 3))
            at -= first
            at *= per_step
            x = cv2.transform(band, _FGAMUT_FROM_709)
            x *= cv2.remap(
                factors, at, np.zeros_like(at), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
            )[..., None]
        else:
            x = band @ _FGAMUT_FROM_709.T
        out[y0:y0 + _SAMPLE_BAND_ROWS] = _sample_band(_flog2(np.maximum(x, 0.0, out=x)), cube)
    return np.clip(out, 0.0, 1.0, out=out)


def _flog2(x: np.ndarray) -> np.ndarray:
    """F-Log2 code values (0..1) of scene reflectance."""
    return np.where(
        x >= _FLOG2_CUT,
        _FLOG2_C * np.log10(_FLOG2_A * x + _FLOG2_B) + _FLOG2_D,
        _FLOG2_E * x + _FLOG2_F,
    ).astype(np.float32)


# cube id -> (cube, atlas). The cubes themselves live for the process in the
# lru_caches above, so the id is stable; keeping the cube in the entry pins it.
_atlases: dict[int, tuple[np.ndarray, np.ndarray]] = {}


def _atlas(cube: np.ndarray) -> np.ndarray:
    """The cube as one 2-D picture for cv2.remap: its n blue slices stacked
    top to bottom, each n rows (green) by n columns (red)."""
    entry = _atlases.get(id(cube))
    if entry is None or entry[0] is not cube:
        n = cube.shape[0]
        entry = (cube, np.ascontiguousarray(cube.transpose(2, 1, 0, 3).reshape(n * n, n, 3)))
        _atlases[id(cube)] = entry
    return entry[1]


def _sample_band(arr: np.ndarray, cube: np.ndarray) -> np.ndarray:
    import cv2

    n = cube.shape[0]
    atlas = _atlas(cube)
    x = np.clip(arr, 0.0, 1.0) * np.float32(n - 1)
    red = np.ascontiguousarray(x[..., 0])
    blue = x[..., 2]
    b0 = np.minimum(np.floor(blue), n - 2)
    fb = (blue - b0)[..., None]
    # Bilinear in red and green inside the blue slice below and the one above
    # (green never leaves its slice: it stops at row n - 1), then blend the two.
    row = b0 * n + x[..., 1]
    lo = cv2.remap(atlas, red, row, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    row += n
    hi = cv2.remap(atlas, red, row, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    hi -= lo
    hi *= fb
    lo += hi
    return lo


def _sample_cube(arr: np.ndarray, cube: np.ndarray) -> np.ndarray:
    """Trilinear interpolation of an HxWx3 0..1 array through the cube.

    The cube is laid out as a 2-D atlas and read with two cv2.remap calls
    (SIMD, all cores) instead of eight numpy gathers: the same numbers at a
    ninth of the time (1837x1225: 23 ms against 211 ms), which is the
    difference between a film simulation costing the editor a frame and
    costing it nothing. Big frames go through in row bands."""
    if arr.ndim != 3:  # a list of colours: as a picture one colour wide
        return _sample_cube(arr.reshape(-1, 1, 3), cube).reshape(arr.shape)
    arr = arr.astype(np.float32, copy=False)
    if arr.shape[0] <= _SAMPLE_BAND_ROWS:
        return _sample_band(arr, cube)
    out = np.empty(arr.shape, dtype=np.float32)
    for y0 in range(0, arr.shape[0], _SAMPLE_BAND_ROWS):
        out[y0:y0 + _SAMPLE_BAND_ROWS] = _sample_band(arr[y0:y0 + _SAMPLE_BAND_ROWS], cube)
    return out


def apply_film_sim(
    arr: np.ndarray, sim: str | None, intensity: float = 100, measured: bool = False
) -> np.ndarray:
    """Apply a built-in look to a display-referred sRGB float array (0..1),
    blended by ``intensity`` percent. Neutral look / zero intensity: no-op.
    ``measured`` (process version 3) takes the cube fitted to the camera where
    the look has one."""
    if not sim or sim == "none" or intensity <= 0:
        return arr
    cube = _sim_cube(sim, measured)
    if cube is None:
        return arr
    base = np.clip(arr, 0.0, 1.0).astype(np.float32)
    out = _sample_cube(base, cube)
    w = min(100.0, float(intensity)) / 100.0
    if w < 1.0:
        out = base + (out - base) * w
    return out
