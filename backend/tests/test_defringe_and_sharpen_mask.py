"""Defringe and the sharpening's Radius and Masking sliders: each at its
default renders exactly what an edit rendered before the slider existed;
masking keeps sharpening off flat areas; defringe takes the colour out of a
purple or green seam along a high-contrast edge and nothing else; and both
are band passes, so a big frame in bands is the frame whole (to the rounding
cv2 does differently at a band's position - never compared bit for bit)."""

import numpy as np
import pytest
from PIL import Image as PILImage

from app.services import develop, develop_effects, develop_v2, thumbnails

_PURPLE = np.array([0.55, 0.2, 0.75], np.float32)
_GREEN = np.array([0.35, 0.7, 0.25], np.float32)


def _chroma(px: np.ndarray) -> float:
    return float(px.max() - px.min())


def _fringed(colour: np.ndarray, h: int = 300, w: int = 400) -> np.ndarray:
    """Dark ground, a bright half on the right, a seam of `colour` along the
    edge, and a flat patch of the same colour far from any edge."""
    arr = np.full((h, w, 3), 0.15, np.float32)
    arr[:, w // 2 :] = 0.95
    arr[:, w // 2 - 3 : w // 2] = colour
    arr[40:140, 30:130] = colour
    return arr


def _frame(seed: int = 7, h: int = 1100, w: int = 1000) -> np.ndarray:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 0.5 + 0.4 * np.sin(xx / 37.0) * np.cos(yy / 29.0) + 0.25 * (np.sin(xx / 5.0) > 0.7)
    arr = np.stack([base * 0.9 + 0.08, base * 0.45 + 0.05, base], axis=-1)  # purplish
    arr += rng.normal(0.0, 0.02, arr.shape)
    return np.clip(arr, 0.0, 1.0).astype(np.float32)


@pytest.fixture
def whole(monkeypatch):
    def run(fn):
        with monkeypatch.context() as m:
            m.setattr(thumbnails, "_TONE_BAND_MIN_PX", 10**12)
            return fn()

    return run


# --- defaults --------------------------------------------------------------------


def test_the_new_keys_default_to_nothing():
    d = develop.defaults()
    assert (d["sharpness_radius"], d["sharpness_masking"]) == (100, 0)
    assert (d["defringe_purple"], d["defringe_green"]) == (0, 0)
    assert develop.is_neutral(d)
    assert develop.normalize({"sharpness_radius": 999, "defringe_green": -5})["sharpness_radius"] == 300
    assert develop.normalize({"defringe_green": -5})["defringe_green"] == 0


@pytest.mark.parametrize("long_edge", [1100, 1600, 2600, 7728])
def test_radius_100_is_the_radius_sharpening_always_had(long_edge):
    old = min(2.0, max(0.6, long_edge / 2000.0))
    assert thumbnails._sharpen_radius(long_edge, develop.defaults()) == old
    assert thumbnails._sharpen_radius(long_edge, {"sharpness_radius": 200}) == pytest.approx(2 * old)


@pytest.mark.parametrize("v2", [True, False])
def test_masking_0_is_the_sharpening_it_always_was(v2):
    arr = _fringed(_PURPLE)
    fn = develop_v2.sharpen if v2 else thumbnails._unsharp
    expected = fn(arr, 0.8, 0.6, threshold=10)
    assert np.array_equal(thumbnails._sharpen(arr, v2, 0.8, 0.6, 10, masking=0, ref_long_edge=400), expected)


def test_defringe_at_0_hands_the_frame_back():
    arr = _fringed(_PURPLE)
    assert develop_effects.defringe(arr, 0, 0) is arr


def test_a_stored_edit_without_the_keys_renders_the_same_picture():
    """An edit saved before these sliders existed carries none of their keys:
    it must render bit for bit what the same edit with them at their
    defaults renders."""
    image = PILImage.fromarray((_fringed(_PURPLE) * 255).astype(np.uint8))
    adj = develop.normalize({"sharpness": 60, "clarity": 20, "process": "7"})
    old = {k: v for k, v in adj.items()
           if k not in ("sharpness_radius", "sharpness_masking", "defringe_purple", "defringe_green")}
    a = np.asarray(thumbnails.apply_adjustments(image, adj))
    b = np.asarray(thumbnails.apply_adjustments(image, old))
    assert np.array_equal(a, b)


# --- masking ---------------------------------------------------------------------


def test_masking_100_leaves_flat_areas_untouched_and_still_sharpens_edges():
    # The width of a settled preview: edges are measured at that size.
    h, w = 200, 1600
    xx = np.arange(w, dtype=np.float32)
    # Soft texture: gentle enough to be "flat" for the mask, not for the sharpener.
    arr = np.repeat((0.4 + 0.01 * np.sin(xx / 1.5))[None, :, None], h, axis=0).repeat(3, axis=2)
    arr[:, 300:] = 0.9  # one hard edge
    arr = arr.astype(np.float32)
    plain = thumbnails._sharpen(arr, True, 1.0, 1.2, 0, masking=0, ref_long_edge=w)
    masked = thumbnails._sharpen(arr, True, 1.0, 1.2, 0, masking=100, ref_long_edge=w)
    flat = np.s_[:, 20:250]
    assert not np.array_equal(plain[flat], arr[flat])  # the texture is sharpened without masking
    assert np.array_equal(masked[flat], arr[flat])  # and left alone with it
    edge = np.s_[:, 297:303]
    assert np.abs(masked[edge] - arr[edge]).max() > 0.02
    half = thumbnails._sharpen(arr, True, 1.0, 1.2, 0, masking=50, ref_long_edge=w)
    d_half, d_plain = np.abs(half[flat] - arr[flat]).max(), np.abs(plain[flat] - arr[flat]).max()
    assert 0 < d_half < d_plain


def test_masked_sharpening_in_bands_is_the_whole_frame(whole):
    arr = _frame()
    banded = thumbnails._sharpen(arr, True, 1.5, 0.9, 5, masking=70, ref_long_edge=1100)
    expected = whole(lambda: thumbnails._sharpen(arr, True, 1.5, 0.9, 5, masking=70, ref_long_edge=1100))
    np.testing.assert_allclose(banded, expected, atol=1e-5)


def test_the_halo_grows_with_radius_and_masking():
    assert thumbnails._sharpen_halo(4.0) > thumbnails._sharpen_halo(1.0)
    assert thumbnails._sharpen_halo(1.0, masking=True) > thumbnails._sharpen_halo(1.0)


# --- defringe --------------------------------------------------------------------


def test_a_purple_fringe_on_a_bright_edge_loses_its_colour():
    arr = _fringed(_PURPLE)
    out = develop_effects.defringe(arr, 100, 0, long_edge=1600)
    assert _chroma(out[150, 198]) < 0.25 * _chroma(arr[150, 198])
    # Lightness is what the seam keeps.
    luma = develop_effects._LUMA
    assert abs(float(out[150, 198] @ luma) - float(arr[150, 198] @ luma)) < 0.1
    # The ground on either side is grey already and stays what it was.
    assert np.array_equal(out[:, 160:185], arr[:, 160:185])


def test_a_flat_purple_area_is_untouched():
    arr = _fringed(_PURPLE)
    out = develop_effects.defringe(arr, 100, 100, long_edge=1600)
    inner = np.s_[60:120, 50:110]
    assert np.array_equal(out[inner], arr[inner])


def test_each_slider_takes_only_its_own_hue():
    green = _fringed(_GREEN)
    assert np.array_equal(develop_effects.defringe(green, 100, 0, long_edge=1600), green)
    out = develop_effects.defringe(green, 0, 100, long_edge=1600)
    assert _chroma(out[150, 198]) < 0.5 * _chroma(green[150, 198])
    weaker = develop_effects.defringe(green, 0, 40, long_edge=1600)
    assert _chroma(out[150, 198]) < _chroma(weaker[150, 198]) < _chroma(green[150, 198])


def test_defringe_in_bands_is_the_whole_frame(whole):
    arr = _frame()
    banded = thumbnails._defringe(arr, 80, 60, 1100)
    expected = whole(lambda: thumbnails._defringe(arr, 80, 60, 1100))
    assert not np.array_equal(expected, arr)  # it did something to compare
    np.testing.assert_allclose(banded, expected, atol=2e-4)


def test_defringe_runs_in_the_pipeline_after_sharpening():
    # A preview-sized frame: the seams are measured at that size.
    image = PILImage.fromarray((_fringed(_PURPLE, h=300, w=1600) * 255).astype(np.uint8))
    base = develop.normalize({"sharpness": 30, "process": "7"})
    plain = np.asarray(thumbnails.apply_adjustments(image, base)).astype(int)
    fixed = np.asarray(thumbnails.apply_adjustments(image, {**base, "defringe_purple": 100})).astype(int)
    seam = fixed[150, 798]
    assert seam.max() - seam.min() < 0.5 * (plain[150, 798].max() - plain[150, 798].min())


def test_defringe_goes_in_bands_even_without_the_pool(whole, monkeypatch):
    """A one-core machine has no band pool; a 40MP frame still must not be
    defringed whole (an Oklab copy and a handful of planes per pixel)."""
    arr = _frame()
    expected = whole(lambda: thumbnails._defringe(arr, 80, 60, 1100))
    seen = []
    real = develop_effects.defringe
    monkeypatch.setattr(thumbnails, "_band_pool", lambda: None)
    monkeypatch.setattr(
        develop_effects, "defringe", lambda rows, *a, **k: seen.append(rows.shape[0]) or real(rows, *a, **k)
    )
    out = thumbnails._defringe(arr, 80, 60, 1100)
    assert len(seen) > 3 and max(seen) < arr.shape[0]
    np.testing.assert_allclose(out, expected, atol=2e-4)
