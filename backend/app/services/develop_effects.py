"""Server-side "develop" effects for the photo-editing pipeline: creative
optical / film looks (structure, glow, halation, flare, chromatic aberration,
vignette) plus an AgX filmic tonemap.

Same conventions as thumbnails.py, so these drop straight into the same numpy
pipeline: every effect takes and returns an HxWx3 float32 array in 0..1 (RGB,
straight-alpha-free), is resolution-independent (pixel radii are scaled by the
image long edge, so a 1600px preview and a full render look identical), and
returns the input array untouched on a neutral (0) amount so the common no-op
case is free. Effects stay subtle at low amounts and only get strong near the
extremes, avoiding hard clipping artifacts.

Kept deliberately light on imports (numpy + PIL only, no cv2/scipy) so the
module loads instantly on the API worker.
"""

import numpy as np

# Rec. 709 luma weights (identical to thumbnails.py), used for every tonal mask.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _gaussian(arr: np.ndarray, radius: float) -> np.ndarray:
    """Gaussian-blur a float 0..1 array (RGB or single-channel) in float32 -
    no 8-bit round-trip, so blurred gradients don't pick up quantisation
    banding. cv2 is imported lazily to keep this module's import instant (the
    same reason thumbnails.py wraps it in _LazyCV2); PIL's GaussianBlur radius
    is the standard deviation, which maps 1:1 onto cv2's sigma."""
    import cv2

    return cv2.GaussianBlur(np.clip(arr, 0.0, 1.0).astype(np.float32), (0, 0), radius)


def _gaussian_gray(mask: np.ndarray, radius: float) -> np.ndarray:
    """Blur a single-channel 0..1 mask in float32."""
    return _gaussian(mask, radius)


def apply_structure(arr: np.ndarray, amount: int) -> np.ndarray:
    """Medium-scale local contrast ("structure"): like clarity but on a broader
    band than fine sharpening. Positive adds punch / definition to medium-scale
    detail; negative smooths it. amount -100..100.

    Band = arr - gaussian(arr, mediumRadius) with radius ~ long_edge/120 (min
    ~2px), gained by amount/100. A midtone tent mask `(1 - |2*luma-1|)` keeps
    highlights/shadows from crushing, and the added contrast is biased slightly
    toward darkening so the result reads as deepened punch rather than an
    HDR-ish glow (the same trick `_clarity` uses in thumbnails.py)."""
    if not amount:
        return arr
    long_edge = max(arr.shape[:2])
    radius = max(2.0, long_edge / 120.0)
    band = arr - _gaussian(arr, radius)
    luma = arr @ _LUMA
    mask = (1.0 - np.abs(2.0 * luma - 1.0))[..., None]  # tent, peaks at midtones
    g = max(-100, min(100, amount)) / 100.0
    delta = 1.2 * g * band * mask
    if amount > 0:
        delta -= 0.15 * g * np.abs(band) * mask
    return np.clip(arr + delta, 0.0, 1.0)


def apply_glow(arr: np.ndarray, amount: int) -> np.ndarray:
    """Soft whole-image bloom / glow (Orton-style). amount 0..100.

    Screen-blend a large-radius blur (radius ~ long_edge/22) of the image over
    itself, weighted by the blurred luma so the brights bloom most while shadows
    stay clean. The visible strength is capped so 100 is strong without washing
    the frame to white. Screen blend: 1 - (1-arr)*(1-glow)."""
    if amount <= 0:
        return arr
    f = min(100, amount) / 100.0
    long_edge = max(arr.shape[:2])
    radius = max(8.0, long_edge / 22.0)
    blur = _gaussian(arr, radius)
    luma_b = np.clip(blur @ _LUMA, 0.0, 1.0)
    glow = np.clip(blur * (luma_b * 0.8 * f)[..., None], 0.0, 1.0)
    return np.clip(1.0 - (1.0 - arr) * (1.0 - glow), 0.0, 1.0)


def apply_halation(arr: np.ndarray, amount: int) -> np.ndarray:
    """Film halation: a warm red/orange glow bleeding around bright areas (light
    scattering back off the film base). amount 0..100.

    Build a highlight mask `clip((luma-0.6)/0.4, 0, 1)`, blur it (radius ~
    long_edge/30), colour it with a warm tint (red strongest, some green, little
    blue), and screen-blend that coloured glow over the image scaled by
    amount/100."""
    if amount <= 0:
        return arr
    f = min(100, amount) / 100.0
    long_edge = max(arr.shape[:2])
    radius = max(4.0, long_edge / 30.0)
    luma = arr @ _LUMA
    mask = np.clip((luma - 0.6) / 0.4, 0.0, 1.0)
    halo = _gaussian_gray(mask, radius)
    tint = np.array([1.0, 0.35, 0.12], dtype=np.float32)  # warm: R strong, some G, little B
    glow = np.clip(halo[..., None] * tint * f, 0.0, 1.0)
    return np.clip(1.0 - (1.0 - arr) * (1.0 - glow), 0.0, 1.0)


def apply_flare(arr: np.ndarray, amount: int) -> np.ndarray:
    """Subtle veiling glare / light flares. amount 0..100.

    Take the brightest regions (mask `clip((luma-0.75)/0.25, 0, 1)`), blur them
    very wide (radius ~ long_edge/12), and add back a soft, slightly warm,
    low-contrast veil. Additive and small (scale ~0.15*amount/100), so it lifts
    blacks a touch near strong lights the way stray-light veiling glare does.
    Deliberately restrained."""
    if amount <= 0:
        return arr
    f = min(100, amount) / 100.0
    long_edge = max(arr.shape[:2])
    radius = max(12.0, long_edge / 12.0)
    luma = arr @ _LUMA
    mask = np.clip((luma - 0.75) / 0.25, 0.0, 1.0)
    veil = _gaussian_gray(mask, radius)
    warm = np.array([1.0, 0.9, 0.75], dtype=np.float32)  # slightly warm veil
    add = veil[..., None] * warm * (0.15 * f)
    return np.clip(arr + add, 0.0, 1.0)


def apply_chromatic_aberration(arr: np.ndarray, red_cyan: int, blue_yellow: int) -> np.ndarray:
    """Lateral (transverse) chromatic aberration: radially rescale the red and
    blue channels' sampling about the image centre, leaving green fixed, so
    contrasty edges gain coloured fringes toward the frame edges.

    `red_cyan` scales the RED channel's sampling radius, `blue_yellow` the BLUE
    channel; each -100..100, with opposite signs moving in opposite directions.
    The max radial rescale at +/-100 is ~0.4% of the radius (subtle). Depending
    on sign this can *add* CA or partially *correct* existing CA. Nearest-index
    sampling, mirroring `apply_distortion` in thumbnails.py."""
    if not red_cyan and not blue_yellow:
        return arr
    h, w = arr.shape[:2]
    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0
    ys, xs = np.meshgrid(np.arange(h, dtype=np.float32), np.arange(w, dtype=np.float32), indexing="ij")
    out = arr.copy()
    for chan, amt in ((0, red_cyan), (2, blue_yellow)):
        if not amt:
            continue
        # +/-0.4% of the radius at the extremes: scale the sampling radius about
        # centre, so the channel is gathered from a slightly larger/smaller ring.
        scale = 1.0 + (max(-100, min(100, amt)) / 100.0) * 0.004
        sx = np.clip(np.rint(cx + (xs - cx) * scale), 0, w - 1).astype(np.int32)
        sy = np.clip(np.rint(cy + (ys - cy) * scale), 0, h - 1).astype(np.int32)
        out[..., chan] = arr[sy, sx, chan]
    return np.clip(out, 0.0, 1.0)


def apply_vignette(
    arr: np.ndarray,
    amount: int,
    midpoint: int = 50,
    roundness: int = 0,
    feather: int = 50,
) -> np.ndarray:
    """Corner shading with shape control (replaces the 1-parameter vignette).

    amount -100..100 (negative darkens corners, positive lightens); midpoint
    0..100 (how far from centre the falloff sits - higher starts further out for
    a smaller shaded area); roundness -100..100 (negative = more rectangular,
    positive = more circular); feather 0..100 (softness of the transition).

    A superellipse distance field `(|x|^p + |y|^p)^(1/p)` is built from centre in
    per-axis-normalized [-1,1] coords (so it stays aspect-correct), with the
    exponent p driven by roundness: p=2 (ellipse/circle) at high roundness, ~2.5
    at the default, up to ~6 (near-rectangular, hugging the frame edges) at low
    roundness. A smoothstep falloff shaped by midpoint (offset) and feather
    (width) drives `factor = 1 + (amount/100)*falloff`, multiplied in. With the
    default midpoint=50, roundness=0, feather=50 the amount slider alone gives a
    pleasant classic vignette."""
    if not amount:
        return arr
    h, w = arr.shape[:2]
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    # Superellipse exponent from roundness: +100 -> 2.0 (circular/elliptical),
    # 0 -> 2.5 (natural classic vignette), -100 -> 6.0 (rectangular).
    r = max(-100, min(100, roundness)) / 100.0
    p = 2.5 - 0.5 * r if r >= 0 else 2.5 - 3.5 * r
    dist = (np.abs(xx) ** p + np.abs(yy) ** p) ** (1.0 / p)
    dist_n = dist / (2.0 ** (1.0 / p))  # 0 at centre, 1 at the corners, any p
    # Falloff band centred at `midpoint`: higher midpoint pushes the transition
    # outward (smaller shaded area); higher feather widens (softens) it.
    m = min(100, max(0, midpoint)) / 100.0
    half = 0.02 + 0.6 * (min(100, max(0, feather)) / 100.0)
    t = np.clip((dist_n - (m - half)) / (2.0 * half), 0.0, 1.0)
    falloff = t * t * (3.0 - 2.0 * t)  # smoothstep 0..1
    factor = 1.0 + (max(-100, min(100, amount)) / 100.0) * falloff
    return np.clip(arr * factor[..., None], 0.0, 1.0)


# --- AgX filmic tonemap (approximation) --------------------------------------
# "Minimal AgX" after Troy Sobotka's AgX, via Benjamin Wrensch's compact fit
# (https://iolite-engine.com/blog_posts/minimal_agx_implementation): a channel
# "inset" mix, a log2 encode over the AgX EV range, a 6th-order polynomial
# sigmoid, then the inverse ("outset") mix and a 2.2 EOTF back to linear light.
# The inset/outset channel mixing is what gives AgX its signature graceful
# highlight desaturation (saturated brights bleed toward white as they roll off)
# rather than the hue-twisting a naive per-channel curve produces. Constants are
# the published minimal-AgX matrices; this is an AgX *approximation*, not a
# bit-exact reference build.
_AGX_INSET = np.array(
    [
        [0.842479062253094, 0.0784335999999992, 0.0792237451477643],
        [0.0423282422610123, 0.878468636469772, 0.0791661274605434],
        [0.0423756549057051, 0.0784336000000000, 0.879142973793104],
    ],
    dtype=np.float32,
)
_AGX_OUTSET = np.array(
    [
        [1.19687900512017, -0.0980208811401368, -0.0990297440797205],
        [-0.0528968517574562, 1.15190312990417, -0.0989611768448433],
        [-0.0529716355144438, -0.0980434501171241, 1.15107367264116],
    ],
    dtype=np.float32,
)
_AGX_MIN_EV = -12.47393
_AGX_MAX_EV = 4.026069


def _agx_contrast(x: np.ndarray) -> np.ndarray:
    """AgX default-contrast sigmoid: the published 6th-order polynomial fit that
    pushes the normalized 0..1 log-encoded value through the filmic S-curve
    (maps ~0->0 and ~1->1, steep, well-behaved slope in the mids)."""
    x2 = x * x
    x4 = x2 * x2
    return (
        15.5 * x4 * x2
        - 40.14 * x4 * x
        + 31.96 * x4
        - 6.868 * x2 * x
        + 0.4298 * x2
        + 0.1191 * x
        - 0.00232
    )


def agx_tonemap(arr: np.ndarray) -> np.ndarray:
    """Apply the AgX filmic tone response to a LINEAR-light RGB array, returning
    LINEAR light (the caller does the sRGB decode before and encode after).

    Pipeline: inset channel mix -> log2 encode over the AgX EV range, normalized
    to 0..1 -> per-channel filmic sigmoid -> the default AgX "look" (identity, a
    no-op) -> outset (inverse mix) -> 2.2 EOTF back to linear light. Maps 0->~0
    and 1->~near-1 monotonically, rolling highlights off softly and letting them
    desaturate gracefully. AgX *approximation* - the character of the look
    matters more than bit-exactness."""
    x = np.clip(arr, 0.0, None).astype(np.float32)
    x = x @ _AGX_INSET.T  # inset channel mix (drives the highlight desaturation)
    x = np.clip(x, 1e-10, None)  # floor before log2 so pure black is finite
    x = np.clip(np.log2(x), _AGX_MIN_EV, _AGX_MAX_EV)
    x = (x - _AGX_MIN_EV) / (_AGX_MAX_EV - _AGX_MIN_EV)  # -> 0..1
    x = _agx_contrast(x)  # filmic sigmoid, per channel
    # The default AgX "look" (offset/slope/power/saturation) is the identity, so
    # it is intentionally omitted here.
    x = np.clip(x, 0.0, 1.0) @ _AGX_OUTSET.T  # outset (inverse channel mix)
    x = np.power(np.clip(x, 0.0, 1.0), 2.2)  # 2.2 EOTF -> back to linear light
    return np.clip(x, 0.0, 1.0).astype(np.float32)
