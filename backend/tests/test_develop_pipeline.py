"""Invariants of the scene-referred develop pipeline (linear tone block, tone
ratio, Reinhard shoulder). Synthetic arrays only - no RAW decode, no fixtures.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import io

import numpy as np
from PIL import Image as PILImage
import pytest

from app.services import develop, thumbnails
from app.services import raw as raw_service


def _rng(seed: int = 0) -> np.random.Generator:
    return np.random.default_rng(seed)


def _srgb_image(shape=(24, 24, 3), seed=0) -> np.ndarray:
    return _rng(seed).random(shape).astype(np.float32)


def kitchen_sink_adjustments() -> dict:
    """Every scalar slider at an extreme, both curve systems active."""
    adj = develop.defaults()
    for key, (default, lo, hi, _is_float) in develop.SCALAR_SPEC.items():
        adj[key] = hi if (hash(key) % 2 == 0) else lo
    adj["point_curves"]["luma"] = [[0, 20], [128, 110], [255, 240]]
    adj["hsl"]["red"] = [40, -30, 25]
    adj["color_grading"]["shadows"] = {"hue": 220, "saturation": 60, "luminance": -20}
    adj["color_calibration"]["red_hue"] = 50
    return develop.normalize(adj)


# --- neutral identity ---------------------------------------------------------

def test_neutral_display_identity():
    arr = _srgb_image()
    out = thumbnails._adjust_array(arr.copy(), develop.defaults())
    assert np.abs(out - arr).max() < 2e-3


def test_neutral_linear_identity_gain_one():
    """With gain 1 the Reinhard white point is 1 -> exact pass-through for
    in-range values (the neutral-JPEG anchor)."""
    arr = _srgb_image(seed=1)
    lin = thumbnails._srgb_to_linear(arr)
    out = thumbnails._linear_tone_block(lin, develop.defaults(), base_gain=1.0)
    assert np.abs(out - arr).max() < 1e-5


def test_neutral_raw_matches_old_auto_expose():
    """default_tone_to_srgb / the tone block with base_gain must reproduce the
    old baked _auto_expose math (Reinhard-extended at L=y*g, W=g) exactly -
    the compatibility anchor for unedited RAWs."""
    lin = (_rng(2).random((32, 32, 3)) * 0.25).astype(np.float32)
    for gain in (2.0, 4.0, 8.0):
        # Old math, re-implemented verbatim from the removed _auto_expose.
        y = lin @ thumbnails._LUMA
        yg = y * gain
        y_out = yg * (1.0 + y / gain) / (1.0 + yg)
        ratio = np.where(y > 1e-6, y_out / np.maximum(y, 1e-6), gain)
        expected = thumbnails._linear_to_srgb(np.clip(lin * ratio[..., None], 0.0, 1.0))

        got_uint8 = raw_service.default_tone_to_srgb(lin, gain)
        expected_uint8 = np.clip(expected * 255.0 + 0.5, 0, 255).astype(np.uint8)
        assert np.abs(got_uint8.astype(int) - expected_uint8.astype(int)).max() <= 1

        got_block = thumbnails._linear_tone_block(lin, develop.defaults(), base_gain=gain)
        assert np.abs(got_block - expected.astype(np.float32)).max() < 1e-4


# --- tone controls ------------------------------------------------------------

def test_highlight_recovery_reaches_scene_headroom():
    """A pixel above display white (scene-referred Y=1.6) must be pulled down
    meaningfully by highlights=-100 - impossible in the old additive pipeline
    whose highlight mask was exactly 0 at white."""
    adj = develop.defaults()
    adj["highlights"] = -100
    lin = np.full((4, 4, 3), 1.6, dtype=np.float32)
    neutral = thumbnails._linear_tone_block(lin, develop.defaults(), base_gain=4.0)
    recovered = thumbnails._linear_tone_block(lin, adj, base_gain=4.0)
    assert neutral.min() > 0.97  # renders as (near) white without the edit
    assert recovered.max() < 0.87  # decisively darker
    assert float(neutral.min() - recovered.max()) > 0.1

    # Highlights and whites compose: together they pull the same pixel well
    # into textured-highlight range.
    adj["whites"] = -100
    both = thumbnails._linear_tone_block(lin, adj, base_gain=4.0)
    assert both.max() < 0.75


@pytest.mark.parametrize(
    "sliders",
    [
        {"whites": -100},
        {"blacks": -100},
        {"whites": -100, "highlights": -100, "blacks": -100, "shadows": 100, "contrast": 100},
        {"whites": 100, "highlights": 100, "blacks": 100, "shadows": -100, "contrast": -100},
    ],
)
def test_full_block_monotone(sliders):
    """End-to-end monotonicity through ALL stages (region shifts, contrast,
    brightness, white/black endpoint moves, tonemap, encode) on a grey ramp."""
    adj = develop.defaults()
    adj.update(sliders)
    y = np.logspace(-6, 3, 512, base=2.0).astype(np.float32)
    ramp = np.repeat(y[None, :, None], 3, axis=2)  # 1 x N x 3 grey ramp
    out = thumbnails._linear_tone_block(ramp, adj, base_gain=4.0)
    assert np.all(np.diff(out[0, :, 0]) >= -1e-6)


def test_whites_blacks_reach_the_endpoints():
    """whites=-100 must darken a pixel AT the white point; blacks=-100 must
    crush a deep shadow to (near) black - endpoint moves, not just region
    nudges."""
    wh = develop.defaults()
    wh["whites"] = -100
    # Scene value 1.0 lands exactly on the white point after the gain (Y = g).
    white_px = np.full((2, 2, 3), 1.0, dtype=np.float32)
    neutral = thumbnails._linear_tone_block(white_px, develop.defaults(), base_gain=4.0)
    pulled = thumbnails._linear_tone_block(white_px, wh, base_gain=4.0)
    assert neutral.min() > 0.995
    assert pulled.max() < 0.9

    blk = develop.defaults()
    blk["blacks"] = -100
    dark_px = np.full((2, 2, 3), 0.008, dtype=np.float32)  # deep shadow at gain 4
    neutral_d = thumbnails._linear_tone_block(dark_px, develop.defaults(), base_gain=4.0)
    crushed = thumbnails._linear_tone_block(dark_px, blk, base_gain=4.0)
    assert neutral_d.max() > 0.1  # visible dark grey without the edit
    assert crushed.max() < 0.02  # essentially true black with it


def test_shadow_lift_preserves_chroma():
    """The tone ratio is shared across RGB, so channel ratios (hue/sat) survive
    a strong shadows lift - the old additive lift washed colours toward grey."""
    adj = develop.defaults()
    adj["shadows"] = 80
    pixel = np.array([[[0.06, 0.02, 0.01]]], dtype=np.float32)  # dark saturated red
    out_lin_in = pixel / pixel[0, 0, 0]
    lifted = thumbnails._linear_tone_block(pixel, adj, base_gain=1.0)
    lifted_lin = thumbnails._srgb_to_linear(lifted)
    out_ratio = lifted_lin / lifted_lin[0, 0, 0]
    assert np.abs(out_ratio - out_lin_in).max() < 1e-3
    # And it actually lifts.
    neutral = thumbnails._linear_tone_block(pixel, develop.defaults(), base_gain=1.0)
    assert lifted.mean() > neutral.mean()


@pytest.mark.parametrize(
    "sliders",
    [
        {"shadows": 100, "blacks": 100},
        {"shadows": -100, "blacks": -100},
        {"highlights": 100, "whites": 100},
        {"highlights": -100, "whites": -100},
        {"contrast": 100},
        {"contrast": -100},
        {"brightness": 200},
        {"brightness": -200},
        {"shadows": -100, "blacks": 100, "highlights": 100, "whites": -100,
         "contrast": -100, "brightness": 200},
        {"shadows": 100, "blacks": -100, "highlights": -100, "whites": 100,
         "contrast": 100, "brightness": -200},
    ],
)
def test_tone_ratio_monotone(sliders):
    """The combined tone curve must stay monotone in luminance at every slider
    extreme, or gradients band/solarise."""
    adj = develop.defaults()
    adj.update(sliders)
    y = np.logspace(-5, 3, 4000, base=2.0).astype(np.float32)  # ~0.03..8.0
    ratio = thumbnails._tone_ratio(y, adj)
    assert ratio is not None
    y_out = y * ratio
    assert np.all(np.diff(y_out) > 0.0)


def test_tone_ratio_neutral_is_none():
    assert thumbnails._tone_ratio(np.array([0.5], dtype=np.float32), develop.defaults()) is None


@pytest.mark.parametrize(
    "sliders",
    [
        {"whites": -200},
        {"blacks": -200},
        {"whites": -200, "highlights": -200, "blacks": -200, "shadows": 200, "contrast": 100},
        {"whites": 200, "highlights": 200, "blacks": 200, "shadows": -200, "contrast": -100},
        {"shadows": -200, "blacks": 200, "highlights": 200, "whites": -200,
         "contrast": -100, "brightness": 200},
        {"shadows": 200, "blacks": -200, "highlights": -200, "whites": 200,
         "contrast": 100, "brightness": -200},
        {"exposure": 8.0, "whites": 200, "highlights": 200},
        {"exposure": -8.0, "shadows": 200, "blacks": -200},
    ],
)
def test_extended_slider_travel_stays_monotone(sliders):
    """Beyond +-100 the hand-tuned region constants alone no longer guarantee
    monotonicity - the isotonic guard in _tone_ratio must keep the curve from
    folding back (it may plateau). Tolerance is float32 interpolation noise
    (single-ULP), far below anything the 8-bit encode can show."""
    adj = develop.defaults()
    adj.update(sliders)
    y = np.logspace(-5, 3, 4000, base=2.0).astype(np.float32)
    ratio = thumbnails._tone_ratio(y, adj)
    assert ratio is not None
    assert not np.isnan(ratio).any()
    y_out = y * ratio
    assert np.all(np.diff(y_out) >= -1e-6)

    ramp = np.repeat(np.logspace(-6, 3, 512, base=2.0).astype(np.float32)[None, :, None], 3, axis=2)
    out = thumbnails._linear_tone_block(ramp, adj, base_gain=4.0)
    assert not np.isnan(out).any()
    assert np.all(np.diff(out[0, :, 0]) >= -1e-6)


def test_guard_does_not_touch_classic_range():
    """Within the classic +-100 travel the guard must never engage - existing
    edits have to render bit-identically to the ungated curve."""
    adj = develop.defaults()
    adj.update({"whites": -100, "highlights": -100, "blacks": -100, "shadows": 100,
                "contrast": 100, "brightness": 200})
    y = np.logspace(-5, 3, 4000, base=2.0).astype(np.float32)
    ratio = thumbnails._tone_ratio(y, adj)
    y0 = np.maximum(y, 1e-6).astype(np.float32)
    direct = thumbnails._tone_curve_y(y0, -1.0, 1.0, -1.0, -1.0, 1.0, 2.0)
    assert np.array_equal(ratio, (direct / y0).astype(np.float32))


# --- tonemap ------------------------------------------------------------------

def test_reinhard_endpoints_and_monotonicity():
    for w in (1.0, 2.0, 8.0):
        y = np.linspace(0.0, w, 2000, dtype=np.float32)
        out = y * raw_service.reinhard_ratio(y, w)
        assert out[0] == 0.0
        assert abs(float(out[-1]) - 1.0) < 1e-5  # W maps to 1
        assert np.all(np.diff(out) >= 0.0)


def test_agx_accepts_scene_referred_input():
    lin = np.array([[[0.0, 0.0, 0.0], [8.0, 8.0, 8.0], [1.6, 0.4, 0.1]]], dtype=np.float32)
    adj = develop.defaults()
    adj["tone_mapper"] = "agx"
    out = thumbnails._linear_tone_block(lin, adj, base_gain=4.0)
    assert np.isfinite(out).all()
    assert out.min() >= 0.0 and out.max() <= 1.0


# --- robustness ---------------------------------------------------------------

@pytest.mark.parametrize("tone_mapper", ["basic", "agx"])
def test_no_nan_kitchen_sink(tone_mapper):
    adj = kitchen_sink_adjustments()
    adj["tone_mapper"] = tone_mapper
    for lin in (
        np.zeros((8, 8, 3), dtype=np.float32),
        np.full((8, 8, 3), 8.0, dtype=np.float32),
        (_rng(3).random((8, 8, 3)) * 4.0).astype(np.float32),
        np.zeros((1, 1, 3), dtype=np.float32),
    ):
        out = thumbnails._display_color_block(
            thumbnails._linear_tone_block(lin, adj, base_gain=8.0), adj
        )
        assert np.isfinite(out).all()
        assert out.min() >= 0.0 and out.max() <= 1.0


def test_masked_all_equals_global_exposure():
    """An 'all'-type mask at opacity 100 with exposure +1 must match the same
    global adjustment (the mask path routes through the display wrapper)."""
    from PIL import Image as PILImage

    base = (np.full((16, 16, 3), 0.3) * 255).astype(np.uint8)
    img = PILImage.fromarray(base, "RGB")

    global_adj = develop.defaults()
    global_adj["exposure"] = 1.0
    out_global = np.asarray(thumbnails.apply_adjustments(img, global_adj))

    masked_adj = develop.defaults()
    masked_adj["masks"] = [
        {
            "id": "m1",
            "name": "Mask",
            "visible": True,
            "opacity": 100,
            "invert": False,
            "sub_masks": [
                {"id": "s1", "type": "all", "mode": "additive", "visible": True,
                 "invert": False, "parameters": {}}
            ],
            "adjustments": {"exposure": 1.0},
        }
    ]
    masked_adj = develop.normalize(masked_adj)
    out_masked = np.asarray(thumbnails.apply_adjustments(img, masked_adj))

    assert np.abs(out_global.astype(int) - out_masked.astype(int)).max() <= 2


def test_neutral_jpeg_passthrough_uint8():
    """apply_adjustments with fully-neutral adjustments returns the input image
    object untouched (the is_neutral fast path)."""
    from PIL import Image as PILImage

    base = (_rng(4).random((16, 16, 3)) * 255).astype(np.uint8)
    img = PILImage.fromarray(base, "RGB")
    out = thumbnails.apply_adjustments(img, develop.defaults())
    assert out is img


# --- a mask limited to an area ------------------------------------------------

def test_sharpening_stays_inside_a_mask_and_inside_its_limit():
    """Two claims at once, on the mask type that makes both matter. An edge mask
    selects every edge in the FRAME, so sharpening through it lands all over the
    picture - correctly, but rarely what was meant. Intersecting it with a shape
    ("limit to area", the editor's second sub-mask) confines it, and nothing
    outside the combined field may move by a single bit."""
    rng = _rng(7)
    h, w = 200, 400
    # Left half finely textured (edges everywhere), right half smooth.
    arr = np.full((h, w, 3), 0.5, dtype=np.float32)
    arr[:, :w // 2:6] = 0.8
    arr[:, w // 2:] = np.linspace(0.35, 0.65, w - w // 2, dtype=np.float32)[None, :, None]
    arr = np.clip(arr + 0.01 * rng.standard_normal(arr.shape), 0, 1).astype(np.float32)

    edge_sub = {"id": "s0", "type": "edge", "mode": "additive", "visible": True, "invert": False,
                "parameters": {"threshold": 25, "spread": 30, "feather": 50}}
    limit_sub = {"id": "s1", "type": "radial", "mode": "intersect", "visible": True, "invert": False,
                 "parameters": {"center_x": 0.15, "center_y": 0.5, "radius_x": 0.1, "radius_y": 0.4,
                                "feather": 20}}

    def render(subs):
        adj = develop.normalize({**develop.defaults(), "masks": [{
            "id": "m", "name": "E", "visible": True, "opacity": 100, "invert": False,
            "sub_masks": subs, "adjustments": {"sharpness": 100}}]})
        out, _ = thumbnails.apply_masks(arr.copy(), adj)
        return np.abs(out - arr).max(axis=-1)

    # Unlimited: sharpening lands across the whole textured half...
    unlimited = render([edge_sub])
    assert (unlimited[:, : w // 2] > 1e-4).mean() > 0.3
    # ...and never on the smooth half, which the mask does not select.
    assert unlimited[:, w // 2 + 20 :].max() == 0.0

    # Limited to a shape on the far left: the textured area outside it is left
    # alone, the part inside it is still sharpened.
    limited = render([edge_sub, limit_sub])
    assert limited[:, int(0.30 * w) :].max() == 0.0
    assert (limited[:, : int(0.20 * w)] > 1e-4).mean() > 0.3


def test_peek_marks_the_intersection_not_the_whole_selection():
    """With a limit in play the marking has to show what the mask actually
    covers - otherwise it would promise an edit everywhere the selection reaches
    and deliver it only inside the shape."""
    arr = _dark_left_half()
    subs = [
        {"id": "s0", "type": "luminance", "mode": "additive", "visible": True, "invert": False,
         "parameters": {"range_min": 0, "range_max": 50, "feather": 0}},
        {"id": "s1", "type": "radial", "mode": "intersect", "visible": True, "invert": False,
         "parameters": {"center_x": 0.2, "center_y": 0.2, "radius_x": 0.15, "radius_y": 0.15,
                        "feather": 10}},
    ]
    adj = develop.normalize({**develop.defaults(), "masks": [{
        "id": "m1", "name": "S", "visible": True, "opacity": 100, "invert": False,
        "sub_masks": subs, "adjustments": {}}]})
    _, field = thumbnails.apply_masks(arr.copy(), adj, peek="m1")
    assert field[3, 3] > 0.9            # dark half AND inside the shape
    assert field[14, 3] < 0.05          # dark half, outside the shape
    assert field[:, 8:].max() < 0.05    # bright half, never selected either way


# --- marking what a mask covers ("peek") --------------------------------------

def _lum_mask(mask_id="m1", visible=True, adjustments=None) -> dict:
    return {
        "id": mask_id,
        "name": "Shadows",
        "visible": visible,
        "opacity": 100,
        "invert": False,
        "sub_masks": [
            {"id": "s1", "type": "luminance", "mode": "additive", "visible": True,
             "invert": False, "parameters": {"range_min": 0, "range_max": 50, "feather": 0}},
        ],
        "adjustments": adjustments or {},
    }


def _dark_left_half() -> np.ndarray:
    arr = np.full((16, 16, 3), 0.9, dtype=np.float32)
    arr[:, :8] = 0.05
    return arr


def test_peek_returns_the_field_of_a_mask_that_renders_nothing():
    """A mask being set up has no adjustment on it yet - which is exactly when
    you need to see what it covers, so the field must be produced even though
    the mask changes no pixels."""
    adj = develop.normalize({**develop.defaults(), "masks": [_lum_mask()]})
    arr = _dark_left_half()
    out, field = thumbnails.apply_masks(arr.copy(), adj, peek="m1")
    assert np.array_equal(out, arr)  # nothing to apply, so nothing changed
    assert field is not None
    assert field[:, :8].mean() > 0.95 and field[:, 8:].mean() < 0.05


def test_peek_is_the_selection_the_render_used_not_one_read_back_off_it():
    """The mask's own Exposure moves the very tones a luminance mask selects on.
    The marking has to be the field the render applied - taken before the mask's
    adjustment - or lifting the shadows would appear to shrink the selection."""
    adj = develop.normalize({**develop.defaults(), "masks": [_lum_mask(adjustments={"exposure": 2.0})]})
    arr = _dark_left_half()
    out, field = thumbnails.apply_masks(arr.copy(), adj, peek="m1")
    assert out[:, :8].mean() > arr[:, :8].mean() + 0.05  # the adjustment did land
    assert field[:, :8].mean() > 0.95                    # and the marking still covers it


def test_peek_names_one_mask_and_nothing_else_is_marked():
    masks_ = [_lum_mask("m1"), _lum_mask("m2")]
    adj = develop.normalize({**develop.defaults(), "masks": masks_})
    _, none = thumbnails.apply_masks(_dark_left_half(), adj)
    assert none is None
    _, one = thumbnails.apply_masks(_dark_left_half(), adj, peek="m2")
    assert one is not None


def test_peek_paint_marks_only_inside_the_field_and_stripes():
    """Candy-stripes, not a wash: the picture has to stay visible between the
    bars, and nothing outside the mask may be touched at all."""
    arr = np.full((64, 64, 3), 0.5, dtype=np.float32)
    field = np.zeros((64, 64), dtype=np.float32)
    field[:, :32] = 1.0
    out = thumbnails.paint_mask_peek(arr, field)
    assert np.array_equal(out[:, 32:], arr[:, 32:])
    marked = np.abs(out[:, :32] - arr[:, :32]).max(axis=-1)
    assert marked.min() > 0.0 and marked.max() > 0.2  # bars and gaps, both pink
    assert marked.std() > 0.05  # ...at visibly different strengths - it's striped


def test_peek_survives_the_preview_tier_plumbing(tmp_path, monkeypatch):
    """The marking is asked for on the render request, so it has to reach the
    pipeline through every tier the editor uses - a scrub frame during a drag,
    the accurate one on release. Half the frame is dark, and the mask selects
    exactly that half."""
    from PIL import Image as PILImage

    from app.services import filesystem

    src = tmp_path / "peek.png"
    arr = np.full((200, 400, 3), 230, dtype=np.uint8)
    arr[:, :200] = 10
    PILImage.fromarray(arr).save(src)

    class _FakeImage:
        id = "peek-tiers"

    monkeypatch.setattr(filesystem, "resolve_image_path", lambda image: src)
    thumbnails._cached_editor_base.cache_clear()
    adj = develop.normalize({**develop.defaults(), "masks": [_lum_mask()]})

    def rendered(**tier):
        data = thumbnails.render_editor_preview_bytes(
            _FakeImage(), 0, None, adj, **tier
        )
        return np.asarray(PILImage.open(io.BytesIO(data)).convert("RGB"), dtype=np.int16)

    for tier in ({"scrub": True}, {}):
        clean = rendered(**tier)
        marked = rendered(**tier, peek="m1")
        w = clean.shape[1]
        # Pink over the dark half only; the bright half comes back untouched.
        assert np.abs(marked[:, : w // 2 - 8] - clean[:, : w // 2 - 8]).mean() > 8
        assert np.abs(marked[:, w // 2 + 8 :] - clean[:, w // 2 + 8 :]).mean() < 2


# --- the frame a mask lives in ------------------------------------------------

def test_framed_base_applies_geometry_but_not_the_develop_settings(tmp_path, monkeypatch):
    """Semantic masks are found on render_framed_base_image and then stored in
    the *framed* image's coordinates, like every other mask. So it has to carry
    the geometry (or the found region wouldn't line up with what the user sees)
    and must not carry the tonal edits (whether something is sky doesn't depend
    on the exposure slider, and a pushed frame only confuses the model)."""
    from PIL import Image as PILImage

    from app.services import filesystem

    src = tmp_path / "frame.png"
    # A distinctive corner marker, to tell which part of the frame survives.
    arr = np.zeros((200, 400, 3), dtype=np.uint8)
    arr[:, :] = 40
    arr[:20, :20] = 255  # top-left
    PILImage.fromarray(arr).save(src)

    class _FakeImage:
        id = "framed-base"

    monkeypatch.setattr(filesystem, "resolve_image_path", lambda image: src)
    thumbnails._cached_editor_base.cache_clear()

    plain = thumbnails.render_framed_base_image(_FakeImage(), rotation=0, crop=None)
    assert plain.size == (400, 200)
    assert np.asarray(plain)[5, 5].min() > 200  # the marker is still top-left

    # 90 degrees swaps the axes and takes the marker with it; a crop of the
    # right half then leaves it behind entirely.
    turned = thumbnails.render_framed_base_image(_FakeImage(), rotation=90, crop=None)
    assert turned.size == (200, 400)
    cropped = thumbnails.render_framed_base_image(
        _FakeImage(), rotation=0, crop=(0.5, 0.0, 0.5, 1.0)
    )
    assert cropped.size == (200, 200)
    assert np.asarray(cropped).max() < 200


# --- The editor preview's tone/denoise stage cache ---------------------------
# Reusing the stage across renders that differ only below it is a pure speed
# optimisation, so the only thing worth testing is that it stays invisible.


def _editor_render(lin, adj, *, fast=False, key=None) -> np.ndarray:
    thumbnails.invalidate_tone_stage()
    if key is not None:  # populate, then render again off the warm cache
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, fast=fast, tone_cache_key=key)
    return np.asarray(
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, fast=fast, tone_cache_key=key)
    )


@pytest.mark.parametrize("fast", [False, True])
@pytest.mark.parametrize(
    "edit",
    [
        {},                                                  # neutral: never cached
        {"clarity": 60},
        {"clarity": -70},                                    # pulls in the mist pass
        {"luma_noise_reduction": 55},
        {"luma_noise_reduction": 55, "clarity": -40},                     # the pairing this exists for
        {"exposure": 0.8, "contrast": 30, "highlights": -40, "blacks": 15},
        {"tone_mapper": "agx", "exposure": 0.5, "luma_noise_reduction": 40},
        {"structure": 40, "sharpness": 50, "dehaze": 35, "color_noise_reduction": 20},
        {"saturation": 30, "hue": 12, "mist": 20, "grain_amount": 30, "luma_noise_reduction": 25},
    ],
)
def test_tone_stage_cache_is_bit_identical(fast, edit):
    """A warm cache must produce exactly the bytes the uncached pipeline does."""
    lin = _rng(7).random((80, 120, 3)).astype(np.float32) * 1.4
    adj = develop.defaults() | edit
    assert np.array_equal(
        _editor_render(lin, adj, fast=fast, key=None),
        _editor_render(lin, adj, fast=fast, key="base"),
    )


def test_tone_stage_cache_key_splits_at_the_denoise_cut():
    """Adjustments below the cut reuse the stage; everything else recomputes it.
    A key missing from _POST_DENOISE_KEYS would silently serve a stale stage,
    so every field the pipeline has is checked, not a hand-picked few."""
    lin = _rng(3).random((40, 60, 3)).astype(np.float32)
    base = develop.defaults() | {"luma_noise_reduction": 50, "clarity": 20}

    def stage_key(adj) -> str:
        thumbnails.invalidate_tone_stage()
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="base")
        return next(iter(thumbnails._tone_stage))

    reference = stage_key(base)
    assert stage_key(base | {"clarity": -80}) == reference       # below the cut
    assert stage_key(base | {"grain_amount": 40}) == reference
    assert stage_key(base | {"luma_noise_reduction": 10}) != reference  # the cut itself
    assert stage_key(base | {"exposure": 1.0}) != reference      # above it

    probes = {"tone_mapper": "agx", "film_sim": "provia", "curve_mode": "parametric"}
    stale = [
        key for key in develop.defaults()
        if key not in thumbnails._POST_DENOISE_KEYS
        and stage_key(base | {key: probes.get(key, 7)}) == reference
    ]
    assert not stale, f"changing these leaves a stale cached stage: {stale}"


def test_tone_stage_cache_is_opt_in():
    """Only the editor preview passes a key. Exports and thumbnails render each
    frame once, so caching a stage for them would be pure memory."""
    lin = _rng(1).random((40, 60, 3)).astype(np.float32)
    thumbnails.invalidate_tone_stage()
    thumbnails.apply_adjustments_linear(lin, 1.0, develop.defaults() | {"luma_noise_reduction": 30})
    assert not thumbnails._tone_stage


def test_tone_stage_cache_refuses_oversized_frames():
    """The native 100%-zoom stage is ~480MB a copy - too much of the process to
    hold for a second of denoise, so it renders uncached like it always did."""
    lin = _rng(1).random((40, 60, 3)).astype(np.float32)
    thumbnails.invalidate_tone_stage()
    adj = develop.defaults() | {"luma_noise_reduction": 30}
    monkey = thumbnails._TONE_STAGE_MAX_BYTES
    try:
        thumbnails._TONE_STAGE_MAX_BYTES = 1
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="base")
        assert not thumbnails._tone_stage
    finally:
        thumbnails._TONE_STAGE_MAX_BYTES = monkey


@pytest.mark.parametrize(
    "edit",
    [
        {"exposure": 0.6, "contrast": 30, "highlights": -40, "blacks": 15},
        {"temperature": 40, "tint": -20, "brightness": 60, "shadows": 35},
        {"whites": -60, "blacks": -30, "contrast": -25},
        {"highlights": -140, "shadows": 120},  # extended travel: monotone guard path
        {"tone_mapper": "agx", "exposure": 0.4, "contrast": 20, "whites": -30},
    ],
)
def test_the_banded_tone_block_is_bit_identical(edit, monkeypatch):
    """The row-band split exists because the tone block is pure per-pixel math;
    if a future pass in it ever looks at a neighbour or an image statistic,
    banding would show seams. This pins the contract: bands in, exactly the
    whole-frame bytes out."""
    monkeypatch.setattr(thumbnails, "_TONE_BAND_MIN_PX", 0)
    monkeypatch.setattr(thumbnails, "_TONE_BAND_WORKERS", 4)
    lin = _rng(11).random((97, 60, 3)).astype(np.float32) * 1.6  # odd height: uneven bands
    adj = develop.defaults() | edit
    whole = thumbnails._linear_tone_block(lin, adj, base_gain=1.3)
    banded = thumbnails._linear_tone_block_banded(lin, adj, base_gain=1.3)
    assert np.array_equal(whole, banded)


def test_tiny_frames_skip_the_bands():
    """A scrub frame must not pay the thread round-trip: below the pixel
    threshold the banded entry point is the plain whole-frame call."""
    lin = _rng(2).random((40, 60, 3)).astype(np.float32)
    adj = develop.defaults() | {"exposure": 0.3}
    out = thumbnails._linear_tone_block_banded(lin, adj)
    assert np.array_equal(out, thumbnails._linear_tone_block(lin, adj))


def test_tone_stage_cache_survives_a_tier_transition():
    """The quality ladder alternates tiers (different base keys) within one
    settle; a single-slot cache thrashed on every rung and repaid the denoise
    each time. The shallow LRU must keep both tiers' stages warm."""
    lin = _rng(5).random((40, 60, 3)).astype(np.float32)
    adj = develop.defaults() | {"luma_noise_reduction": 40}
    thumbnails.invalidate_tone_stage()
    thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="tier-a")
    thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="tier-b")
    assert len(thumbnails._tone_stage) == 2
    keys = set(thumbnails._tone_stage)
    thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="tier-a")
    assert set(thumbnails._tone_stage) == keys  # a hit, not a re-insert


def test_tone_stage_cache_stays_shallow():
    """Depth and byte budget are enforced: the oldest stage falls out first."""
    lin = _rng(5).random((40, 60, 3)).astype(np.float32)
    adj = develop.defaults() | {"luma_noise_reduction": 40}
    thumbnails.invalidate_tone_stage()
    for name in ("a", "b", "c", "d"):
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key=name)
    assert len(thumbnails._tone_stage) == thumbnails._TONE_STAGE_MAX_ENTRIES
    oldest = thumbnails._tone_stage_key("a", 1.0, adj, False)
    assert oldest not in thumbnails._tone_stage


# --- The editor preview's detail stage cache ---------------------------------
# The second checkpoint, below the detail (spatial) block: dragging a colour /
# curve / mask / finishing slider must not re-run clarity & friends per frame.
# Like the tone stage, it is a pure speed optimisation - the only thing worth
# testing is that it stays invisible.


@pytest.mark.parametrize("fast", [False, True])
@pytest.mark.parametrize(
    "edit",
    [
        {"clarity": 40, "saturation": 30},
        {"clarity": -50, "vibrance": 20},                     # pulls in the mist pass
        {"dehaze": 30, "structure": 25, "hue": 10},
        {"sharpness": 50, "grain_amount": 30, "vignette_amount": -40},
        {"chromatic_aberration_red_cyan": 30, "saturation": -20, "luma_noise_reduction": 25},
        {"exposure": 0.5, "clarity": 20, "dehaze": 15, "mist": 20},
    ],
)
def test_detail_stage_cache_is_bit_identical(fast, edit):
    """A warm detail-stage cache must produce exactly the bytes the uncached
    pipeline does (the _editor_render helper renders twice off the same key, so
    the second run is the cache-hit path)."""
    lin = _rng(9).random((80, 120, 3)).astype(np.float32) * 1.4
    adj = develop.defaults() | edit
    assert np.array_equal(
        _editor_render(lin, adj, fast=fast, key=None),
        _editor_render(lin, adj, fast=fast, key="base"),
    )


def test_detail_stage_cache_key_splits_below_the_detail_block():
    """Adjustments strictly below the detail block reuse the stage; the detail
    block's own sliders - and everything above them - recompute it. Every field
    is swept, so a key missing from _POST_DETAIL_KEYS cannot silently serve a
    stale stage."""
    lin = _rng(3).random((40, 60, 3)).astype(np.float32)
    base = develop.defaults() | {"clarity": 20, "dehaze": 15}

    def stage_key(adj) -> str:
        thumbnails.invalidate_tone_stage()
        thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="base")
        return next(iter(thumbnails._detail_stage))

    reference = stage_key(base)
    assert stage_key(base | {"saturation": 30}) == reference     # below the cut
    assert stage_key(base | {"grain_amount": 40}) == reference
    assert stage_key(base | {"clarity": -80}) != reference       # the block itself
    assert stage_key(base | {"exposure": 1.0}) != reference      # above it

    probes = {"tone_mapper": "agx", "film_sim": "provia", "curve_mode": "parametric"}
    stale = [
        key for key in develop.defaults()
        if key not in thumbnails._POST_DETAIL_KEYS
        and stage_key(base | {key: probes.get(key, 7)}) == reference
    ]
    assert not stale, f"changing these leaves a stale cached detail stage: {stale}"


def test_detail_stage_cache_needs_a_detail_slider():
    """With no detail slider active the detail stage IS the tone stage - caching
    it again would only spend a second copy of the same bytes."""
    lin = _rng(1).random((40, 60, 3)).astype(np.float32)
    thumbnails.invalidate_tone_stage()
    thumbnails.apply_adjustments_linear(
        lin, 1.0, develop.defaults() | {"saturation": 30}, tone_cache_key="base"
    )
    assert not thumbnails._detail_stage
    assert thumbnails._tone_stage


def test_a_colour_drag_reuses_the_detail_stage(monkeypatch):
    """The point of the cache: two renders differing only below the detail block
    run the spatial passes once, not per frame."""
    lin = _rng(4).random((40, 60, 3)).astype(np.float32)
    calls = 0
    real = thumbnails._clarity

    def counting(*a, **k):
        nonlocal calls
        calls += 1
        return real(*a, **k)

    monkeypatch.setattr(thumbnails, "_clarity", counting)
    thumbnails.invalidate_tone_stage()
    for saturation in (20, -20):
        thumbnails.apply_adjustments_linear(
            lin, 1.0, develop.defaults() | {"clarity": 30, "saturation": saturation},
            tone_cache_key="base",
        )
    assert calls == 1, "the detail stage was recomputed instead of reused"


# --- Clarity and denoise are detail controls, not colour controls ------------


def _saturated_chart(h=300, w=600) -> np.ndarray:
    """Saturated patches with fine brightness texture and hard colour edges
    between them - the content a per-channel filter damages."""
    import colorsys
    arr = np.zeros((h, w, 3), np.float32)
    step = w // 6
    for i, hue in enumerate([0.0, 0.08, 0.17, 0.33, 0.55, 0.75]):
        arr[:, i * step:(i + 1) * step] = colorsys.hsv_to_rgb(hue, 0.75, 0.6)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.clip(arr * (1.0 + 0.25 * np.sin(xx / 3.0) * np.sin(yy / 3.0))[..., None], 0.01, 1.0)


def _hue_sat_drift(before: np.ndarray, after: np.ndarray) -> tuple[float, float]:
    """(max saturation change, max hue rotation in degrees)."""
    import cv2
    b = cv2.cvtColor(np.clip(before, 0, 1), cv2.COLOR_RGB2HSV)
    a = cv2.cvtColor(np.clip(after, 0, 1), cv2.COLOR_RGB2HSV)
    dh = np.abs(((a[..., 0] - b[..., 0] + 180.0) % 360.0) - 180.0)
    return float(np.abs(a[..., 1] - b[..., 1]).max()), float(dh.max())


@pytest.mark.parametrize("amount", [1.3, 0.65, -0.65, -1.3])
def test_clarity_never_touches_colour(amount):
    """Clarity controls detail depth. It runs on luminance and is applied as one
    shared RGB ratio, so hue and saturation survive to float32 rounding - the
    per-channel version this replaced moved them by 0.05 and 10 degrees."""
    chart = _saturated_chart()
    dsat, dhue = _hue_sat_drift(chart, thumbnails._clarity(chart, 12.0, amount))
    assert dsat < 1e-5, f"saturation moved by {dsat}"
    assert dhue < 1e-3, f"hue rotated by {dhue} degrees"


def test_clarity_still_changes_detail_depth():
    """Guard against the ratio being a no-op: local contrast must actually move,
    up for positive and down for negative."""
    chart = _saturated_chart()
    luma = lambda a: (a @ thumbnails._LUMA).astype(np.float32)

    def detail(a):  # energy left after removing the local average
        import cv2
        y = luma(a)
        return float((y - cv2.GaussianBlur(y, (0, 0), 3.0)).std())

    assert detail(thumbnails._clarity(chart, 12.0, 0.65)) > detail(chart) * 1.02
    assert detail(thumbnails._clarity(chart, 12.0, -0.65)) < detail(chart) * 0.98


def test_denoise_guard_protects_colour_on_a_clean_image(monkeypatch):
    """Denoise scales its chroma correction by the noise level it can measure, so
    a photo with nothing to denoise keeps its colours. Asserted against the same
    pass with the guard lifted rather than against a fixed number: how much a
    chroma blur damages colour depends on the image, but the guard has to be a
    strict improvement on any of them."""
    chart = _saturated_chart()
    src = PILImage.fromarray((chart * 255 + 0.5).astype(np.uint8), "RGB")
    ref = np.asarray(src, np.float32) / 255.0

    guarded = _hue_sat_drift(ref, np.asarray(thumbnails._denoise_image(src, 50, 65), np.float32) / 255.0)
    monkeypatch.setattr(thumbnails, "_CHROMA_NOISE_K", 1e9)  # the pass as it was
    unguarded = _hue_sat_drift(ref, np.asarray(thumbnails._denoise_image(src, 50, 65), np.float32) / 255.0)

    assert guarded[0] < unguarded[0] * 0.75, f"saturation: {guarded[0]:.3f} vs {unguarded[0]:.3f}"
    assert guarded[1] < unguarded[1] * 0.75, f"hue: {guarded[1]:.1f} vs {unguarded[1]:.1f} degrees"


def test_denoise_still_removes_chroma_noise():
    """The colour guard must not cost the pass its job: real chroma blotching
    still has to come out, measured against the clean original."""
    import cv2
    clean = _saturated_chart()
    rng = _rng(4)
    ycc = cv2.cvtColor((clean * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2YCrCb).astype(np.float32)
    for c in (1, 2):  # low-frequency blotching, the shape high-ISO noise takes
        blob = cv2.GaussianBlur(rng.normal(0, 1, ycc.shape[:2]).astype(np.float32), (0, 0), 6.0)
        ycc[..., c] += blob / blob.std() * 7.0 + rng.normal(0, 2.0, ycc.shape[:2])
    noisy = cv2.cvtColor(np.clip(ycc, 0, 255).astype(np.uint8), cv2.COLOR_YCrCb2RGB)

    def chroma_err(a):
        a8 = a if a.dtype == np.uint8 else (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
        d = (cv2.cvtColor(a8, cv2.COLOR_RGB2YCrCb)[..., 1:].astype(np.float32)
             - cv2.cvtColor((clean * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2YCrCb)[..., 1:])
        return float(np.sqrt((d ** 2).mean()))

    out = thumbnails._denoise_image(PILImage.fromarray(noisy, "RGB"), 50, 65)
    assert chroma_err(np.asarray(out)) < chroma_err(noisy) * 0.95


def test_legacy_denoise_master_folds_into_the_two_channels():
    """The removed "Denoise" master fed luma 1:1 and chroma 1.3x, and the render
    took the stronger of master and per-channel slider. An edit saved with it has
    to keep rendering the same, so normalize() folds it in on read - which is what
    migrates every stored edit, preset and backup without a data migration."""
    assert "denoise" not in develop.defaults()

    folded = develop.normalize({"denoise": 50})
    assert (folded["luma_noise_reduction"], folded["color_noise_reduction"]) == (50, 65)

    # The per-channel sliders still win where they were set higher, exactly as
    # the old max() in the pipeline did.
    mixed = develop.normalize({"denoise": 50, "luma_noise_reduction": 80, "color_noise_reduction": 10})
    assert (mixed["luma_noise_reduction"], mixed["color_noise_reduction"]) == (80, 65)

    # A photo edited only with the master is still "edited" after the fold.
    assert not develop.is_neutral({"denoise": 30})
    assert develop.is_neutral({"denoise": 0})


def test_clarity_keeps_colour_on_fully_saturated_content():
    """The hardest case for a brightness ratio: colours already at the top of a
    channel, where a plain clip would compress the brightest channel hardest and
    rotate the hue. The ratio is capped instead, so they keep their colour."""
    import colorsys
    h, w = 200, 400
    chart = np.zeros((h, w, 3), np.float32)
    for i, hue in enumerate([0.0, 0.15, 0.35, 0.6]):
        chart[:, i * 100:(i + 1) * 100] = colorsys.hsv_to_rgb(hue, 1.0, 1.0)  # S=V=1
    xx = np.mgrid[0:h, 0:w][1].astype(np.float32)
    chart = np.clip(chart * (0.5 + 0.5 * np.sin(xx / 3.0))[..., None], 0.001, 1.0)
    for amount in (1.3, -1.3):  # slider at the ends of its travel
        _, dhue = _hue_sat_drift(chart, thumbnails._clarity(chart, 12.0, amount))
        assert dhue < 0.05, f"clarity {amount:+} rotated hue by {dhue:.3f} degrees"
