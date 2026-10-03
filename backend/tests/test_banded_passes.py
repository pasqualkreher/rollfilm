"""Clarity, sharpening, grain and the output conversion run in row bands on a
big frame (thumbnails._band_map). The bands are an arrangement of the same
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
