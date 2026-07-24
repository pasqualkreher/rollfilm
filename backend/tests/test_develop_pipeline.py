"""Invariants of the scene-referred develop pipeline (linear tone block, tone
ratio, Reinhard shoulder). Synthetic arrays only - no RAW decode, no fixtures.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import numpy as np
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
