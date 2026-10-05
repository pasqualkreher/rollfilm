"""Calibration and the mixer's wide saturation (services/develop_color.py).

Two promises: a value that could be stored before the sliders reached further
renders exactly as it did, and the new reach does what it is for - a green that
goes dark and stays green, on the colours real leaves have, and a red that can
be lifted without clipping to white."""

import numpy as np

from app.services import develop, develop_color, develop_v2, thumbnails

LEAF = (0.455, 0.502, 0.36)  # foliage as the app renders it: barely saturated, nearer yellow
SKIN = (0.82, 0.62, 0.52)
BRICK = (0.62, 0.30, 0.24)


def _px(*rgb) -> np.ndarray:
    return np.array([[list(rgb)]], dtype=np.float32)


def _cal(rgb, **cal) -> np.ndarray:
    return develop_color.apply_color_calibration(_px(*rgb), cal)[0, 0]


def _hsl(rgb):
    h, s, l = develop_color._rgb_to_hsl(_px(*rgb))
    return float(h[0, 0]), float(s[0, 0]), float(l[0, 0])


def _oklab(rgb) -> np.ndarray:
    return develop_v2.linear_to_oklab(develop_v2._through_table(_px(*rgb), develop_v2._DECODE_TABLE))[0, 0]


# ---- compatibility ----------------------------------------------------------

def test_values_the_old_sliders_could_store_render_as_they_did():
    np.testing.assert_allclose(_cal((0, 1, 0), green_saturation=-100), (0.25, 0.75, 0.25), atol=1e-4)
    np.testing.assert_allclose(_cal((0, 1, 0), green_saturation=-50), (0.125, 0.875, 0.125), atol=1e-4)
    # +-30 degrees of hue at +-100, on the primary itself.
    hue, sat, _ = _hsl(_cal((1, 0, 0), red_hue=100))
    assert abs(hue - 30.0) < 0.5 and sat > 0.99


def test_a_neutral_calibration_is_the_same_array():
    arr = _px(*LEAF)
    assert develop_color.apply_color_calibration(arr, develop.normalize({})["color_calibration"]) is arr


def test_an_edit_saved_before_luminance_reads_zero():
    cal = develop.normalize({"color_calibration": {"green_saturation": 40}})["color_calibration"]
    assert cal["green_saturation"] == 40
    assert cal["red_luminance"] == cal["green_luminance"] == cal["blue_luminance"] == 0


# ---- reach ------------------------------------------------------------------

def test_limits():
    adj = develop.normalize({
        "color_calibration": {"green_saturation": -900, "red_saturation": 900, "green_luminance": -900,
                              "green_hue": 900, "shadows_tint": 900},
        "hsl": {"green": [900, 900, 900], "red": [-900, -900, -900]},
    })
    cal = adj["color_calibration"]
    assert (cal["green_saturation"], cal["red_saturation"], cal["green_hue"]) == (-200, 200, 200)
    assert (cal["green_luminance"], cal["shadows_tint"]) == (-100, 100)
    assert adj["hsl"]["green"] == [100, 200, 100]
    assert adj["hsl"]["red"] == [-100, -200, -100]


def test_primary_saturation_reaches_grey_and_double():
    grey = _cal((0, 1, 0), green_saturation=-200)
    assert float(np.ptp(grey)) < 1e-4
    _, before, _ = _hsl((0.3, 0.5, 0.3))
    _, after, _ = _hsl(_cal((0.3, 0.5, 0.3), green_saturation=200))
    assert abs(after / before - 2.0) < 0.02


def test_primary_hue_reaches_sixty_degrees_and_keeps_the_hues_in_order():
    hue, sat, _ = _hsl(_cal((0, 1, 0), green_hue=200))
    assert abs(hue - 180.0) < 0.5 and sat > 0.99
    hue, _, _ = _hsl(_cal((0, 1, 0), green_hue=-200))
    assert abs(hue - 60.0) < 0.5
    # Across the whole band, at either end of the slider: a hue further round
    # the wheel stays further round (within a degree, on the steepest flank).
    hues = np.arange(20.0, 221.0, 1.0, dtype=np.float32)
    ramp = develop_color._hsl_to_rgb(hues[None, :], np.full((1, hues.size), 0.6, np.float32),
                                     np.full((1, hues.size), 0.5, np.float32))
    for amount in (200, -200):
        out, _, _ = develop_color._rgb_to_hsl(
            develop_color.apply_color_calibration(ramp.astype(np.float32), {"green_hue": amount})
        )
        assert float(np.diff(out[0]).min()) > -0.1, amount


def test_green_luminance_darkens_a_leaf_and_keeps_its_colour():
    out = _cal(LEAF, green_luminance=-100)
    assert _oklab(out)[0] < 0.6 * _oklab(LEAF)[0]
    h0, s0, _ = _hsl(LEAF)
    h1, s1, _ = _hsl(out)
    assert abs(h1 - h0) < 1.0 and abs(s1 - s0) < 0.01
    # halfway down is between the two, not a switch
    half = _oklab(_cal(LEAF, green_luminance=-50))[0]
    assert _oklab(out)[0] < half < _oklab(LEAF)[0]


def test_green_luminance_leaves_everything_that_is_not_green():
    for rgb in ((0.5, 0.5, 0.5), (0.5, 0.51, 0.49), SKIN, BRICK, (0.35, 0.55, 0.85)):
        np.testing.assert_allclose(_cal(rgb, green_luminance=-100), rgb, atol=1e-4)


def test_red_luminance_lifts_reds_without_clipping_them():
    for rgb in (BRICK, SKIN, (0.3, 0.08, 0.06)):
        out = _cal(rgb, red_luminance=100)
        assert _oklab(out)[0] > 1.1 * _oklab(rgb)[0]
        assert float(out.max()) < 1.0
        assert abs(_hsl(out)[0] - _hsl(rgb)[0]) < 1.0
    np.testing.assert_allclose(_cal(LEAF, red_luminance=100), LEAF, atol=0.01)


# ---- the mixer's saturation -------------------------------------------------

def _chroma(rgb) -> float:
    lab = _oklab(rgb)
    return float(np.hypot(lab[1], lab[2]))


def test_mixer_saturation_goes_on_past_100():
    green = (0.42, 0.5, 0.4)

    def run(sat, process):
        adj = develop.normalize({"process": process, "hsl": {"green": [0, sat, 0]}})
        if process == "1":
            return thumbnails._apply_color_mix(_px(*green), adj["hsl"], 0.0, adj["hsl_range"])[0, 0]
        return develop_v2.apply_perceptual_color(_px(*green), adj)[0, 0]

    for process in ("1", "5"):
        c0, c100, c200 = _chroma(green), _chroma(run(100, process)), _chroma(run(200, process))
        assert c0 < c100 < c200, process
        assert _chroma(run(-200, process)) < 0.004, process


# ---- process 6: a primary moves its whole band -------------------------------

def _cal6(rgb, **cal) -> np.ndarray:
    return develop_color.apply_color_calibration(_px(*rgb), cal, whole_band=True)[0, 0]


def _turn(rgb, out) -> float:
    return (_hsl(out)[0] - _hsl(rgb)[0] + 180.0) % 360.0 - 180.0


# from a leaf that is yellow by its hue to a green past the primary
LEAVES = ((0.49, 0.5, 0.37), (0.474, 0.496, 0.348), LEAF, (0.435, 0.507, 0.373), (0.2, 0.7, 0.2), (0.2, 0.6, 0.3))


def test_whole_band_turns_every_green_by_the_same_amount():
    turns = [_turn(rgb, _cal6(rgb, green_hue=100)) for rgb in LEAVES]
    assert max(turns) - min(turns) < 0.5 and abs(turns[0] - 22.5) < 0.5
    # the bell it replaces gives the yellowish leaf less than half the green's
    old = [_turn(rgb, _cal(rgb, green_hue=100)) for rgb in (LEAVES[1], LEAVES[4])]
    assert old[0] < 0.5 * old[1]


def test_whole_band_leaves_the_other_colours_alone():
    # Green turned all the way up stays inside the bell's reach: no sky moves
    np.testing.assert_allclose(_cal6((0.35, 0.55, 0.85), green_hue=200), (0.35, 0.55, 0.85), atol=1e-4)
    for cal in ({"green_hue": 200}, {"green_hue": -60}, {"green_saturation": -200}, {"green_luminance": -100}):
        for rgb in ((0.5, 0.5, 0.5), SKIN, BRICK, (0.75, 0.6, 0.5), (0.35, 0.55, 0.85)):
            np.testing.assert_allclose(_cal6(rgb, **cal), rgb, atol=1e-4, err_msg=str(cal))


def test_whole_band_keeps_the_hues_in_order_at_the_end_of_the_slider():
    hues = np.arange(0.0, 360.0, 0.5, dtype=np.float32)
    ramp = develop_color._hsl_to_rgb(hues[None, :], np.full((1, hues.size), 0.6, np.float32),
                                     np.full((1, hues.size), 0.5, np.float32)).astype(np.float32)
    for key in ("red_hue", "green_hue", "blue_hue"):
        for amount in (200, -200):
            out, _, _ = develop_color._rgb_to_hsl(
                develop_color.apply_color_calibration(ramp, {key: amount}, whole_band=True)
            )
            steps = (np.diff(out[0]) + 180.0) % 360.0 - 180.0
            assert float(steps.min()) > 0.02, (key, amount)


def test_whole_band_darkens_and_desaturates_every_leaf_alike():
    dark = [_oklab(_cal6(rgb, green_luminance=-100))[0] / _oklab(rgb)[0] for rgb in LEAVES[:4]]
    assert max(dark) - min(dark) < 0.02 and 0.3 < dark[0] < 0.45
    for rgb in LEAVES:
        assert float(np.ptp(_cal6(rgb, green_saturation=-200))) < 1e-4


def test_only_process_6_renders_calibration_the_new_way():
    assert develop.CURRENT_PROCESS == "6"
    assert develop.normalize({"process": "6"})["process"] == "6"
    rng = np.random.default_rng(5)
    lin = (rng.random((48, 64, 3), dtype=np.float32) * 0.5 + 0.05).astype(np.float32)

    def render(process, **cal):
        adj = develop.normalize({"process": process, "color_calibration": cal})
        return np.asarray(thumbnails.apply_adjustments_linear(lin.copy(), 1.0, adj)).astype(int)

    # untouched, the two are the same picture; an edit on 5 keeps the bell
    np.testing.assert_array_equal(render("5"), render("6"))
    np.testing.assert_array_equal(render("4", green_hue=120), render("5", green_hue=120))
    assert np.abs(render("5", green_hue=120) - render("6", green_hue=120)).max() > 4


def test_whole_band_does_not_paint_noise_onto_a_colour_at_its_edge():
    # A tan wall sits where the green band begins. Its noise carries single
    # pixels in and out of the band; decided pixel by pixel that turns into
    # dark green specks. Read from the colours around each pixel, it doesn't.
    rng = np.random.default_rng(11)
    wall = np.array([0.42, 0.39, 0.24], dtype=np.float32)  # hue 50, inside Green's ramp
    arr = np.clip(wall + 0.035 * rng.standard_normal((160, 240, 3)).astype(np.float32), 0, 1)
    cal = {"green_hue": 126, "green_saturation": -50, "green_luminance": -25}

    def grain(out):
        return float(out.std(axis=(0, 1)).mean())

    per_pixel = develop_color.apply_color_calibration(arr.copy(), cal, whole_band=True, ref_long_edge=100)
    assert grain(per_pixel) > 1.25 * grain(arr)
    # a full-size frame (worked out on a small copy) and a preview (worked out in place)
    for long_edge in (4000, 1600):
        smoothed = develop_color.apply_color_calibration(arr.copy(), cal, whole_band=True, ref_long_edge=long_edge)
        assert grain(smoothed) < 1.08 * grain(arr), long_edge
    # and a flat colour comes out the same either way
    flat = np.broadcast_to(np.array(LEAF, dtype=np.float32), (64, 96, 3)).copy()
    np.testing.assert_allclose(
        develop_color.apply_color_calibration(flat.copy(), cal, whole_band=True, ref_long_edge=4000)[8:-8, 8:-8],
        np.broadcast_to(_cal6(LEAF, **cal), (48, 80, 3)), atol=2e-3,
    )


def test_whole_band_smoothing_stops_at_the_edge_of_a_leaf():
    # A dark leaf against a lit wall: the wall right beside the leaf is as
    # untouched as the wall far from it - no dark rim - and the leaf is darkened
    # right up to its edge.
    rng = np.random.default_rng(3)
    arr = np.empty((120, 200, 3), dtype=np.float32)
    arr[:, :100] = (0.10, 0.16, 0.08)   # leaf
    arr[:, 100:] = (0.62, 0.50, 0.40)   # wall, hue 27: not Green's
    arr = np.clip(arr + 0.01 * rng.standard_normal(arr.shape).astype(np.float32), 0, 1)
    out = develop_color.apply_color_calibration(arr.copy(), {"green_luminance": -60}, whole_band=True, ref_long_edge=4000)
    ratio = out.mean(axis=(0, 2)) / arr.mean(axis=(0, 2))   # per column
    assert abs(ratio[102:106].mean() - 1.0) < 0.02 and abs(ratio[150:].mean() - 1.0) < 0.005
    assert abs(ratio[94:98].mean() - ratio[:50].mean()) < 0.03 and ratio[:50].mean() < 0.5
