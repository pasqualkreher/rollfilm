"""Process version 2 (services/develop_v2.py).

Two promises: an edit saved before it existed renders exactly as it did, and
an edit on it gets the four things it is for - perceptual colour, Highlights/
Shadows that keep local contrast, halo-free luminance sharpening, and mask
adjustments that work under the highlight shoulder."""

import numpy as np

from app.services import develop, develop_v2, masks, thumbnails


def _v(adj: dict, process: str) -> dict:
    return develop.normalize({**adj, "process": process})


def _scene(h=240, w=320, seed=3) -> np.ndarray:
    """A linear test frame: a dark textured half and a bright textured half."""
    rng = np.random.default_rng(seed)
    base = np.where(np.arange(w)[None, :] < w // 2, 0.01, 0.6).astype(np.float32)
    tex = 1.0 + 0.35 * rng.standard_normal((h, w)).astype(np.float32).clip(-2, 2)
    y = base * np.ones((h, 1), np.float32) * tex
    return np.repeat(y[..., None], 3, axis=-1).astype(np.float32)


def _render(lin, adj, **kw) -> np.ndarray:
    return np.asarray(thumbnails.apply_adjustments_linear(lin.copy(), 1.0, adj, **kw)).astype(np.float32)


# ---- compatibility ----------------------------------------------------------

def test_an_edit_without_the_key_is_on_the_original_process():
    assert develop.normalize({"shadows": 40})["process"] == "1"
    assert develop.loads('{"saturation": 30}')["process"] == "1"


def test_the_process_alone_never_makes_a_photo_edited():
    assert develop.is_neutral({"process": "2"})
    assert develop.dumps({"process": "2"}) is None
    assert not develop.is_neutral({"process": "2", "shadows": 10})


def test_a_neutral_edit_renders_the_same_on_both():
    lin = _scene()
    assert np.array_equal(_render(lin, _v({}, "1")), _render(lin, _v({}, "2")))


def test_controls_the_new_process_leaves_alone_render_the_same():
    lin = _scene()
    adj = {"exposure": 1.0, "contrast": 30, "whites": -40, "blacks": 20, "clarity": 30,
           "temperature": 20, "vignette_amount": -30}
    assert np.array_equal(_render(lin, _v(adj, "1")), _render(lin, _v(adj, "2")))


# ---- Oklab colour -----------------------------------------------------------

def test_oklab_round_trips():
    rng = np.random.default_rng(1)
    lin = rng.random((32, 32, 3)).astype(np.float32)
    back = develop_v2.oklab_to_linear(develop_v2.linear_to_oklab(lin))
    assert np.abs(back - lin).max() < 2e-4


def _hue_and_light(srgb: np.ndarray):
    lab = develop_v2.linear_to_oklab(develop_v2._srgb_to_linear(srgb.astype(np.float32)))
    return np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360.0, lab[..., 0]


def test_saturation_keeps_hue_and_lightness():
    """A sky blue pushed hard: on the original process it drifts toward purple
    and changes brightness; here both stay where they were."""
    sky = np.full((8, 8, 3), (0.35, 0.55, 0.85), np.float32)
    h0, l0 = _hue_and_light(sky)
    out2 = thumbnails._display_color_block(sky.copy(), _v({"saturation": 80}, "2"))
    h2, l2 = _hue_and_light(out2)
    assert abs(float(h2.mean() - h0.mean())) < 2.0
    assert abs(float(l2.mean() - l0.mean())) < 0.02
    out1 = thumbnails._display_color_block(sky.copy(), _v({"saturation": 80}, "1"))
    h1, _ = _hue_and_light(out1)
    assert abs(float(h1.mean() - h0.mean())) > abs(float(h2.mean() - h0.mean()))


def test_full_desaturation_is_grey():
    rng = np.random.default_rng(2)
    arr = rng.random((16, 16, 3)).astype(np.float32)
    out = thumbnails._display_color_block(arr, _v({"saturation": -100}, "2"))
    assert np.abs(out - out.mean(axis=-1, keepdims=True)).max() < 2e-3


def test_an_out_of_gamut_push_keeps_its_hue():
    red = np.full((4, 4, 3), (0.85, 0.2, 0.15), np.float32)
    h0, _ = _hue_and_light(red)
    out = thumbnails._display_color_block(red.copy(), _v({"saturation": 200}, "2"))
    h1, _ = _hue_and_light(out)
    assert out.min() >= 0.0 and out.max() <= 1.0
    assert abs(float(h1.mean() - h0.mean())) < 6.0


def test_the_mixer_moves_its_own_band_and_leaves_the_others():
    blue = np.full((4, 4, 3), (0.0, 0.0, 0.8), np.float32)  # the band's own hue
    green = np.full((4, 4, 3), (0.25, 0.6, 0.25), np.float32)
    hsl = {b: [0, 0, 0] for b in develop.COLOR_BANDS}
    hsl["blue"] = [0, -100, 0]
    adj = _v({"hsl": hsl}, "2")
    out_blue = thumbnails._display_color_block(blue.copy(), adj)
    out_green = thumbnails._display_color_block(green.copy(), adj)
    assert np.ptp(out_blue[0, 0]) < 0.03  # the blue went grey
    assert np.abs(out_green - green).max() < 0.01


def test_vibrance_pushes_muted_colours_more_than_vivid_ones():
    muted = np.full((4, 4, 3), (0.45, 0.5, 0.55), np.float32)
    vivid = np.full((4, 4, 3), (0.1, 0.3, 0.9), np.float32)
    adj = _v({"vibrance": 100}, "2")

    def chroma(a):
        lab = develop_v2.linear_to_oklab(develop_v2._srgb_to_linear(a))
        return float(np.hypot(lab[..., 1], lab[..., 2]).mean())

    gain_muted = chroma(thumbnails._display_color_block(muted.copy(), adj)) / chroma(muted)
    gain_vivid = chroma(thumbnails._display_color_block(vivid.copy(), adj)) / chroma(vivid)
    assert gain_muted > gain_vivid >= 1.0


def test_grading_tints_the_shadows_and_not_the_highlights():
    ramp = np.repeat(np.linspace(0.05, 0.95, 64, dtype=np.float32)[None, :, None], 3, axis=-1)
    ramp = np.repeat(ramp, 4, axis=0)
    grading = develop.defaults()["color_grading"]
    grading["shadows"] = {"hue": 240, "saturation": 80, "luminance": 0}
    out = thumbnails._display_color_block(ramp.copy(), _v({"color_grading": grading}, "2"))
    dark, bright = out[0, 8], out[0, 60]
    assert dark[2] > dark[0] + 0.02  # blue in the shadows
    assert np.ptp(bright) < 0.01  # highlights untouched


# ---- local Highlights / Shadows ---------------------------------------------

def test_shadows_on_a_flat_area_match_the_plain_curve():
    lin = np.full((64, 64, 3), 0.02, np.float32)
    adj = {"exposure": 1.0, "shadows": 80}
    a = _render(lin, _v(adj, "1"))
    b = _render(lin, _v(adj, "2"))
    assert np.abs(a - b).max() <= 1.0


def test_lifted_shadows_keep_their_texture():
    lin = _scene()
    adj = {"exposure": 2.0, "shadows": 100}
    dark = (slice(40, 200), slice(30, 130))  # inside the dark half
    v1 = _render(lin, _v(adj, "1"))[dark].mean(axis=-1)
    v2 = _render(lin, _v(adj, "2"))[dark].mean(axis=-1)
    # Same overall lift, more contrast left inside it.
    assert abs(v1.mean() - v2.mean()) < 0.12 * v1.mean()
    assert v2.std() > 1.15 * v1.std()


def test_the_local_curve_never_inverts_the_scene():
    """Brighter surroundings must not come out darker than dark ones."""
    lin = _scene()
    out = _render(lin, _v({"exposure": 2.0, "shadows": 200, "highlights": -200}, "2")).mean(axis=-1)
    assert out[:, 200:].mean() > out[:, :120].mean()


def test_a_tile_renders_like_the_frame_it_stands_in_for():
    rng = np.random.default_rng(5)
    h, w = 700, 1000
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lum = 0.02 + 0.5 * (np.sin(xx / 90.0) * np.cos(yy / 70.0) * 0.5 + 0.5) ** 3
    lum *= 1.0 + 0.1 * rng.standard_normal((h, w)).astype(np.float32)
    lin = np.repeat(np.clip(lum, 0.001, None)[..., None], 3, axis=-1).astype(np.float32)
    adj = _v({"exposure": 1.5, "shadows": 80, "highlights": -80}, "2")
    whole = _render(lin, adj)
    pad = thumbnails.REGION_PAD_PX
    x0, y0, x1, y1 = 300, 200, 700, 500
    view = masks.FieldView(x0 - pad, y0 - pad, w, h)
    tile = _render(lin[y0 - pad:y1 + pad, x0 - pad:x1 + pad], adj, view=view)[pad:-pad, pad:-pad]
    assert np.abs(tile - whole[y0:y1, x0:x1]).mean() < 0.6


# ---- sharpening --------------------------------------------------------------

def test_sharpening_draws_no_halo_and_adds_no_colour():
    arr = np.empty((32, 64, 3), np.float32)
    arr[:, :32] = (0.30, 0.25, 0.20)
    arr[:, 32:] = (0.70, 0.60, 0.50)
    out = develop_v2.sharpen(arr.copy(), 1.2, 1.2)
    y = out @ thumbnails._LUMA
    y0 = arr @ thumbnails._LUMA
    step = float(y0.max() - y0.min())
    assert y.max() <= y0.max() + 0.2 * step and y.min() >= y0.min() - 0.2 * step
    # Channel ratios (the colour) survive.
    assert np.abs(out[..., 0] / out[..., 2] - arr[..., 0] / arr[..., 2]).max() < 1e-3
    # ... while the plain unsharp mask overshoots far more.
    y1 = thumbnails._unsharp(arr.copy(), 1.2, 1.2) @ thumbnails._LUMA
    assert (y1.max() - y0.max()) > 2.0 * (y.max() - y0.max())


# ---- masks under the shoulder -------------------------------------------------

def _all_mask(adjustments: dict) -> dict:
    return {
        "id": "m1", "name": "all", "visible": True, "opacity": 100, "invert": False,
        "sub_masks": [{"id": "s", "type": "all", "mode": "additive", "visible": True,
                       "invert": False, "parameters": {}}],
        "adjustments": adjustments,
    }


def test_the_shoulder_inverts_exactly():
    y = np.linspace(0.0, 4.0, 200, dtype=np.float32)
    from app.services import raw as raw_service

    d = y * raw_service.reinhard_ratio(y, 4.0)
    back = d * develop_v2.inverse_shoulder_ratio(d, 4.0)
    assert np.abs(back - y).max() < 2e-3


def test_darkening_a_mask_brings_highlight_detail_back():
    """Exposure pushed globally, a mask pulled down over the bright part: on
    the new process the highlights separate again."""
    ramp = np.linspace(0.3, 1.0, 256, dtype=np.float32)
    lin = np.repeat(np.repeat(ramp[None, :, None], 3, axis=-1), 8, axis=0)
    spread = {}
    for process in ("1", "2"):
        adj = _v({"exposure": 2.0, "masks": [_all_mask({"exposure": -2.0})]}, process)
        out = _render(lin, adj).mean(axis=-1)[0]
        spread[process] = float(out[-1] - out[128])
    assert spread["2"] > 1.3 * spread["1"]


def test_a_mask_follows_its_edits_process():
    arr = np.full((8, 8, 3), (0.35, 0.55, 0.85), np.float32)
    outs = {}
    for process in ("1", "2"):
        adj = _v({"masks": [_all_mask({"saturation": 80})]}, process)
        outs[process], _ = thumbnails.apply_masks(arr.copy(), adj)
    direct = thumbnails._display_color_block(arr.copy(), _v({"saturation": 80}, "2"))
    assert np.abs(outs["2"] - direct).max() < 2e-3
    assert np.abs(outs["1"] - outs["2"]).max() > 0.01


def test_a_big_frame_in_bands_is_the_same_picture(monkeypatch):
    rng = np.random.default_rng(7)
    arr = rng.random((60, 80, 3)).astype(np.float32)
    adj = _v({"saturation": 50, "vibrance": 30, "hue": 12}, "2")
    whole = develop_v2.apply_perceptual_color(arr.copy(), adj)
    monkeypatch.setattr(develop_v2, "_BAND_PIXELS", 500)
    assert np.array_equal(develop_v2.apply_perceptual_color(arr.copy(), adj), whole)
