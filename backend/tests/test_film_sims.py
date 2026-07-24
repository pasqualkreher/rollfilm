"""Invariants of the built-in film simulation looks (bake, trilinear apply,
intensity blend, schema/pipeline wiring). Synthetic arrays only.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import numpy as np
import pytest

from app.services import develop, film_sims, thumbnails

_LOOKS = [s for s in film_sims.SIM_NAMES if s != "none"]
_BW_LOOKS = [s for s in _LOOKS if s.startswith(("acros", "monochrome"))]


def _srgb_image(shape=(24, 24, 3), seed=0) -> np.ndarray:
    return np.random.default_rng(seed).random(shape).astype(np.float32)


# --- contract -----------------------------------------------------------------

def test_neutral_and_zero_intensity_are_noops():
    arr = _srgb_image()
    assert film_sims.apply_film_sim(arr, "none", 100) is arr
    assert film_sims.apply_film_sim(arr, None, 100) is arr
    assert film_sims.apply_film_sim(arr, "velvia", 0) is arr


@pytest.mark.parametrize("sim", _LOOKS)
def test_every_look_bakes_and_applies_in_range(sim):
    arr = _srgb_image()
    out = film_sims.apply_film_sim(arr, sim, 100)
    assert out.shape == arr.shape
    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0
    assert not np.allclose(out, arr), "a selected look must change pixels"


@pytest.mark.parametrize("sim", _BW_LOOKS)
def test_bw_looks_are_monochrome(sim):
    out = film_sims.apply_film_sim(_srgb_image(), sim, 100)
    assert np.abs(out[..., 0] - out[..., 1]).max() < 1e-4
    assert np.abs(out[..., 1] - out[..., 2]).max() < 1e-4


def test_intensity_is_a_linear_blend():
    arr = _srgb_image()
    full = film_sims.apply_film_sim(arr, "classic_chrome", 100)
    half = film_sims.apply_film_sim(arr, "classic_chrome", 50)
    assert np.abs(half - (arr + (full - arr) * 0.5)).max() < 1e-5


def test_out_of_gamut_input_is_clipped_not_garbage():
    arr = np.array([[[-0.2, 0.5, 1.4]]], dtype=np.float32)
    out = film_sims.apply_film_sim(arr, "provia", 100)
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0


def test_grey_stays_near_grey_on_colour_looks():
    """The looks tint, but a mid-grey must not swing far - that would read as a
    broken white balance rather than a film stock."""
    grey = np.full((4, 4, 3), 0.5, np.float32)
    for sim in _LOOKS:
        out = film_sims.apply_film_sim(grey, sim, 100)
        assert abs(float(out.mean()) - 0.5) < 0.08, sim
        assert float(np.abs(out - out.mean(axis=-1, keepdims=True)).max()) < 0.05, sim


def test_cube_interpolation_matches_direct_bake():
    """Trilinear sampling through the 33-cube must track the recipe applied
    directly to the same colours (the cube is an approximation - keep it tight)."""
    colours = _srgb_image((1, 64, 3), seed=3)
    cube_out = film_sims.apply_film_sim(colours, "velvia", 100)
    direct = film_sims._bake(film_sims._RECIPES["velvia"], colours.reshape(-1, 3).astype(np.float32))
    assert np.abs(cube_out.reshape(-1, 3) - direct).max() < 0.02


# --- schema / pipeline wiring -------------------------------------------------

def test_schema_registration_and_normalize():
    assert develop.defaults()["film_sim"] == "none"
    assert develop.normalize({"film_sim": "astia"})["film_sim"] == "astia"
    assert develop.normalize({"film_sim": "kodachrome"})["film_sim"] == "none"
    assert not develop.is_neutral(develop.normalize({"film_sim": "astia"}))


def test_display_color_block_applies_film_sim():
    arr = _srgb_image()
    adj = develop.defaults()
    adj["film_sim"] = "velvia"
    out = thumbnails._display_color_block(arr.copy(), adj)
    expected = film_sims.apply_film_sim(arr, "velvia", 100)
    assert np.abs(out - expected).max() < 2e-3


def test_lut_intensity_scales_the_look_in_pipeline():
    arr = _srgb_image()
    adj = develop.defaults()
    adj["film_sim"] = "eterna"
    adj["lut_intensity"] = 0
    out = thumbnails._display_color_block(arr.copy(), adj)
    assert np.abs(out - np.clip(arr, 0.0, 1.0)).max() < 2e-3
