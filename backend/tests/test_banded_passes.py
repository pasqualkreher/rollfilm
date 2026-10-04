"""Clarity, sharpening, grain, the curves, chrome, mist, the colour denoise's
correction and the output conversion run in row bands on a big frame
(thumbnails._band_map). The bands are an arrangement of the same
arithmetic, so each test here renders one frame both ways - in bands, and as
the single band a small frame gets - and expects the same bits."""

import numpy as np
import pytest

from app.services import develop, develop_v2, thumbnails


def _frame(seed: int = 7, h: int = 1100, w: int = 1000) -> np.ndarray:
    """A frame big enough for several bands, with edges, texture and values
    past both ends of 0..1 (what the passes clip)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 0.5 + 0.4 * np.sin(xx / 37.0) * np.cos(yy / 29.0) + 0.25 * (np.sin(xx / 5.0) > 0.7)
    arr = np.stack([base, base * 0.85 + 0.05, base * 0.7 + 0.15], axis=-1)
    arr += rng.normal(0.0, 0.03, arr.shape)
    return np.clip(arr, -0.05, 1.1).astype(np.float32)


@pytest.fixture
def whole(monkeypatch):
    """Run a callable with banding off: every frame is one band."""

    def run(fn):
        with monkeypatch.context() as m:
            m.setattr(thumbnails, "_TONE_BAND_MIN_PX", 10**12)
            return fn()

    return run


def test_the_frame_is_actually_split():
    """Guards the tests below: without several bands they compare a thing
    with itself."""
    arr = _frame()
    h, w = arr.shape[:2]
    assert h * w >= thumbnails._TONE_BAND_MIN_PX
    assert len(thumbnails._row_bands(h)) > 3
    seen = []
    thumbnails._band_map(lambda y0, y1: seen.append((y0, y1)), h, w)
    assert sorted(seen) == thumbnails._row_bands(h)


@pytest.mark.parametrize("amount", [0.52, 1.3, -0.52])
def test_clarity_in_bands_is_the_whole_frame_clarity(whole, amount):
    arr = _frame()
    banded = thumbnails._clarity(arr, 40.0, amount)
    assert np.array_equal(banded, whole(lambda: thumbnails._clarity(arr, 40.0, amount)))


def test_clarity_written_into_its_own_frame_is_the_same_picture():
    arr = _frame()
    expected = thumbnails._clarity(arr, 40.0, 0.52)
    target = arr.copy()
    assert thumbnails._clarity(target, 40.0, 0.52, out=target) is target
    assert np.array_equal(target, expected)


@pytest.mark.parametrize(
    "v2, radius, amount, threshold",
    [
        (True, 2.0, 0.6, 0),  # process 2: luminance sharpen, the widest kernel
        (True, 0.6, 1.2, 12),  # ... the narrowest, with a threshold
        (False, 2.0, 0.6, 12),  # process 1: unsharp mask
        (True, 1.3, -0.5, 0),  # softening is the unsharp mask on any process
    ],
)
def test_sharpening_in_bands_is_the_whole_frame_sharpening(v2, radius, amount, threshold):
    arr = _frame()
    fn = develop_v2.sharpen if v2 and amount > 0 else thumbnails._unsharp
    banded = thumbnails._sharpen(arr, v2, radius, amount, threshold)
    assert np.array_equal(banded, fn(arr, radius, amount, threshold=threshold))


def test_grain_in_bands_is_the_whole_frame_grain(whole, monkeypatch):
    arr = _frame()
    h, w = arr.shape[:2]
    # One field for both renders - a fresh one each time is the grain's own
    # randomness, not the banding's.
    field = np.random.default_rng(3).standard_normal((h, w)).astype(np.float32)
    monkeypatch.setattr(thumbnails, "_cached_grain_field", lambda *a: field)
    banded = thumbnails._apply_grain(arr, 40, 25, 50)
    assert np.array_equal(banded, whole(lambda: thumbnails._apply_grain(arr, 40, 25, 50)))
    target = arr.copy()
    assert thumbnails._apply_grain(target, 40, 25, 50, out=target) is target
    assert np.array_equal(target, banded)


@pytest.mark.parametrize("depth16", [False, True])
def test_the_output_conversion_in_bands_rounds_like_the_whole_frame(depth16):
    arr = np.clip(_frame(), 0.0, 1.0)
    scale, dtype = (65535.0, np.uint16) if depth16 else (255.0, np.uint8)
    assert np.array_equal(
        thumbnails._to_output_depth(arr, depth16), (arr * scale + 0.5).astype(dtype)
    )


_POINT_CURVE = {"luma": [[4, 0], [65, 43], [193, 191], [255, 255]], "red": [[0, 0], [255, 240]]}
_PARAMETRIC_CURVE = {"luma": {"highlights": -30, "lights": 10, "darks": -10, "shadows": 20}}


@pytest.mark.parametrize(
    "curves",
    [
        {"curve_mode": "point", "point_curves": _POINT_CURVE},
        {"curve_mode": "parametric", "parametric_curve": _PARAMETRIC_CURVE},
        {},  # no curve: only the clip, and the frame is left alone
    ],
)
def test_the_curves_in_bands_are_the_whole_frame_curves(whole, curves):
    arr = _frame()
    adj = develop.defaults() | curves
    banded = thumbnails._apply_curves(arr.copy(), adj)
    assert np.array_equal(banded, whole(lambda: thumbnails._apply_curves(arr.copy(), adj)))
    if not curves:
        untouched = arr.copy()
        thumbnails._apply_curves(untouched, adj)
        assert np.array_equal(untouched, arr)


@pytest.mark.parametrize("chrome, blue", [(100, 0), (0, 80), (60, 40)])
def test_chrome_in_bands_is_the_whole_frame_chrome(whole, chrome, blue):
    arr = np.clip(_frame(), 0.0, 1.0)
    banded = thumbnails._apply_chrome(arr, chrome, blue)
    assert np.array_equal(banded, whole(lambda: thumbnails._apply_chrome(arr, chrome, blue)))
    assert np.abs(banded - arr).max() > 0.01


def test_chrome_without_the_hue_reads_the_same_saturation_and_lightness():
    arr = np.clip(_frame(h=64, w=64), 0.0, 1.0)
    arr[:8] = 0.5  # grey rows: the zero-chroma branch
    _, sat, lum = thumbnails._rgb_to_hsl(arr)
    short_sat, short_lum = thumbnails._hsl_sat_lum(arr)
    assert np.array_equal(short_sat, sat) and np.array_equal(short_lum, lum)


@pytest.mark.parametrize("light_sources", [True, False])
def test_mist_in_bands_is_the_whole_frame_mist(whole, light_sources):
    arr = np.clip(_frame(), 0.0, 1.0)
    banded = thumbnails._mist(arr, 40, light_sources=light_sources, ref_long_edge=1100.0)
    assert np.array_equal(
        banded,
        whole(lambda: thumbnails._mist(arr, 40, light_sources=light_sources, ref_long_edge=1100.0)),
    )
    assert np.abs(banded - arr).max() > 0.005


def test_mist_with_nothing_bright_enough_leaves_the_frame_as_it_is():
    arr = np.full((1100, 1000, 3), 0.3, dtype=np.float32)
    assert thumbnails._mist(arr, 40, light_sources=True) is arr


def test_the_colour_denoise_in_bands_is_the_whole_frame_colour_denoise(whole):
    arr = np.clip(_frame(), 0.0, 1.0)
    probe = thumbnails._noise_probe(arr)
    banded = thumbnails._chroma_nr(arr, probe, 0.5)
    assert np.array_equal(banded, whole(lambda: thumbnails._chroma_nr(arr, probe, 0.5)))
    assert np.abs(banded - arr).max() > 0.002


def test_the_colour_passes_never_write_into_the_cached_detail_stage(monkeypatch):
    """The curve is written into the frame the colour block is handed. With a
    detail stage cached, that frame must be the render's copy of it."""
    lin = np.clip(_frame(), 0.0, 1.0)
    adj = develop.defaults() | {
        "clarity": -25, "sharpness": 25, "chrome_effect": 100,
        "curve_mode": "point", "point_curves": _POINT_CURVE,
    }
    thumbnails.invalidate_tone_stage()
    first = np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="colour"))
    second = np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="colour"))
    assert np.array_equal(first, second)


def test_the_pipeline_never_writes_into_the_base_it_was_given(monkeypatch):
    """Clarity and grain write into the frame in hand. That frame must be the
    render's own - never the caller's linear base, which the editor keeps
    cached and renders from again."""
    lin = np.clip(_frame(), 0.0, 1.0)
    before = lin.copy()
    h, w = lin.shape[:2]
    field = np.random.default_rng(3).standard_normal((h, w)).astype(np.float32)
    monkeypatch.setattr(thumbnails, "_cached_grain_field", lambda *a: field)
    adj = develop.defaults() | {"clarity": 30, "sharpness": 40, "grain_amount": 30}
    thumbnails.invalidate_tone_stage()
    first = np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="banded"))
    assert np.array_equal(lin, before)
    # The second render starts from the cached detail stage - which the first
    # one must not have written its grain into.
    second = np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, tone_cache_key="banded"))
    assert np.array_equal(first, second)
    assert np.array_equal(lin, before)


def test_the_colour_bands_side_by_side_are_the_colour_bands_in_turn():
    """The perceptual colour pass already went through a big frame in bands;
    they now run on the pool. Same bands, same pixels."""
    arr = np.clip(_frame(h=2100, w=2000), 0.0, 1.0)
    adj = develop.defaults() | {"process": "2", "saturation": 25, "vibrance": 20}
    assert arr.shape[0] * arr.shape[1] > 2 * develop_v2._BAND_PIXELS
    in_turn = develop_v2.apply_perceptual_color(arr, adj)
    side_by_side = develop_v2.apply_perceptual_color(arr, adj, pool=thumbnails._tone_pool())
    assert np.array_equal(in_turn, side_by_side)


def test_a_band_never_waits_on_its_own_pool():
    """Work queued on the pool from one of its own workers would wait for a
    free worker that is the one waiting. Inside a band, bands run in place."""
    seen = []

    def outer(y0: int, y1: int) -> None:
        thumbnails._band_map(lambda a, b: seen.append((y0, a, b)), 2000, 1000)

    thumbnails._band_map(outer, 2000, 1000)
    bands = thumbnails._row_bands(2000)
    assert sorted(seen) == sorted((y0, 0, 2000) for y0, _ in bands)
