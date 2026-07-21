"""Canonical schema for the non-destructive *develop* adjustments.

This module is the single source of truth for every tonal/colour/effect
adjustment the editor exposes: its key, value range and default. The whole
develop state is stored as one JSON object in ``Image.edit_adjustments`` (geometry
- rotation/crop/flip/straighten/perspective/distortion - stays in its own
columns). Storing it as one object (rather than one column per field) is what
lets curves, colour-grading wheels and the per-mask local adjustments nest
naturally, and means new adjustments never need a schema migration.

Ranges and defaults mirror RapidRAW's ``INITIAL_ADJUSTMENTS`` so the editor
matches it 1:1 (e.g. exposure in -5..5 EV, vignette midpoint 50, grain size 25).
The actual pixel maths lives in :mod:`app.services.develop_effects` and is wired
into the render pipeline in :mod:`app.services.thumbnails`.
"""

from __future__ import annotations

import json
from typing import Any

# The 8 HSL colour-mixer bands (same hues as the legacy mixer, so existing
# ``edit_color_mix`` data maps straight across). Each band carries
# [hue, saturation, luminance], each -100..100.
COLOR_BANDS: tuple[str, ...] = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")

# Scalar adjustments: key -> (default, min, max, is_float). Order is the order the
# editor lists them within each section.
SCALAR_SPEC: dict[str, tuple[float, float, float, bool]] = {
    # Basic / tone
    "exposure": (0.0, -5.0, 5.0, True),      # "EV Shift" - stops in linear light
    "brightness": (0.0, -5.0, 5.0, True),    # "Exposure" - second stop-like lift
    "contrast": (0, -100, 100, False),
    "highlights": (0, -100, 100, False),
    "shadows": (0, -100, 100, False),
    "whites": (0, -100, 100, False),
    "blacks": (0, -100, 100, False),
    # White balance / presence
    "temperature": (0, -100, 100, False),
    "tint": (0, -100, 100, False),
    "vibrance": (0, -100, 100, False),
    "saturation": (0, -100, 100, False),
    "hue": (0, -180, 180, False),            # global hue rotation (was color_tint)
    # Details
    "sharpness": (0, -100, 100, False),
    "sharpness_threshold": (15, 0, 80, False),
    "clarity": (0, -100, 100, False),
    "dehaze": (0, -100, 100, False),
    "structure": (0, -100, 100, False),
    "luma_noise_reduction": (0, 0, 100, False),
    "color_noise_reduction": (0, 0, 100, False),
    "chromatic_aberration_red_cyan": (0, -100, 100, False),
    "chromatic_aberration_blue_yellow": (0, -100, 100, False),
    # Effects
    "glow_amount": (0, 0, 100, False),
    "halation_amount": (0, 0, 100, False),
    "flare_amount": (0, 0, 100, False),
    "grain_amount": (0, 0, 100, False),
    "grain_size": (25, 0, 100, False),
    "grain_roughness": (50, 0, 100, False),
    "vignette_amount": (0, -100, 100, False),
    "vignette_midpoint": (50, 0, 100, False),
    "vignette_roundness": (0, -100, 100, False),
    "vignette_feather": (50, 0, 100, False),
    "lut_intensity": (100, 0, 100, False),
    # Fujifilm-style extras kept from the original editor (not in RapidRAW).
    "chrome_effect": (0, 0, 100, False),
    "chrome_blue": (0, 0, 100, False),
    "mist": (0, 0, 100, False),
}

# Enumerated (string) adjustments: key -> (default, allowed values).
ENUM_SPEC: dict[str, tuple[str, tuple[str, ...]]] = {
    "tone_mapper": ("basic", ("basic", "agx")),
    "curve_mode": ("point", ("point", "parametric")),
}

# Identity point curve: pass-through on the 0..255 grid.
_IDENTITY_CURVE = [[0, 0], [255, 255]]
_CURVE_CHANNELS = ("luma", "red", "green", "blue")
_PARAM_CURVE = {"highlights": 0, "lights": 0, "darks": 0, "shadows": 0,
                "white_level": 0, "black_level": 0, "split1": 25, "split2": 50, "split3": 75}
_GRADE_WHEEL = {"hue": 0, "saturation": 0, "luminance": 0}
_CALIBRATION = {"shadows_tint": 0, "red_hue": 0, "red_saturation": 0,
                "green_hue": 0, "green_saturation": 0, "blue_hue": 0, "blue_saturation": 0}


def _default_hsl() -> dict[str, list[int]]:
    return {b: [0, 0, 0] for b in COLOR_BANDS}


def _default_point_curves() -> dict[str, list[list[int]]]:
    return {ch: [p[:] for p in _IDENTITY_CURVE] for ch in _CURVE_CHANNELS}


def _default_parametric_curve() -> dict[str, dict]:
    return {ch: dict(_PARAM_CURVE) for ch in _CURVE_CHANNELS}


def _default_color_grading() -> dict[str, Any]:
    return {"shadows": dict(_GRADE_WHEEL), "midtones": dict(_GRADE_WHEEL),
            "highlights": dict(_GRADE_WHEEL), "global": dict(_GRADE_WHEEL),
            "blending": 50, "balance": 0}


def defaults() -> dict[str, Any]:
    """A fresh, fully-neutral develop object with every key present."""
    out: dict[str, Any] = {k: v[0] for k, v in SCALAR_SPEC.items()}
    out.update({k: v[0] for k, v in ENUM_SPEC.items()})
    out["hsl"] = _default_hsl()
    out["point_curves"] = _default_point_curves()
    out["parametric_curve"] = _default_parametric_curve()
    out["color_grading"] = _default_color_grading()
    out["color_calibration"] = dict(_CALIBRATION)
    out["masks"] = []
    return out


def _clampf(v: Any, lo: float, hi: float, default: float, is_float: bool) -> float | int:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    n = max(lo, min(hi, n))
    return float(n) if is_float else int(round(n))


def _norm_hsl(raw: Any) -> dict[str, list[int]]:
    out = _default_hsl()
    if isinstance(raw, dict):
        for band in COLOR_BANDS:
            vals = raw.get(band)
            if isinstance(vals, (list, tuple)):
                out[band] = [int(_clampf(vals[i] if i < len(vals) else 0, -100, 100, 0, False)) for i in range(3)]
    return out


def _norm_point_curves(raw: Any) -> dict[str, list[list[int]]]:
    out = _default_point_curves()
    if isinstance(raw, dict):
        for ch in _CURVE_CHANNELS:
            pts = raw.get(ch)
            if isinstance(pts, (list, tuple)) and len(pts) >= 2:
                cleaned = []
                for p in pts[:16]:
                    if isinstance(p, (list, tuple)) and len(p) >= 2:
                        cleaned.append([int(_clampf(p[0], 0, 255, 0, False)), int(_clampf(p[1], 0, 255, 0, False))])
                if len(cleaned) >= 2:
                    out[ch] = cleaned
    return out


def _norm_parametric(raw: Any) -> dict[str, dict]:
    out = _default_parametric_curve()
    if isinstance(raw, dict):
        for ch in _CURVE_CHANNELS:
            c = raw.get(ch)
            if isinstance(c, dict):
                out[ch] = {k: int(_clampf(c.get(k, d), -100, 100 if k not in ("split1", "split2", "split3") else 100, d, False))
                           for k, d in _PARAM_CURVE.items()}
    return out


def _norm_wheel(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return dict(_GRADE_WHEEL)
    return {
        "hue": int(_clampf(raw.get("hue", 0), 0, 360, 0, False)),
        "saturation": int(_clampf(raw.get("saturation", 0), 0, 100, 0, False)),
        "luminance": int(_clampf(raw.get("luminance", 0), -100, 100, 0, False)),
    }


def _norm_color_grading(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return _default_color_grading()
    return {
        "shadows": _norm_wheel(raw.get("shadows")),
        "midtones": _norm_wheel(raw.get("midtones")),
        "highlights": _norm_wheel(raw.get("highlights")),
        "global": _norm_wheel(raw.get("global")),
        "blending": int(_clampf(raw.get("blending", 50), 0, 100, 50, False)),
        "balance": int(_clampf(raw.get("balance", 0), -100, 100, 0, False)),
    }


def _norm_calibration(raw: Any) -> dict[str, int]:
    out = dict(_CALIBRATION)
    if isinstance(raw, dict):
        for k in _CALIBRATION:
            out[k] = int(_clampf(raw.get(k, 0), -100, 100, 0, False))
    return out


# --- Masks (local adjustments) ----------------------------------------------
_SUBMASK_TYPES = ("radial", "linear", "brush", "luminance", "color", "all")
_SUBMASK_MODES = ("additive", "subtractive", "intersect")


def _norm_mask_adjustments(raw: Any) -> dict[str, Any]:
    """A mask's local adjustments, stored *sparsely* (only the scalar develop
    fields the user actually changed, clamped). thumbnails.apply_masks() merges
    them over the develop defaults and applies the tonal/colour/detail subset
    inside the mask; the pixel-level effects (grain/vignette/glow) are global."""
    src = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for k, (default, lo, hi, is_float) in SCALAR_SPEC.items():
        if k in src:
            v = _clampf(src.get(k, default), lo, hi, default, is_float)
            if v != default:
                out[k] = v
    return out


def _norm_submask(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("type") not in _SUBMASK_TYPES:
        return None
    mode = raw.get("mode", "additive")
    params = raw.get("parameters")
    return {
        "id": str(raw.get("id", "")),
        "type": raw["type"],
        "mode": mode if mode in _SUBMASK_MODES else "additive",
        "visible": bool(raw.get("visible", True)),
        "invert": bool(raw.get("invert", False)),
        "parameters": params if isinstance(params, dict) else {},
    }


def _norm_masks(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        subs = [s for s in (_norm_submask(x) for x in (m.get("sub_masks") or [])) if s]
        out.append(
            {
                "id": str(m.get("id", "")),
                "name": str(m.get("name", "Mask")),
                "visible": bool(m.get("visible", True)),
                "opacity": int(_clampf(m.get("opacity", 100), 0, 100, 100, False)),
                "invert": bool(m.get("invert", False)),
                "sub_masks": subs,
                "adjustments": _norm_mask_adjustments(m.get("adjustments")),
            }
        )
    return out


def normalize(raw: Any) -> dict[str, Any]:
    """Coerce an arbitrary/partial develop object into the full canonical shape:
    every key present, every value the right type and clamped to its range.
    Unknown keys are dropped. Masks are validated in :mod:`app.services.masks`."""
    src = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for k, (default, lo, hi, is_float) in SCALAR_SPEC.items():
        out[k] = _clampf(src.get(k, default), lo, hi, default, is_float)
    for k, (default, allowed) in ENUM_SPEC.items():
        v = src.get(k, default)
        out[k] = v if v in allowed else default
    out["hsl"] = _norm_hsl(src.get("hsl"))
    out["point_curves"] = _norm_point_curves(src.get("point_curves"))
    out["parametric_curve"] = _norm_parametric(src.get("parametric_curve"))
    out["color_grading"] = _norm_color_grading(src.get("color_grading"))
    out["color_calibration"] = _norm_calibration(src.get("color_calibration"))
    out["masks"] = _norm_masks(src.get("masks"))
    return out


# Cached so ``is_neutral`` doesn't rebuild the default object on every call.
_DEFAULTS_NORM = normalize({})


def is_neutral(adj: dict[str, Any]) -> bool:
    """True when the develop object has no visible effect (equals the defaults and
    carries no masks). Used to decide whether to store anything and to tag the
    photo as edited."""
    n = normalize(adj)
    # A mask counts only if it's visible, actually selects a region (has a
    # sub-mask) and carries at least one non-default local adjustment.
    for m in n.get("masks") or []:
        if m.get("visible", True) and m.get("sub_masks") and m.get("adjustments"):
            return False
    for k in n:
        if k == "masks":
            continue
        if n[k] != _DEFAULTS_NORM[k]:
            return False
    return True


def loads(raw: str | None) -> dict[str, Any]:
    """Parse a stored ``edit_adjustments`` JSON string into a normalized object
    (defaults when null/blank/malformed)."""
    if not raw:
        return normalize({})
    try:
        return normalize(json.loads(raw))
    except (ValueError, TypeError):
        return normalize({})


def dumps(adj: dict[str, Any]) -> str | None:
    """Serialize a develop object for storage, or None when fully neutral (so a
    no-op edit stores NULL rather than a big default blob)."""
    if is_neutral(adj):
        return None
    return json.dumps(normalize(adj), separators=(",", ":"))
