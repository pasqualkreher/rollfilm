"""Auto-develop: suggest develop settings learned from the user's own edits.

A retrieval (k-NN) recommender, not a trained model: the photos the user has
already developed - saved in place (``edit_adjustments``) or baked into a copy
(``applied_adjustments``) - form the example pool. For a new photo we look up
its CLIP embedding, find the most visually similar examples in that pool and
blend their develop settings, weighted by similarity. Every new saved edit
immediately becomes a new example, so the suggestions track the user's style
with no training step, and deleting a photo from the library removes its
example just as naturally.

Works from a single example (the nearest neighbor's settings are simply
suggested as-is); more edited photos mean closer neighbors and better blends.

RAW and JPEG edits are kept apart when possible (a RAW gets developed from
flat, a JPEG only fine-tuned - see suggest_adjustments), and an edited
RAW+JPEG pair only ever votes with one of its halves.

What is (and isn't) suggested:
  - all global scalar sliders, HSL mixer, point + parametric curves, colour
    grading wheels and colour calibration are blended;
  - masks are *never* suggested - they are spatial regions drawn for one
    specific photo and don't transfer to a different composition;
  - geometry (crop/rotation/straighten/...) is left alone for the same reason.
"""

from __future__ import annotations

import math
from typing import Any, NamedTuple

import numpy as np
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.models import FileType, Image
from app.services import develop, embeddings
from app.services.settings_store import AUTO_DEVELOP_GROUP_NAMES

# How many nearest examples to blend. Small on purpose: develop styles are
# local ("this is how I do backlit portraits"), and a wide average pulls every
# suggestion toward one global muddy mean.
K_NEIGHBORS = 5
# Softmax temperature over cosine similarity. CLIP similarities between real
# photos cluster in a narrow band (~0.5..0.9), so a small tau is what turns
# "0.82 vs 0.78" into a meaningfully higher weight for the closer neighbor.
_TAU = 0.05

# Fixed resample grid for blending point curves: neighbors' curves rarely share
# control points, so each is sampled here and the y-values are averaged.
_CURVE_XS = (0, 32, 64, 96, 128, 160, 192, 224, 255)

# Which develop fields belong to each user-toggleable group (the Settings
# checkboxes, names in settings_store.AUTO_DEVELOP_GROUP_NAMES). Groups the
# user unchecks are stripped from the suggestion, so those sliders keep
# whatever value the editor currently holds.
GROUP_FIELDS: dict[str, tuple[str, ...]] = {
    "tone": ("exposure", "brightness", "contrast", "highlights", "shadows", "whites", "blacks", "tone_mapper"),
    "white_balance": ("temperature", "tint"),
    "color": ("vibrance", "saturation", "hue", "chrome_effect", "chrome_blue",
              "hsl", "color_grading", "color_calibration"),
    "details": ("sharpness", "sharpness_threshold", "clarity", "dehaze", "structure",
                "luma_noise_reduction", "color_noise_reduction",
                "chromatic_aberration_red_cyan", "chromatic_aberration_blue_yellow"),
    "curves": ("curve_mode", "point_curves", "parametric_curve"),
    "effects": ("glow_amount", "halation_amount", "flare_amount",
                "grain_amount", "grain_size", "grain_roughness",
                "vignette_amount", "vignette_midpoint", "vignette_roundness", "vignette_feather",
                "lut_intensity", "mist"),
}

# Every develop field must be assigned to exactly one group - a new slider that
# isn't grouped would silently never be suggested, so fail loudly at import
# instead. The exceptions are compositional/spatial fields that don't transfer
# between photos: masks (spatial regions) and frame_width (a presentation border);
# both are deliberately left out of every group so they're never suggested.
_UNGROUPED = {"masks", "frame_width"}
assert set(GROUP_FIELDS) == set(AUTO_DEVELOP_GROUP_NAMES)
_grouped = [f for fields in GROUP_FIELDS.values() for f in fields]
assert sorted(_grouped) == sorted(set(develop.defaults()) - _UNGROUPED), (
    "GROUP_FIELDS out of sync with the develop schema: "
    f"{set(_grouped) ^ (set(develop.defaults()) - _UNGROUPED)}"
)


def filter_to_groups(adj: dict[str, Any], group_names: list[str]) -> dict[str, Any]:
    """Reduce a full suggestion to only the fields of the enabled groups. The
    result is a *partial* develop object - the editor spreads it over its
    current state, so everything omitted here simply stays as it is."""
    allowed: set[str] = set()
    for g in group_names:
        allowed.update(GROUP_FIELDS.get(g, ()))
    return {k: v for k, v in adj.items() if k in allowed}


class _Example(NamedTuple):
    id: str
    blob: str
    is_raw: bool
    paired_image_id: str | None


def _example_rows(db: Session, owner_id: int, exclude_ids: set[str]) -> list[_Example]:
    """Every eligible example: not trashed, still in the library, and carrying
    a saved edit. For a copy that was later edited in place again, the baked
    ``applied_adjustments`` wins - it holds the full look, while
    ``edit_adjustments`` is only the small delta on top of it."""
    rows = (
        db.query(
            Image.id,
            Image.applied_adjustments,
            Image.edit_adjustments,
            Image.file_type,
            Image.paired_image_id,
        )
        .filter(
            Image.owner_id == owner_id,
            Image.deleted_at.is_(None),
            or_(Image.edit_adjustments.isnot(None), Image.applied_adjustments.isnot(None)),
        )
        .all()
    )
    return [
        _Example(r[0], r[1] or r[2], r[3] == FileType.raw, r[4])
        for r in rows
        if r[0] not in exclude_ids
    ]


def _weights(sims: np.ndarray) -> np.ndarray:
    w = np.exp((sims - sims.max()) / _TAU)
    return w / w.sum()


def _circular_mean_deg(degs: list[float], weights: list[float]) -> float:
    """Weighted mean of angles in degrees (0 when everything cancels out)."""
    x = sum(w * math.cos(math.radians(d)) for d, w in zip(degs, weights))
    y = sum(w * math.sin(math.radians(d)) for d, w in zip(degs, weights))
    if abs(x) < 1e-9 and abs(y) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(y, x))


def _blend_wheel(wheels: list[dict], weights: list[float]) -> dict:
    """Colour-grading wheels are (hue angle, saturation radius) polar values:
    average them as 2-D vectors so hue 350 and hue 10 blend to hue 0, not 180."""
    x = sum(w * wl["saturation"] * math.cos(math.radians(wl["hue"])) for wl, w in zip(wheels, weights))
    y = sum(w * wl["saturation"] * math.sin(math.radians(wl["hue"])) for wl, w in zip(wheels, weights))
    sat = math.hypot(x, y)
    hue = math.degrees(math.atan2(y, x)) % 360 if sat > 1e-9 else 0
    return {
        "hue": int(round(hue)),
        "saturation": int(round(sat)),
        "luminance": _wmean([wl["luminance"] for wl in wheels], weights),
    }


def _wmean(values: list[float], weights: list[float]) -> float:
    return sum(v * w for v, w in zip(values, weights))


def _vote(values: list[str], weights: list[float]) -> str:
    tally: dict[str, float] = {}
    for v, w in zip(values, weights):
        tally[v] = tally.get(v, 0.0) + w
    return max(tally, key=lambda k: tally[k])


def _blend_point_curve(curves: list[list[list[int]]], weights: list[float]) -> list[list[int]]:
    """Resample every neighbor's curve on a fixed x-grid, average the ys, and
    collapse back to the 2-point identity when the blend is (near) identity so
    a neutral suggestion stays neutral."""
    ys = np.zeros(len(_CURVE_XS))
    for curve, w in zip(curves, weights):
        pts = sorted(curve, key=lambda p: p[0])
        xs = [p[0] for p in pts]
        cys = [p[1] for p in pts]
        ys += w * np.interp(_CURVE_XS, xs, cys)
    if np.abs(ys - np.asarray(_CURVE_XS)).max() < 1.0:
        return [[0, 0], [255, 255]]
    return [[int(x), int(round(y))] for x, y in zip(_CURVE_XS, ys)]


def blend_adjustments(examples: list[tuple[dict[str, Any], float]]) -> dict[str, Any]:
    """Blend normalized develop objects into one suggestion, weighted by
    similarity. Numeric fields get a weighted mean (angles a circular one),
    enums a weighted vote, masks are dropped."""
    adjs = [develop.normalize(a) for a, _ in examples]
    w = list(_weights(np.asarray([s for _, s in examples], dtype=np.float64)))

    out: dict[str, Any] = {}
    for key in develop.SCALAR_SPEC:
        vals = [a[key] for a in adjs]
        # The global hue slider is an angle: -170 and +170 must not average to 0.
        out[key] = _circular_mean_deg(vals, w) if key == "hue" else _wmean(vals, w)
    for key in develop.ENUM_SPEC:
        out[key] = _vote([a[key] for a in adjs], w)
    out["hsl"] = {
        band: [_wmean([a["hsl"][band][i] for a in adjs], w) for i in range(3)]
        for band in develop.COLOR_BANDS
    }
    out["point_curves"] = {
        ch: _blend_point_curve([a["point_curves"][ch] for a in adjs], w)
        for ch in ("luma", "red", "green", "blue")
    }
    out["parametric_curve"] = {
        ch: {k: _wmean([a["parametric_curve"][ch][k] for a in adjs], w) for k in adjs[0]["parametric_curve"][ch]}
        for ch in ("luma", "red", "green", "blue")
    }
    grading = {
        zone: _blend_wheel([a["color_grading"][zone] for a in adjs], w)
        for zone in ("shadows", "midtones", "highlights", "global")
    }
    grading["blending"] = _wmean([a["color_grading"]["blending"] for a in adjs], w)
    grading["balance"] = _wmean([a["color_grading"]["balance"] for a in adjs], w)
    out["color_grading"] = grading
    out["color_calibration"] = {
        k: _wmean([a["color_calibration"][k] for a in adjs], w) for k in adjs[0]["color_calibration"]
    }
    out["masks"] = []  # spatial, never transferable between photos
    return develop.normalize(out)


def suggest_adjustments(
    db: Session, engine, image: Image, vector: np.ndarray
) -> tuple[dict[str, Any], int] | None:
    """The develop suggestion for ``image`` given its CLIP embedding, plus how
    many examples it was blended from - or None when the user hasn't saved any
    edits yet. The photo itself and its RAW/JPEG partner never teach themselves."""
    exclude = {image.id}
    if image.paired_image_id:
        exclude.add(image.paired_image_id)
    examples = _example_rows(db, image.owner_id, exclude)
    if not examples:
        return None

    # Same-type-first: a RAW starts flat and needs full development, while a
    # camera JPEG arrives with its look baked in and only gets fine-tuning -
    # mixing the two makes RAW suggestions too timid and JPEG ones too heavy.
    # So a RAW target learns from RAW edits and a JPEG target from JPEG edits
    # (and saved copies, which are always JPEGs) whenever any exist; only an
    # empty same-type pool falls back to everything, so the feature still works
    # from a single edited photo of either kind.
    target_is_raw = image.file_type == FileType.raw
    same_type = [ex for ex in examples if ex.is_raw == target_is_raw]
    pool = same_type or examples

    # The pool is only as big as the user's edit history, so scoring it
    # exhaustively (one dot product per example) is cheap and exact - no need to
    # detour through the ANN index and re-filter its results.
    vecs = embeddings.get_embeddings(engine, [ex.id for ex in pool])
    scored = sorted(
        ((ex, float(np.dot(vector, vecs[ex.id]))) for ex in pool if ex.id in vecs),
        key=lambda t: t[1],
        reverse=True,
    )
    # A RAW+JPEG pair is one shot: when both halves were edited, only the more
    # similar one votes - otherwise a single pair would fill two of the K
    # neighbor slots with nearly identical embeddings and dominate the blend.
    top: list[tuple[dict[str, Any], float]] = []
    taken: set[str] = set()
    for ex, sim in scored:
        if ex.paired_image_id and ex.paired_image_id in taken:
            continue
        taken.add(ex.id)
        top.append((develop.loads(ex.blob), sim))
        if len(top) == K_NEIGHBORS:
            break
    if not top:
        return None
    return blend_adjustments(top), len(top)
