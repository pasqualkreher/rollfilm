"""Mask field generation for local (per-region) adjustments.

Standalone numpy (no imports from thumbnails, to avoid a cycle). Each generator
returns an (H, W) float32 field in 0..1 that says how strongly a mask applies at
each pixel. A mask *container* combines its sub-masks (additive / subtractive /
intersect); thumbnails.apply_masks() then renders the container's local
adjustments and blends them in by this field * opacity.

All spatial parameters are fractions of the image (0..1) so a mask drawn on the
editor preview lands identically on the full-resolution render. Parameter keys
match the frontend mask model (utils/adjustments.ts MaskDef / sub-masks).
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

import numpy as np

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Cache for the purely geometric sub-mask fields (radial / linear / brush -
# NOT luminance/color/edge, which depend on the image pixels). The editor re-renders
# the whole pipeline on every slider tick, and re-rasterising an unchanged
# brush mask (thousands of capsule stamps) per frame dominated those renders.
# Keyed by the sub-mask's parameter JSON + the field size; a small LRU because
# a 2600px float32 field is ~18MB. Fields at native resolution (tens of MP) are
# deliberately never cached - one entry would dwarf the whole budget.
_FIELD_CACHE: OrderedDict[tuple[str, str, int, int], np.ndarray] = OrderedDict()
_FIELD_CACHE_MAX = 8
_FIELD_CACHE_MAX_PX = 8_000_000
_field_cache_lock = threading.Lock()


def _cached_spatial_field(t: str, p: dict, h: int, w: int, compute) -> np.ndarray:
    if h * w > _FIELD_CACHE_MAX_PX:
        return compute()
    key = (t, json.dumps(p, sort_keys=True, separators=(",", ":")), h, w)
    with _field_cache_lock:
        hit = _FIELD_CACHE.get(key)
        if hit is not None:
            _FIELD_CACHE.move_to_end(key)
            return hit
    f = compute()
    f.flags.writeable = False  # shared across renders - nobody may scribble on it
    with _field_cache_lock:
        _FIELD_CACHE[key] = f
        _FIELD_CACHE.move_to_end(key)
        while len(_FIELD_CACHE) > _FIELD_CACHE_MAX:
            _FIELD_CACHE.popitem(last=False)
    return f


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _mesh(h: int, w: int):
    ys, xs = np.meshgrid(np.arange(h, dtype=np.float32), np.arange(w, dtype=np.float32), indexing="ij")
    return xs, ys


def _radial_field(h: int, w: int, p: dict) -> np.ndarray:
    cx = float(p.get("center_x", 0.5)) * w
    cy = float(p.get("center_y", 0.5)) * h
    rx = max(float(p.get("radius_x", 0.3)), 1e-3) * w
    ry = max(float(p.get("radius_y", 0.3)), 1e-3) * h
    rot = np.radians(float(p.get("rotation", 0.0)))
    feather = np.clip(float(p.get("feather", 50)) / 100.0, 1e-3, 1.0)
    xs, ys = _mesh(h, w)
    dx = xs - cx
    dy = ys - cy
    ca, sa = np.cos(rot), np.sin(rot)
    xr = (dx * ca + dy * sa) / rx
    yr = (-dx * sa + dy * ca) / ry
    d = np.sqrt(xr * xr + yr * yr)  # 1 at the ellipse edge
    # Solid inside (radius - feather), ramps to 0 at the edge.
    return _smoothstep((1.0 - d) / feather).astype(np.float32)


def _linear_field(h: int, w: int, p: dict) -> np.ndarray:
    x0 = float(p.get("start_x", 0.5)) * w
    y0 = float(p.get("start_y", 0.0)) * h
    x1 = float(p.get("end_x", 0.5)) * w
    y1 = float(p.get("end_y", 1.0)) * h
    dx = x1 - x0
    dy = y1 - y0
    l2 = dx * dx + dy * dy + 1e-6
    xs, ys = _mesh(h, w)
    t = ((xs - x0) * dx + (ys - y0) * dy) / l2  # 0 at the start line, 1 at the end line
    return _smoothstep(t).astype(np.float32)


def _stamp_capsule(
    field: np.ndarray, ax: float, ay: float, bx: float, by: float, r: float, feather: float
) -> None:
    """Max-blend one round-capped segment (a "capsule") from A to B into `field`.

    A stroke is swept as capsules rather than stamped as a dab per sample point:
    dabs leave a scalloped edge whose depth depends on how fast the pointer moved
    (a quick drag samples sparsely), so the same gesture produced a different
    edge every time. The distance to a segment is exact, so the stroke's edge is
    uniform along its whole length at any drawing speed."""
    h, w = field.shape
    x0 = max(0, int(np.floor(min(ax, bx) - r)))
    x1 = min(w, int(np.ceil(max(ax, bx) + r)) + 1)
    y0 = max(0, int(np.floor(min(ay, by) - r)))
    y1 = min(h, int(np.ceil(max(ay, by) + r)) + 1)
    if x1 <= x0 or y1 <= y0:
        return
    px = np.arange(x0, x1, dtype=np.float32)[None, :] - ax
    py = np.arange(y0, y1, dtype=np.float32)[:, None] - ay
    abx = bx - ax
    aby = by - ay
    ab2 = abx * abx + aby * aby
    if ab2 > 1e-6:
        # Project each pixel onto the segment, clamped to its ends (round caps).
        t = np.clip((px * abx + py * aby) / ab2, 0.0, 1.0)
        dx = px - t * abx
        dy = py - t * aby
    else:
        dx, dy = px + np.zeros_like(py), py + np.zeros_like(px)
    d = np.sqrt(dx * dx + dy * dy) / r
    dab = _smoothstep((1.0 - d) / feather)
    np.maximum(field[y0:y1, x0:x1], dab, out=field[y0:y1, x0:x1])


# Point flags in a stroke sample: [x, y, size, flags]. bit0 marks the first
# sample of a stroke (pointer-down), bit1 marks an erase stroke. Samples saved
# before these existed carry no flags - see _group_strokes.
_PEN_DOWN = 1
_ERASE = 2

# Legacy fallback: without a pointer-down flag, treat a jump longer than this
# many brush radii as the start of a new stroke. Painting samples at most half a
# radius apart (see the editor's step), so real gaps are far larger than this.
_LEGACY_BREAK_RADII = 2.5


def _group_strokes(strokes: list, long_edge: int, w: int, h: int) -> list[tuple[bool, list]]:
    """Split a flat sample list into (is_erase, [(x_px, y_px, r_px), ...]) strokes.

    The samples of every stroke are stored in one flat array, so the boundaries
    have to be recovered before the segments can be swept - joining the end of
    one stroke to the start of the next would draw a line the user never
    painted. New samples carry an explicit pointer-down flag; older ones are
    split on a distance jump instead."""
    out: list[tuple[bool, list]] = []
    current: list[tuple[float, float, float]] = []
    current_erase = False
    for pt in strokes:
        try:
            x = float(pt[0]) * w
            y = float(pt[1]) * h
            r = max(float(pt[2]) * long_edge, 0.5) if len(pt) > 2 else 0.05 * long_edge
            flags = int(pt[3]) if len(pt) > 3 else -1
        except (TypeError, ValueError, IndexError):
            continue
        if flags >= 0:
            starts = bool(flags & _PEN_DOWN)
            erase = bool(flags & _ERASE)
        else:
            erase = current_erase
            starts = bool(current) and (
                np.hypot(x - current[-1][0], y - current[-1][1]) > _LEGACY_BREAK_RADII * r
            )
        if not current:
            current_erase = erase
        elif starts or erase != current_erase:
            out.append((current_erase, current))
            current = []
            current_erase = erase
        current.append((x, y, r))
    if current:
        out.append((current_erase, current))
    return out


def _brush_field(h: int, w: int, p: dict) -> np.ndarray:
    """Painted mask with the flow/density build-up of a real brush.

    Within one stroke the capsules are max-blended, so dragging back over your
    own wet stroke doesn't darken it. Releasing and painting again composites a
    *new* stroke at `flow`, easing toward `density` - the standard model, and the
    reason a low flow lets you build an effect up gradually instead of it being
    all-or-nothing."""
    feather = np.clip(float(p.get("feather", 50)) / 100.0, 1e-3, 1.0)
    flow = np.clip(float(p.get("flow", 100)) / 100.0, 1e-3, 1.0)
    density = np.clip(float(p.get("density", 100)) / 100.0, 0.0, 1.0)
    long_edge = max(h, w)
    field = np.zeros((h, w), dtype=np.float32)
    # One scratch buffer for the stroke currently being swept, reused across
    # strokes. Only each stroke's own bounding box is ever touched - clearing and
    # compositing the whole frame per stroke made the cost image-area x
    # stroke-count, which on an editor-sized preview reached ~1.2s for 150
    # strokes and would have stalled the live preview.
    stroke_buf = np.empty((h, w), dtype=np.float32)
    for is_erase, pts in _group_strokes(p.get("strokes") or [], long_edge, w, h):
        rmax = max(r for _, _, r in pts)
        x0 = max(0, int(np.floor(min(x for x, _, _ in pts) - rmax)))
        x1 = min(w, int(np.ceil(max(x for x, _, _ in pts) + rmax)) + 1)
        y0 = max(0, int(np.floor(min(y for _, y, _ in pts) - rmax)))
        y1 = min(h, int(np.ceil(max(y for _, y, _ in pts) + rmax)) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        # Views into the scratch buffer and the accumulator, in stroke-local
        # coordinates - _stamp_capsule clips against the shape it is handed.
        buf = stroke_buf[y0:y1, x0:x1]
        buf.fill(0.0)
        if len(pts) == 1:
            x, y, r = pts[0]
            _stamp_capsule(buf, x - x0, y - y0, x - x0, y - y0, r, feather)
        else:
            for (ax, ay, ar), (bx, by, br) in zip(pts, pts[1:]):
                _stamp_capsule(buf, ax - x0, ay - y0, bx - x0, by - y0, max(ar, br), feather)
        target = field[y0:y1, x0:x1]
        if is_erase:
            # Erasing scales what is already there toward 0, so a low flow wipes
            # gradually the same way painting builds gradually.
            target *= 1.0 - flow * buf
        else:
            target += flow * buf * np.maximum(density - target, 0.0)
    return np.clip(field, 0.0, 1.0)


def _luminance_field(arr: np.ndarray, p: dict) -> np.ndarray:
    """Select a luminance window, with the falloff *centred* on each edge: at
    exactly range_min / range_max the mask is at 0.5, so the numbers on the
    sliders are the selection's real boundary and raising Feather softens the
    transition without also widening the reach.

    An edge parked at the extreme (0 or 100) gets no falloff at all - selecting
    "shadows up to 50" must include pure black fully rather than fading it out."""
    lo = np.clip(float(p.get("range_min", 0)) / 100.0, 0.0, 1.0)
    hi = np.clip(float(p.get("range_max", 100)) / 100.0, 0.0, 1.0)
    if hi < lo:
        lo, hi = hi, lo
    # Feather 100 spreads each edge over half the tonal range; +eps keeps feather
    # 0 a hard threshold instead of a divide-by-zero.
    fw = np.clip(float(p.get("feather", 35)) / 100.0, 0.0, 1.0) * 0.5 + 1e-4
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    big = np.float32(1e3)
    lower = big if lo <= 0.0 else (luma - lo) / fw + 0.5
    upper = big if hi >= 1.0 else (hi - luma) / fw + 0.5
    return _smoothstep(np.minimum(lower, upper)).astype(np.float32)


# How much a brightness difference counts next to a hue/saturation one in the
# colour mask. Low on purpose: the point of a colour mask is to catch one
# material across the light falling on it, so a shadowed red shirt and a sunlit
# one stay the same selection. Not zero, or black and white (both colourless, so
# identical in chromaticity) would be indistinguishable.
_COLOR_LUMA_WEIGHT = 0.35
# Chromaticities live on the r+g+b=1 plane, where the farthest two points (pure
# primaries) are sqrt(2) apart - normalising by that puts `dist` on 0..1.
_CHROMA_NORM = float(np.sqrt(2.0))


# Below this sum of channels a pixel carries no usable hue - the division would
# amplify sensor noise (or, at exactly 0, produce nothing at all) into a wild
# chromaticity. Such pixels are treated as neutral so they compare on the
# brightness term instead of on noise.
_CHROMA_FLOOR = 0.03


def _chromaticity(rgb: np.ndarray) -> np.ndarray:
    """Brightness-normalised colour (r,g,b)/(r+g+b). Dividing out intensity is
    what makes the selection survive shading: on a matte surface, light only
    scales all three channels, which leaves this unchanged."""
    total = rgb.sum(axis=-1, keepdims=True)
    neutral = np.float32(1.0 / 3.0)
    return np.where(total > _CHROMA_FLOOR, rgb / np.maximum(total, 1e-6), neutral)


def _color_field(arr: np.ndarray, p: dict) -> np.ndarray:
    """Select pixels near a target colour. Distance is measured in chromaticity
    (plus a weak brightness term, see _COLOR_LUMA_WEIGHT) rather than straight
    RGB: in RGB the same material in sun and in shade is far apart, so a plain
    RGB radius could never select an object - only a narrow band of one exposure
    of it.

    Like the luminance mask, `tolerance` is the 0.5 crossing and Feather only
    controls how soft that crossing is."""
    target = np.array(
        [float(p.get("target_r", 0.5)), float(p.get("target_g", 0.5)), float(p.get("target_b", 0.5))],
        dtype=np.float32,
    )
    tol = np.clip(float(p.get("tolerance", 20)) / 100.0, 1e-3, 1.0)
    feather = np.clip(float(p.get("feather", 35)) / 100.0, 0.0, 1.0)
    chroma_d = np.sqrt(((_chromaticity(arr) - _chromaticity(target)) ** 2).sum(axis=-1)) / _CHROMA_NORM
    luma_d = np.abs(np.clip(arr @ _LUMA, 0.0, 1.0) - float(np.clip(target @ _LUMA, 0.0, 1.0)))
    dist = np.sqrt(chroma_d * chroma_d + (_COLOR_LUMA_WEIGHT * luma_d) ** 2)
    fw = tol * feather + 1e-4
    return _smoothstep((tol - dist) / fw + 0.5).astype(np.float32)


# --- Edge ("detail") masks ----------------------------------------------------
# Selects where the picture has detail rather than where it is bright: the local
# gradient magnitude, thresholded. This is the mask a sharpening or clarity
# adjustment wants - a luminance mask can only say "the dark half of the
# picture", which on a portrait is hair AND the shadow on the cheek, and
# sharpening flat skin is exactly what you were trying to avoid.
#
# The gradient is measured at a FIXED working size, not at the render's own
# resolution. A scrub preview (1100px), the settled render and a 40MP export
# would otherwise each see a different amount of fine detail per pixel and so
# select a different set of edges - the mask you set up on the preview would not
# be the one that gets saved. Everything below is in luma-per-pixel at this size.
_EDGE_WORK_PX = 1600
# ...with one limit: a thumbnail is not blown up more than this to be measured,
# which would cost more than the whole thumbnail render for detail that isn't in
# the pixels anyway. The leftover scale difference is corrected arithmetically
# instead (exact for a ramp, close enough for everything else).
_EDGE_MAX_UPSCALE = 2.0
# A hard black/white border reaches ~0.5 in these units, a crisp branch against
# sky ~0.1, and film grain or skin texture stays well under 0.02 - so the slider
# is squared to spread the interesting bottom of that range over most of its
# travel.
_EDGE_MAX_THRESHOLD = 0.30
_EDGE_MIN_THRESHOLD = 0.004
# Spread 100 grows the selection this many working-size pixels around each edge,
# so a sharpening mask can cover the whole transition instead of a hairline.
_EDGE_MAX_SPREAD_PX = 10.0


def _luma_gradient(luma: np.ndarray) -> np.ndarray:
    """|grad| of a lightly smoothed luma plane, in luma units per pixel. The
    pre-blur is what keeps sensor noise and grain out of the selection - without
    it the "edges" of a high-ISO frame are mostly noise."""
    try:
        import cv2

        sm = cv2.GaussianBlur(luma, (0, 0), sigmaX=1.0, sigmaY=1.0)
        gx = cv2.Sobel(sm, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(sm, cv2.CV_32F, 0, 1, ksize=3)
        # A 3x3 Sobel sums to 8x the per-pixel difference it measures.
        return (np.sqrt(gx * gx + gy * gy) / 8.0).astype(np.float32)
    except Exception:
        gy, gx = np.gradient(luma)
        return np.sqrt(gx * gx + gy * gy).astype(np.float32)


def _edge_field(arr: np.ndarray, p: dict) -> np.ndarray:
    """Select detail: edges stronger than `threshold`, grown by `spread` so the
    band covers the whole transition, with `feather` softening the threshold
    crossing exactly like the luminance mask's does."""
    h, w = arr.shape[:2]
    t = np.clip(float(p.get("threshold", 25)) / 100.0, 0.0, 1.0)
    feather = np.clip(float(p.get("feather", 50)) / 100.0, 0.0, 1.0)
    spread = np.clip(float(p.get("spread", 30)) / 100.0, 0.0, 1.0)
    long_edge = max(h, w, 1)
    scale = min(_EDGE_WORK_PX / long_edge, _EDGE_MAX_UPSCALE)
    gh, gw = (max(2, round(h * scale)), max(2, round(w * scale)))
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    if (gh, gw) != (h, w):
        luma = _resize_field(luma, gh, gw)
    mag = _luma_gradient(np.ascontiguousarray(luma, dtype=np.float32))
    # Into reference units: a frame k times smaller than the reference crams the
    # same edge into k times fewer pixels, so its gradients read k times steeper.
    work_long = max(gh, gw)
    if work_long != _EDGE_WORK_PX:
        mag = mag * (work_long / _EDGE_WORK_PX)
    thr = _EDGE_MIN_THRESHOLD + t * t * _EDGE_MAX_THRESHOLD
    fw = thr * feather + 1e-4
    field = _smoothstep((mag - thr) / fw + 0.5).astype(np.float32)
    if spread > 0:
        field = _grow(field, spread * _EDGE_MAX_SPREAD_PX * (work_long / _EDGE_WORK_PX))
    if (gh, gw) != (h, w):
        field = _resize_field(field, h, w)
    return np.clip(field, 0.0, 1.0).astype(np.float32)


def _grow(field: np.ndarray, radius: float) -> np.ndarray:
    """Dilate then blur by the same radius: the dilation is what actually widens
    the band (a blur alone only fades a hairline out), the blur puts a soft
    shoulder back on the widened edge."""
    if radius < 0.5:
        return field
    try:
        import cv2

        k = int(radius) * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        grown = cv2.dilate(field, kernel)
        return cv2.GaussianBlur(grown, (0, 0), sigmaX=radius * 0.6, sigmaY=radius * 0.6)
    except Exception:
        return field


# --- Semantic ("select the sky") masks ---------------------------------------
# The field is computed once by app.services.segmentation and stored in the
# sub-mask as a small PNG (see STORED_MASK_PX), so no model runs in the render
# path. Two things happen on the way back up to render size:
#
#  1. A guided filter re-snaps the upscaled field to the image's own edges. A
#     768px mask blown up to a 6000px export otherwise puts the sky/roofline
#     boundary up to eight pixels off, which shows as a halo the moment you
#     brighten one side of it. The filter is bounded to _REFINE_PX so a native
#     render doesn't pay for it at 40MP.
#  2. Feather blurs the result, exactly like the other masks' feather.
_REFINE_PX = 2048
# Guided-filter radius as a fraction of the long edge, and its regularisation.
# eps is in the guide's units squared (the image is 0..1 here): 1e-4 means
# "treat differences below ~1% brightness as flat", which keeps noise from
# pulling the mask edge around while still following real contours.
_REFINE_RADIUS_FRAC = 1 / 96
_REFINE_EPS = 1e-4


def _decode_mask_png(raw: str) -> np.ndarray | None:
    """Base64 grayscale PNG -> (h, w) float32 0..1, or None if unreadable."""
    import base64
    import io

    from PIL import Image as PILImage

    try:
        data = base64.b64decode(raw, validate=True)
        img = PILImage.open(io.BytesIO(data)).convert("L")
    except Exception:
        return None
    return np.asarray(img, dtype=np.float32) / 255.0


def _resize_field(f: np.ndarray, h: int, w: int) -> np.ndarray:
    if f.shape[0] == h and f.shape[1] == w:
        return f
    try:
        import cv2

        interp = cv2.INTER_AREA if (h * w) < (f.shape[0] * f.shape[1]) else cv2.INTER_LINEAR
        return cv2.resize(f, (w, h), interpolation=interp).astype(np.float32)
    except Exception:
        # No cv2: fall back to PIL, which covers the same two cases well enough.
        from PIL import Image as PILImage

        return np.asarray(
            PILImage.fromarray(f, mode="F").resize((w, h), PILImage.BILINEAR), dtype=np.float32
        )


def _refine_to_edges(f: np.ndarray, arr: np.ndarray) -> np.ndarray:
    """Pull a soft, upscaled field back onto the image's edges with a guided
    filter. Silently returns the input if opencv-contrib isn't there - the mask
    stays usable, just softer at the boundary."""
    try:
        import cv2

        h, w = f.shape
        scale = min(1.0, _REFINE_PX / max(h, w))
        gh, gw = (max(1, round(h * scale)), max(1, round(w * scale))) if scale < 1.0 else (h, w)
        guide = _resize_field(arr[..., 1], gh, gw) if scale < 1.0 else arr[..., 1]
        small = _resize_field(f, gh, gw) if scale < 1.0 else f
        radius = max(2, int(max(gh, gw) * _REFINE_RADIUS_FRAC))
        out = cv2.ximgproc.guidedFilter(
            np.ascontiguousarray(guide, dtype=np.float32),
            np.ascontiguousarray(small, dtype=np.float32),
            radius,
            _REFINE_EPS,
        )
        return _resize_field(np.clip(out, 0.0, 1.0).astype(np.float32), h, w)
    except Exception:
        return f


def _semantic_field(h: int, w: int, p: dict, arr: np.ndarray) -> np.ndarray:
    src = _decode_mask_png(str(p.get("mask") or ""))
    if src is None or src.size == 0:
        return np.zeros((h, w), dtype=np.float32)
    field = _resize_field(src, h, w)
    # Only worth refining when the stored mask is actually being stretched -
    # at the scrub tier it's usually being shrunk instead.
    if max(src.shape) * 1.4 < max(h, w):
        field = _refine_to_edges(field, arr)
    feather = np.clip(float(p.get("feather", 0)) / 100.0, 0.0, 1.0)
    if feather > 0:
        try:
            import cv2

            # Up to ~2% of the long edge, which is a wide, soft transition at
            # 100 and a barely-there smoothing at low values.
            sigma = feather * max(h, w) * 0.02
            field = cv2.GaussianBlur(field, (0, 0), sigmaX=sigma, sigmaY=sigma)
        except Exception:
            pass
    return np.clip(field, 0.0, 1.0).astype(np.float32)


def _submask_field(sm: dict, h: int, w: int, arr: np.ndarray) -> np.ndarray:
    t = sm.get("type")
    p = sm.get("parameters") or {}
    if t == "radial":
        f = _cached_spatial_field(t, p, h, w, lambda: _radial_field(h, w, p))
    elif t == "linear":
        f = _cached_spatial_field(t, p, h, w, lambda: _linear_field(h, w, p))
    elif t == "brush":
        f = _cached_spatial_field(t, p, h, w, lambda: _brush_field(h, w, p))
    elif t == "luminance":
        f = _luminance_field(arr, p)
    elif t == "color":
        f = _color_field(arr, p)
    elif t == "edge":
        f = _edge_field(arr, p)
    elif t == "semantic":
        # Decoding + refining costs enough to be worth the spatial cache, and the
        # stored PNG is a pure function of the parameters like any other shape.
        # The guide comes from the image, but a tonal edit never moves an edge
        # far enough to be worth re-refining every frame.
        f = _cached_spatial_field(t, p, h, w, lambda: _semantic_field(h, w, p, arr))
    elif t == "all":
        f = np.ones((h, w), dtype=np.float32)
    else:
        f = np.zeros((h, w), dtype=np.float32)
    if sm.get("invert"):
        f = 1.0 - f
    return np.clip(f, 0.0, 1.0)


def generate_mask_field(mask: dict, arr: np.ndarray) -> np.ndarray:
    """Combine a mask container's sub-masks into one (H, W) 0..1 field. The first
    visible sub-mask establishes the base; the rest add / subtract / intersect."""
    h, w = arr.shape[:2]
    field: np.ndarray | None = None
    for sm in mask.get("sub_masks") or []:
        if not sm.get("visible", True):
            continue
        f = _submask_field(sm, h, w, arr)
        mode = sm.get("mode", "additive")
        if field is None:
            field = f.copy()  # first sub-mask is the base regardless of its mode
        elif mode == "subtractive":
            field = np.clip(field - f, 0.0, 1.0)
        elif mode == "intersect":
            field = field * f
        else:  # additive
            field = np.clip(field + f, 0.0, 1.0)
    if field is None:
        return np.zeros((h, w), dtype=np.float32)
    return field.astype(np.float32)
