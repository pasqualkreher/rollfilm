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
        if sim == "sepia":
            continue  # toned on purpose - a brown grey is the whole look
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


# --- measured cubes (process version 3) ---------------------------------------

@pytest.fixture()
def measured_dir(tmp_path, monkeypatch):
    """An empty cube folder: no measured cubes, none of Fujifilm's either."""
    monkeypatch.setattr(film_sims, "_MEASURED_DIR", tmp_path)
    monkeypatch.setattr(film_sims, "_OFFICIAL_DIR", tmp_path / "official")
    film_sims._sim_cube.cache_clear()
    film_sims.official_cube.cache_clear()
    yield tmp_path
    film_sims._sim_cube.cache_clear()
    film_sims.official_cube.cache_clear()


def test_a_measured_cube_replaces_the_recipe_only_when_asked_for(measured_dir):
    cube = np.full((33, 33, 33, 3), 0.25, dtype=np.float16)
    np.save(measured_dir / "classic_neg.npy", cube)
    arr = np.random.default_rng(0).random((8, 8, 3)).astype(np.float32)
    recipe = film_sims.apply_film_sim(arr, "classic_neg")
    measured = film_sims.apply_film_sim(arr, "classic_neg", measured=True)
    np.testing.assert_allclose(measured, 0.25, atol=1e-3)
    assert np.abs(recipe - 0.25).max() > 0.1
    assert film_sims.has_measured("classic_neg")


def test_a_look_without_a_measured_cube_keeps_its_recipe(measured_dir):
    arr = np.random.default_rng(1).random((8, 8, 3)).astype(np.float32)
    np.testing.assert_array_equal(
        film_sims.apply_film_sim(arr, "velvia", measured=True), film_sims.apply_film_sim(arr, "velvia")
    )
    assert not film_sims.has_measured("velvia")


def test_an_unusable_measured_cube_falls_back_to_the_recipe(measured_dir):
    np.save(measured_dir / "eterna.npy", np.zeros((4, 5, 6), dtype=np.float16))
    arr = np.random.default_rng(2).random((8, 8, 3)).astype(np.float32)
    np.testing.assert_array_equal(
        film_sims.apply_film_sim(arr, "eterna", measured=True), film_sims.apply_film_sim(arr, "eterna")
    )


def test_only_process_3_on_a_raw_source_renders_the_measured_cube(measured_dir):
    from app.services import develop, thumbnails

    np.save(measured_dir / "classic_neg.npy", np.full((33, 33, 33, 3), 0.25, dtype=np.float16))
    lin = np.random.default_rng(3).random((16, 16, 3)).astype(np.float32) * 0.5

    def render(process: str, raw_source: bool) -> np.ndarray:
        adj = develop.normalize({"film_sim": "classic_neg", "process": process})
        return np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=raw_source))

    assert np.abs(render("3", True).astype(int) - 64).max() <= 1
    np.testing.assert_array_equal(render("2", True), render("2", False))
    np.testing.assert_array_equal(render("3", False), render("2", False))


# --- the cube lookup -----------------------------------------------------------

def _sample_cube_reference(arr: np.ndarray, cube: np.ndarray) -> np.ndarray:
    """Trilinear interpolation spelled out: the eight corners, gathered."""
    n = cube.shape[0]
    flat = cube.reshape(-1, 3)
    x = np.clip(arr, 0.0, 1.0).reshape(-1, 3) * (n - 1)
    i0 = np.minimum(x.astype(np.int32), n - 2)
    f = (x - i0).astype(np.float32)
    fr, fg, fb = f[:, 0:1], f[:, 1:2], f[:, 2:3]
    base = (i0[:, 0] * n + i0[:, 1]) * n + i0[:, 2]
    c00 = flat.take(base, axis=0) * (1 - fb) + flat.take(base + 1, axis=0) * fb
    c01 = flat.take(base + n, axis=0) * (1 - fb) + flat.take(base + n + 1, axis=0) * fb
    c10 = flat.take(base + n * n, axis=0) * (1 - fb) + flat.take(base + n * n + 1, axis=0) * fb
    c11 = flat.take(base + n * n + n, axis=0) * (1 - fb) + flat.take(base + n * n + n + 1, axis=0) * fb
    c0 = c00 * (1 - fg) + c01 * fg
    c1 = c10 * (1 - fg) + c11 * fg
    return (c0 * (1 - fr) + c1 * fr).astype(np.float32).reshape(arr.shape)


@pytest.mark.parametrize("n", [17, 33, 65])
def test_the_cube_lookup_is_trilinear_interpolation(n, monkeypatch):
    rng = np.random.default_rng(n)
    cube = rng.random((n, n, n, 3)).astype(np.float32)  # no smoothness to hide behind
    arr = rng.random((40, 50, 3)).astype(np.float32)
    arr[0, 0], arr[0, 1], arr[0, 2] = 0.0, 1.0, (1.0, 0.0, 1.0)  # the cube's corners
    np.testing.assert_allclose(film_sims._sample_cube(arr, cube), _sample_cube_reference(arr, cube), atol=2e-4)
    # A frame taller than one band is the same picture, band by band.
    monkeypatch.setattr(film_sims, "_SAMPLE_BAND_ROWS", 7)
    np.testing.assert_array_equal(film_sims._sample_cube(arr, cube), film_sims._sample_band(arr, cube))
    # And a plain list of colours goes through too.
    colours = arr.reshape(-1, 3)
    np.testing.assert_allclose(
        film_sims._sample_cube(colours, cube), _sample_cube_reference(colours, cube), atol=2e-4
    )


# --- Fujifilm's own cubes (process version 3) ----------------------------------

_OFFICIAL = sorted(film_sims.OFFICIAL_SIMS)


@pytest.mark.parametrize("sim", _OFFICIAL)
def test_the_shipped_official_cubes_are_sound(sim):
    film_sims.official_cube.cache_clear()
    cube = film_sims.official_cube(sim)
    assert cube is not None and cube.shape == (65, 65, 65, 3)
    # A grey ramp in scene reflectance: black is black, middle grey lands where
    # a display shows 18% (sRGB 0.46), six stops over it is white, and it never
    # turns back.
    ramp = np.geomspace(0.002, 16.0, 64, dtype=np.float32)
    scene = np.repeat(np.concatenate([[0.0], ramp, [0.18]]).astype(np.float32)[None, :, None], 3, axis=2)
    out = film_sims.apply_official(scene, sim)[0]
    assert out.dtype == np.float32 and out.min() >= 0.0 and out.max() <= 1.0
    luma = out @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    assert luma[0] < 0.02
    assert abs(luma[-1] - 0.46) < 0.03, sim
    assert luma[-2] > 0.97
    assert np.all(np.diff(luma[:-1]) > -1e-3), sim
    if sim == "acros":
        assert np.abs(out[:, 0] - out[:, 1]).max() < 1e-4 and np.abs(out[:, 1] - out[:, 2]).max() < 1e-4


def test_only_process_3_on_a_raw_source_renders_fujifilms_cube():
    def adj(**over):
        return develop.normalize({"film_sim": "classic_neg", "process": "3", **over})

    assert film_sims.official_sim(adj(), True) == "classic_neg"
    assert film_sims.official_sim(adj(), False) is None
    assert film_sims.official_sim(adj(process="2"), True) is None
    assert film_sims.official_sim(adj(lut_intensity=0), True) is None
    assert film_sims.official_sim(adj(film_sim="none"), True) is None
    # Fujifilm publishes no Nostalgic Neg.: that look stays a display cube.
    assert film_sims.official_sim(adj(film_sim="nostalgic_neg"), True) is None


def test_fujifilms_cube_is_the_tone_map_and_is_not_applied_twice():
    lin = np.random.default_rng(5).random((16, 16, 3)).astype(np.float32) * 0.6
    adj = develop.normalize({"film_sim": "classic_neg", "process": "3"})
    out = np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True))
    expected = film_sims.apply_official(lin, "classic_neg")
    assert np.abs(out.astype(int) - np.round(expected * 255.0).astype(int)).max() <= 1
    # AgX has nothing to map: the look carries its own tone curve.
    agx = develop.normalize({"film_sim": "classic_neg", "process": "3", "tone_mapper": "agx"})
    np.testing.assert_array_equal(
        np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, agx, raw_source=True)), out
    )


def test_intensity_blends_fujifilms_cube_with_the_plain_render():
    lin = np.random.default_rng(6).random((16, 16, 3)).astype(np.float32) * 0.6

    def render(**over) -> np.ndarray:
        adj = develop.normalize({"process": "3", **over})
        return np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True)).astype(float)

    plain, full = render(), render(film_sim="velvia")
    half = render(film_sim="velvia", lut_intensity=50)
    assert np.abs(full - plain).max() > 8
    assert np.abs(half - (plain + full) / 2).max() <= 1.5


def test_whites_and_blacks_still_move_a_picture_rendered_from_fujifilms_cube():
    lin = np.random.default_rng(7).random((16, 16, 3)).astype(np.float32) * 0.6

    def mean(**over) -> float:
        adj = develop.normalize({"film_sim": "provia", "process": "3", **over})
        return float(np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True)).mean())

    base = mean()
    assert mean(whites=60) > base + 1 and mean(whites=-60) < base - 1
    assert mean(blacks=60) > base + 1 and mean(blacks=-60) < base - 1


def test_the_shipped_measured_cubes_are_sound():
    film_sims._sim_cube.cache_clear()
    for path in sorted(film_sims._MEASURED_DIR.glob("*.npy")):
        sim = path.stem
        assert sim in film_sims.SIM_NAMES
        cube = film_sims._sim_cube(sim, True)
        assert cube.shape == (33, 33, 33, 3)
        assert cube.min() >= 0.0 and cube.max() <= 1.0
        # Black stays dark, white stays bright, and the grey axis never turns back.
        grey = cube[np.arange(33), np.arange(33), np.arange(33)] @ np.array([0.2126, 0.7152, 0.0722])
        assert grey[0] < 0.08 and grey[-1] > 0.92
        assert np.all(np.diff(grey) > -1e-3), sim
