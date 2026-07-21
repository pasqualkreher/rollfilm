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

import numpy as np

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


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


def _brush_field(h: int, w: int, p: dict) -> np.ndarray:
    strokes = p.get("strokes") or []
    feather = np.clip(float(p.get("feather", 50)) / 100.0, 1e-3, 1.0)
    long_edge = max(h, w)
    field = np.zeros((h, w), dtype=np.float32)
    for pt in strokes:
        try:
            px = float(pt[0]) * w
            py = float(pt[1]) * h
            r = max(float(pt[2]) * long_edge, 1.0) if len(pt) > 2 else 0.05 * long_edge
        except (TypeError, ValueError, IndexError):
            continue
        # Stamp within the dab's bounding box only (cheap even for long strokes).
        x0 = max(0, int(px - r))
        x1 = min(w, int(px + r) + 1)
        y0 = max(0, int(py - r))
        y1 = min(h, int(py + r) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        lx = np.arange(x0, x1, dtype=np.float32) - px
        ly = np.arange(y0, y1, dtype=np.float32) - py
        d = np.sqrt(ly[:, None] ** 2 + lx[None, :] ** 2) / r
        dab = _smoothstep((1.0 - d) / feather)
        np.maximum(field[y0:y1, x0:x1], dab, out=field[y0:y1, x0:x1])
    return field


def _luminance_field(arr: np.ndarray, p: dict) -> np.ndarray:
    lo = np.clip(float(p.get("range_min", 0)) / 100.0, 0.0, 1.0)
    hi = np.clip(float(p.get("range_max", 100)) / 100.0, 0.0, 1.0)
    if hi < lo:
        lo, hi = hi, lo
    feather = np.clip(float(p.get("feather", 35)) / 100.0, 1e-3, 1.0) * 0.5
    luma = np.clip(arr @ _LUMA, 0.0, 1.0)
    lower = (luma - (lo - feather)) / feather
    upper = ((hi + feather) - luma) / feather
    return _smoothstep(np.minimum(lower, upper)).astype(np.float32)


def _color_field(arr: np.ndarray, p: dict) -> np.ndarray:
    target = np.array(
        [float(p.get("target_r", 0.5)), float(p.get("target_g", 0.5)), float(p.get("target_b", 0.5))],
        dtype=np.float32,
    )
    tol = np.clip(float(p.get("tolerance", 20)) / 100.0, 1e-3, 1.0)
    feather = np.clip(float(p.get("feather", 35)) / 100.0, 0.0, 1.0)
    dist = np.sqrt(((arr - target) ** 2).sum(axis=-1)) / np.sqrt(3.0)  # 0..1
    return _smoothstep((tol - dist) / (tol * feather + 1e-3) + 1.0).astype(np.float32)


def _submask_field(sm: dict, h: int, w: int, arr: np.ndarray) -> np.ndarray:
    t = sm.get("type")
    p = sm.get("parameters") or {}
    if t == "radial":
        f = _radial_field(h, w, p)
    elif t == "linear":
        f = _linear_field(h, w, p)
    elif t == "brush":
        f = _brush_field(h, w, p)
    elif t == "luminance":
        f = _luminance_field(arr, p)
    elif t == "color":
        f = _color_field(arr, p)
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
