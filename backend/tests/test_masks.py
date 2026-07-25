"""Behaviour of the mask fields that local adjustments are weighted by.

These pin the properties a user actually judges the masks on - where a selection
ends ("reach"), how softly it gets there ("fade"), and that a brush behaves like
a brush - rather than the exact numbers, which are free to be retuned.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import numpy as np
import pytest

from app.services import masks

H = W = 240


def _grey_ramp() -> np.ndarray:
    """Left-to-right 0..1 greyscale, for probing tonal reach."""
    arr = np.zeros((H, W, 3), dtype=np.float32)
    arr[:] = np.linspace(0.0, 1.0, W, dtype=np.float32)[None, :, None]
    return arr


def _patch(rgb) -> np.ndarray:
    a = np.zeros((8, 8, 3), dtype=np.float32)
    a[:] = np.array(rgb, dtype=np.float32)
    return a


def _line(start=0.25, end=0.75, y=0.5, size=0.05, n=60, erase=False):
    """A painted stroke as the editor records it: pointer-down flag on the first
    sample, plain samples after."""
    flags0 = masks._PEN_DOWN | (masks._ERASE if erase else 0)
    flags = masks._ERASE if erase else 0
    return [
        [start + (end - start) * i / (n - 1), y, size, flags0 if i == 0 else flags]
        for i in range(n)
    ]


# --- brush: stroke geometry ---------------------------------------------------

def test_stroke_edge_is_independent_of_sampling_density():
    """The same gesture drawn fast or slow must give the same mask. Stamping a
    dab per sample made the edge scallop by however far the pointer had moved,
    so a quick drag produced a visibly different (and lumpier) stroke."""
    dense = _line(n=200)
    sparse = _line(n=12)
    a = masks._brush_field(H, W, {"strokes": dense, "feather": 50})
    b = masks._brush_field(H, W, {"strokes": sparse, "feather": 50})
    assert np.abs(a - b).max() < 0.02


def test_feather_widens_the_soft_edge():
    """Feather has to visibly change the falloff - the user's report was that it
    did nothing."""
    ramps = []
    for f in (0, 25, 50, 75, 100):
        col = masks._brush_field(H, W, {"strokes": _line(), "feather": f})[:, W // 2]
        core = np.where(col >= 0.95)[0]
        edge = np.where(col > 0.02)[0]
        core_px = (core.max() - core.min()) if len(core) else 0
        ramps.append((edge.max() - edge.min() - core_px) / 2.0)
    assert ramps[0] == pytest.approx(0.0, abs=1.0)  # feather 0 = hard edge
    assert all(b > a for a, b in zip(ramps, ramps[1:])), ramps


def test_stroke_is_continuous_between_samples():
    """Sweeping segments (not dabs) means no gaps even when samples are far
    apart relative to the brush."""
    col = masks._brush_field(H, W, {"strokes": _line(n=6, size=0.03), "feather": 20})
    mid = col[int(0.5 * H), int(0.25 * W) : int(0.75 * W)]
    assert mid.min() > 0.9


def test_separate_strokes_are_not_joined():
    """Every stroke's samples live in one flat list, so the boundaries must be
    recovered - otherwise a line appears from where one stroke ended to where
    the next began."""
    two = _line(0.1, 0.2, n=10) + _line(0.8, 0.9, n=10)
    f = masks._brush_field(H, W, {"strokes": two, "feather": 40})
    assert f[H // 2, int(0.15 * W)] > 0.9
    assert f[H // 2, int(0.85 * W)] > 0.9
    assert f[H // 2, W // 2] < 0.01  # the gap between them


def test_legacy_strokes_without_flags_still_render():
    """Masks saved before the flags existed carry 3-element samples; they must
    keep working, and still not get joined across a jump."""
    legacy = [[0.2, 0.5, 0.03], [0.8, 0.5, 0.03]]
    f = masks._brush_field(H, W, {"strokes": legacy, "feather": 50})
    assert f[H // 2, int(0.2 * W)] > 0.9
    assert f[H // 2, int(0.8 * W)] > 0.9
    assert f[H // 2, W // 2] < 0.01


# --- brush: flow / density / eraser -------------------------------------------

def test_one_stroke_lays_down_flow():
    f = masks._brush_field(H, W, {"strokes": _line(), "feather": 0, "flow": 30})
    assert f.max() == pytest.approx(0.30, abs=0.02)


def test_repeated_strokes_build_up():
    once = masks._brush_field(H, W, {"strokes": _line(), "feather": 0, "flow": 30})
    thrice = masks._brush_field(H, W, {"strokes": _line() * 3, "feather": 0, "flow": 30})
    assert thrice.max() > once.max() + 0.2


def test_dragging_over_your_own_stroke_does_not_build_up():
    """Within one stroke the capsules max-blend: painting back and forth in a
    single gesture must not darken where the stroke crosses itself, or a low flow
    would be unusable."""
    there_and_back = _line(0.25, 0.75, n=40) + [
        [0.75 - 0.5 * i / 39, 0.5, 0.05, 0] for i in range(40)
    ]
    f = masks._brush_field(H, W, {"strokes": there_and_back, "feather": 0, "flow": 25})
    assert f.max() == pytest.approx(0.25, abs=0.02)


def test_density_caps_the_build_up():
    f = masks._brush_field(H, W, {"strokes": _line() * 12, "feather": 0, "flow": 50, "density": 60})
    assert f.max() <= 0.61


def test_eraser_removes_painted_area():
    painted = _line(0.2, 0.8, n=80)
    erased = _line(0.45, 0.55, n=10, erase=True)
    f = masks._brush_field(H, W, {"strokes": painted + erased, "feather": 10, "flow": 100})
    assert f[H // 2, W // 2] < 0.02  # wiped
    assert f[H // 2, int(0.25 * W)] > 0.9  # untouched part of the stroke


def test_eraser_at_low_flow_removes_gradually():
    """One `flow` governs both painting and erasing, so at 40 a stroke lays down
    0.40 and an erase pass takes 40% of that away, leaving 0.24. The point is
    that erasing is proportional rather than all-or-nothing."""
    painted = _line(0.2, 0.8, n=80)
    erased = _line(0.45, 0.55, n=10, erase=True)
    prm = {"strokes": painted, "feather": 0, "flow": 40}
    before = masks._brush_field(H, W, prm)[H // 2, W // 2]
    after = masks._brush_field(H, W, {**prm, "strokes": painted + erased})[H // 2, W // 2]
    assert before == pytest.approx(0.40, abs=0.02)
    assert after == pytest.approx(before * 0.6, abs=0.02)
    # Two erase passes take more off than one, but never below zero.
    twice = masks._brush_field(H, W, {**prm, "strokes": painted + erased + erased})[H // 2, W // 2]
    assert 0.0 <= twice < after


# --- brush: size convention ---------------------------------------------------

def test_brush_is_round_in_pixels_on_a_non_square_image():
    """`size` is a fraction of the LONG edge, so a dab is a circle in pixels -
    the overlay relies on this to draw the ring at the right size."""
    f = masks._brush_field(200, 400, {"strokes": [[0.5, 0.5, 0.1, masks._PEN_DOWN]], "feather": 0})
    ys = np.where(f[:, 200] > 0.5)[0]
    xs = np.where(f[100, :] > 0.5)[0]
    # 0.1 * long edge (400) = 40px radius -> ~80px across, both ways.
    assert len(xs) == pytest.approx(80, abs=3)
    assert len(ys) == pytest.approx(80, abs=3)


# --- luminance ----------------------------------------------------------------

@pytest.mark.parametrize("feather", [0, 35, 100])
def test_luminance_range_max_is_the_half_crossing(feather):
    """The slider value is the selection's real edge: Feather softens the
    transition without also extending the reach (it used to do both)."""
    line = masks._luminance_field(_grey_ramp(), {"range_min": 0, "range_max": 50, "feather": feather})[H // 2]
    edge = np.where(line >= 0.5)[0].max() / W
    assert edge == pytest.approx(0.50, abs=0.02)


def test_luminance_feather_only_changes_softness():
    hard = masks._luminance_field(_grey_ramp(), {"range_min": 20, "range_max": 60, "feather": 0})[H // 2]
    soft = masks._luminance_field(_grey_ramp(), {"range_min": 20, "range_max": 60, "feather": 100})[H // 2]
    span = lambda l: (np.where(l >= 0.5)[0].min(), np.where(l >= 0.5)[0].max())
    assert span(hard) == pytest.approx(span(soft), abs=3)
    # ...but the soft one ramps over many more pixels.
    width = lambda l: len(np.where((l > 0.02) & (l < 0.98))[0])
    assert width(soft) > width(hard) + 20


def test_luminance_at_the_extreme_does_not_fade_out():
    """Selecting "shadows up to 50" must include pure black fully, not fade it."""
    f = masks._luminance_field(_grey_ramp(), {"range_min": 0, "range_max": 50, "feather": 100})
    assert f[H // 2, 0] > 0.99
    f2 = masks._luminance_field(_grey_ramp(), {"range_min": 50, "range_max": 100, "feather": 100})
    assert f2[H // 2, -1] > 0.99


# --- colour -------------------------------------------------------------------

def test_colour_selects_one_material_across_shading():
    """The point of a colour mask. A plain RGB radius put the same red in sun and
    in shade far apart, so it could only ever catch one exposure of an object."""
    prm = {"target_r": 0.60, "target_g": 0.14, "target_b": 0.12, "tolerance": 20, "feather": 35}
    for name, rgb in (
        ("lit", [0.92, 0.22, 0.18]),
        ("mid", [0.60, 0.14, 0.12]),
        ("shadow", [0.24, 0.06, 0.05]),
    ):
        assert masks._color_field(_patch(rgb), prm).mean() > 0.5, name


def test_colour_rejects_other_hues_and_neutrals():
    prm = {"target_r": 0.60, "target_g": 0.14, "target_b": 0.12, "tolerance": 20, "feather": 35}
    assert masks._color_field(_patch([0.5, 0.5, 0.5]), prm).mean() < 0.1
    assert masks._color_field(_patch([0.18, 0.28, 0.85]), prm).mean() < 0.1


def test_colour_tolerance_is_the_half_crossing():
    """tolerance is the 0.5 point in the same chromaticity units the field uses,
    so widening Feather no longer secretly widens the selection too."""
    frac = np.linspace(0.0, 1.0, W, dtype=np.float32)
    hue = np.zeros((H, W, 3), dtype=np.float32)
    hue[..., 0] = 0.30 + 0.40 * frac[None, :]
    hue[..., 1] = 0.70 - 0.40 * frac[None, :]
    hue[..., 2] = 0.30
    target = np.array([hue[0, 0, 0], hue[0, 0, 1], 0.30], dtype=np.float32)
    chroma_t = masks._chromaticity(target)
    prm = {"target_r": float(target[0]), "target_g": float(target[1]), "target_b": 0.30}
    for tol in (5, 10, 20):  # this ramp only spans ~0.31 chromaticity units
        line = masks._color_field(hue, {**prm, "tolerance": tol, "feather": 35})[H // 2]
        edge_x = int(np.where(line >= 0.5)[0].max())
        d = float(
            np.sqrt(((masks._chromaticity(hue[H // 2, edge_x]) - chroma_t) ** 2).sum())
            / masks._CHROMA_NORM
        )
        assert d == pytest.approx(tol / 100.0, abs=0.02), tol


def test_near_black_has_no_wild_chromaticity():
    """Dividing by a near-zero brightness would turn sensor noise into a hue and
    make near-black pixels match arbitrary colour targets."""
    prm = {"target_r": 0.60, "target_g": 0.14, "target_b": 0.12, "tolerance": 20, "feather": 35}
    assert masks._color_field(_patch([0.002, 0.001, 0.0]), prm).mean() < 0.1
    # And two near-blacks are treated alike rather than as opposite hues.
    a = masks._chromaticity(np.array([0.004, 0.001, 0.002], dtype=np.float32))
    b = masks._chromaticity(np.array([0.001, 0.004, 0.002], dtype=np.float32))
    assert np.abs(a - b).max() < 1e-6


# --- container combination ----------------------------------------------------

def test_sub_masks_combine_and_invert():
    left = {"type": "brush", "parameters": {"strokes": _line(0.1, 0.3, n=20), "feather": 0}}
    right = {"type": "brush", "parameters": {"strokes": _line(0.7, 0.9, n=20), "feather": 0}}
    arr = np.zeros((H, W, 3), dtype=np.float32)
    add = masks.generate_mask_field({"sub_masks": [left, {**right, "mode": "additive"}]}, arr)
    assert add[H // 2, int(0.2 * W)] > 0.9 and add[H // 2, int(0.8 * W)] > 0.9
    sub = masks.generate_mask_field({"sub_masks": [left, {**right, "mode": "subtractive"}]}, arr)
    assert sub[H // 2, int(0.2 * W)] > 0.9 and sub[H // 2, int(0.8 * W)] < 0.01
    inv = masks.generate_mask_field({"sub_masks": [{**left, "invert": True}]}, arr)
    assert inv[H // 2, int(0.2 * W)] < 0.01 and inv[H // 2, W // 2] > 0.9
