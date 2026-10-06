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
        if sim in film_sims.CLUT_SIMS:
            continue  # a film scan brings its own brightness and cast (see below)
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
    monkeypatch.setattr(film_sims, "_DERIVED_DIR", tmp_path / "derived")
    monkeypatch.setattr(film_sims, "_ANALOG_DIR", tmp_path / "analog")
    monkeypatch.setattr(film_sims, "_SPECTRAL_DIR", tmp_path / "spectral")
    monkeypatch.setattr(film_sims, "_CLUT_DIR", tmp_path / "clut")
    caches = (
        film_sims._sim_cube, film_sims.official_cube, film_sims.derived_cube,
        film_sims.analog_cube, film_sims.clut_cube, film_sims._clut_scene_cube,
        film_sims._film_display_cube, film_sims._film_factors,
    )
    for cache in caches:
        cache.cache_clear()
    yield tmp_path
    for cache in caches:
        cache.cache_clear()


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


# --- the looks as stills (process version 4) -----------------------------------

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
_GREY_LOOKS = [s for s in _LOOKS if s.startswith(("acros", "monochrome"))]


def _grey(values) -> np.ndarray:
    return np.repeat(np.asarray(values, dtype=np.float32)[None, :, None], 3, axis=2)


# The film scan looks are display cubes laid over Provia: black, middle grey and
# white are where each scan has them, not where a camera's still does. They
# have their own tests at the end.
_STILL_LOOKS = [s for s in _LOOKS if s not in film_sims.CLUT_SIMS]


@pytest.mark.parametrize("sim", _STILL_LOOKS)
def test_every_look_renders_from_a_scene_cube_as_a_still(sim):
    adj = develop.normalize({"film_sim": sim, "process": "4"})
    assert film_sims.official_sim(adj, True) == sim
    assert film_sims.official_sim(adj, False) is None
    cube = film_sims.official_cube(sim)
    if cube is None:
        cube = film_sims.derived_cube(sim)
    if cube is None:
        cube = film_sims.analog_cube(sim)
    assert cube is not None and cube.shape == (65, 65, 65, 3)
    # The frame as the sensor recorded it, 1.0 = clipping: black is black, what
    # the camera meters as middle grey shows as middle grey, clipping is white
    # (Sepia's and Nostalgic Neg.'s paper is tinted), and it never turns back.
    ramp = np.concatenate([[0.0], np.geomspace(0.001, 1.0, 80), [0.097]]).astype(np.float32)
    out = film_sims.apply_official(_grey(ramp), sim, 1.0)[0]
    luma = out @ _LUMA
    assert luma[0] < 0.03
    assert abs(luma[-1] - 0.46) < 0.03, sim
    assert luma[-2] > 0.96, sim
    assert np.all(np.diff(luma[:-1]) > -2e-3), sim
    if sim in _GREY_LOOKS:
        colours = np.random.default_rng(1).random((1, 200, 3)).astype(np.float32)
        grey = film_sims.apply_official(colours, sim, 1.0)[0]
        assert np.abs(grey[:, 0] - grey[:, 1]).max() < 1e-3 and np.abs(grey[:, 1] - grey[:, 2]).max() < 1e-3


def test_a_filter_look_keeps_the_grey_ramp_of_its_base_and_moves_the_colours():
    ramp = _grey(np.geomspace(0.002, 1.0, 40))
    for base, sims in (("acros", ("acros_ye", "acros_r", "acros_g")),):
        plain = film_sims.apply_official(ramp, base, 1.0)
        for sim in sims:
            assert np.abs(film_sims.apply_official(ramp, sim, 1.0) - plain).max() < 0.01, sim
    red, blue = np.array([[[0.30, 0.05, 0.04], [0.04, 0.07, 0.30]]], dtype=np.float32)[0]

    def shows(sim: str, colour: np.ndarray) -> float:
        return float(film_sims.apply_official(colour[None, None, :], sim, 1.0)[0, 0, 0])

    # A red filter lets red through and holds blue back; yellow sits between.
    assert shows("acros_r", red) > shows("acros_ye", red) > shows("acros", red) > shows("acros_g", red)
    assert shows("acros_r", blue) < shows("acros_ye", blue) < shows("acros", blue)
    assert shows("monochrome_r", red) > shows("monochrome", red) > shows("monochrome_g", red)


@pytest.mark.parametrize("white", [1.0, 1.7, 3.3, 8.0, 20.0])
def test_the_still_is_the_cube_given_more_light_below_the_knee_and_white_at_clipping(white):
    # Up to an eighth of clipping at the camera's own exposure: the anchor and
    # nothing else, however far the frame was lifted.
    below = _grey(np.geomspace(0.001, 0.11, 30))
    np.testing.assert_allclose(
        film_sims.apply_official(below, "provia", white),
        film_sims.apply_official(below * film_sims._STILLS_ANCHOR, "provia"),
        atol=2e-3,
    )
    # Sensor clipping - the gain the frame was lifted by - is white.
    clip = film_sims.apply_official(_grey([white]), "provia", white)[0, 0]
    assert clip.min() > 0.985
    # And the way there never turns back.
    ramp = film_sims.apply_official(_grey(np.geomspace(0.001, white * 1.5, 400)), "provia", white)[0] @ _LUMA
    assert np.all(np.diff(ramp) > -2e-3)


def test_a_frame_taller_than_one_band_is_the_same_still(monkeypatch):
    scene = np.random.default_rng(2).random((30, 20, 3)).astype(np.float32) * 1.5
    whole = film_sims.apply_official(scene, "velvia", 1.0)
    monkeypatch.setattr(film_sims, "_SAMPLE_BAND_ROWS", 7)
    # To the last place but one: cv2.transform rounds a pixel differently in
    # its vector code than in the scalar code it finishes an array with, and a
    # band ends elsewhere than the frame does (seen on the x86 CI runner: one
    # value in 1800 off by 6e-8).
    np.testing.assert_allclose(film_sims.apply_official(scene, "velvia", 1.0), whole, rtol=0, atol=1e-5)


def test_process_4_renders_the_still_and_process_3_the_cube_as_it_stands():
    lin = np.random.default_rng(8).random((16, 16, 3)).astype(np.float32) * 0.4

    def render(process: str, gain: float, **over) -> np.ndarray:
        adj = develop.normalize({"film_sim": "classic_neg", "process": process, **over})
        return np.asarray(thumbnails.apply_adjustments_linear(lin, gain, adj, raw_source=True)).astype(int)

    def expect(scene: np.ndarray, white: float | None) -> np.ndarray:
        return np.round(film_sims.apply_official(scene, "classic_neg", white) * 255.0).astype(int)

    assert np.abs(render("3", 2.0) - expect(lin * 2.0, None)).max() <= 1
    assert np.abs(render("4", 2.0) - expect(lin * 2.0, 2.0)).max() <= 1
    # Exposure is part of the gain: a stop up moves the white point with it.
    assert np.abs(render("4", 2.0, exposure=1.0) - expect(lin * 4.0, 4.0)).max() <= 1
    # A frame darkened below the camera's exposure keeps the camera's white point.
    assert np.abs(render("4", 1.0, exposure=-1.0) - expect(lin * 0.5, 1.0)).max() <= 1
    assert render("4", 2.0).mean() > render("3", 2.0).mean() + 10


def test_a_look_without_its_derived_cube_falls_back_to_the_display_cube(tmp_path, monkeypatch):
    monkeypatch.setattr(film_sims, "_DERIVED_DIR", tmp_path)
    film_sims.derived_cube.cache_clear()
    try:
        adj = develop.normalize({"film_sim": "nostalgic_neg", "process": "4"})
        assert film_sims.official_sim(adj, True) is None
        assert film_sims.official_sim({**adj, "film_sim": "provia"}, True) == "provia"
        lin = np.random.default_rng(9).random((8, 8, 3)).astype(np.float32) * 0.5
        on_3 = develop.normalize({"film_sim": "nostalgic_neg", "process": "3"})
        np.testing.assert_array_equal(
            np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True)),
            np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, on_3, raw_source=True)),
        )
    finally:
        film_sims.derived_cube.cache_clear()


# --- process version 5: the tone mapper under a look ---------------------------

def test_process_5_with_basic_is_process_4_and_agx_is_only_heard_on_5():
    lin = np.random.default_rng(11).random((16, 16, 3)).astype(np.float32) * 0.9

    def render(**over) -> np.ndarray:
        adj = develop.normalize({"film_sim": "classic_neg", **over})
        return np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True))

    on_4 = render(process="4")
    np.testing.assert_array_equal(render(process="5"), on_4)
    np.testing.assert_array_equal(render(process="4", tone_mapper="agx"), on_4)
    assert np.abs(render(process="5", tone_mapper="agx").astype(int) - on_4.astype(int)).max() > 8


# --- process version 7: the scene colours Fujifilm's cubes were made for -------

def test_process_7_mixes_the_scene_for_fujifilm_cubes_only():
    from app.services import develop_v2

    rng = np.random.default_rng(12)
    lin = rng.random((16, 16, 3)).astype(np.float32) * 0.9
    grey = np.repeat(rng.random((16, 16, 1)).astype(np.float32) * 0.9, 3, axis=2)

    def render(frame, **over) -> np.ndarray:
        adj = develop.normalize({"film_sim": "provia", **over})
        return np.asarray(thumbnails.apply_adjustments_linear(frame.copy(), 1.0, adj, raw_source=True))

    for adj in ({"process": "7"}, {"process": "7", "tone_mapper": "agx"}):
        assert film_sims.renders_as_still(adj) and film_sims.mixes_scene(adj)
        assert film_sims.official_sim({**adj, "film_sim": "provia"}, True) == "provia"
    assert film_sims.agx_under_look({"process": "7", "tone_mapper": "agx"})
    assert not film_sims.mixes_scene({"process": "6"})
    # 6 is untouched: still 5 with Basic. Grey is grey on 7 too (rows sum to 1).
    np.testing.assert_array_equal(render(lin, process="6"), render(lin, process="5"))
    np.testing.assert_array_equal(render(grey, process="7"), render(grey, process="6"))
    # Colours move: a leaf comes out greener and more saturated than on 6.
    leaf = np.full((4, 4, 3), (0.08, 0.20, 0.05), dtype=np.float32)
    on_6, on_7 = render(leaf, process="6"), render(leaf, process="7")
    assert np.abs(on_7.astype(int) - on_6.astype(int)).max() > 4
    lab_6, lab_7 = (develop_v2.linear_to_oklab(develop_v2._srgb_to_linear(x[0, 0] / 255.0)) for x in (on_6, on_7))
    hue_6, hue_7 = (np.degrees(np.arctan2(l[2], l[1])) for l in (lab_6, lab_7))
    assert hue_7 > hue_6 + 2 and np.hypot(*lab_7[1:]) > np.hypot(*lab_6[1:])
    # A film stock baked from the textbook F-Gamut is not mixed.
    stock = film_sims.ANALOG_SIMS[0]
    np.testing.assert_array_equal(render(lin, film_sim=stock, process="7"), render(lin, film_sim=stock, process="6"))


def test_process_7_in_bands_is_process_7_whole():
    lin = np.random.default_rng(13).random((2100, 6, 3)).astype(np.float32) * 0.9
    whole = film_sims.apply_official(lin, "classic_neg", 1.0, mix=True)
    bands = np.concatenate([film_sims.apply_official(lin[y:y + 700], "classic_neg", 1.0, mix=True) for y in range(0, 2100, 700)])
    np.testing.assert_allclose(bands, whole, atol=1e-4)


@pytest.mark.parametrize("sim", _LOOKS)
def test_agx_under_a_look_puts_the_grey_ramp_where_agx_puts_it(sim):
    from app.services import develop_effects

    # From five stops under middle grey to three over: inside what every cube
    # can show (a look with lifted blacks cannot go as dark as AgX does).
    ramp = _grey(0.18 * 2.0 ** np.linspace(-5.0, 3.0, 60))
    wanted = develop_effects.agx_tonemap(ramp)[0] @ _LUMA
    out = film_sims.apply_official(ramp, sim, 1.0, agx=True)[0].astype(np.float64)
    shown = np.where(out <= 0.04045, out / 12.92, ((out + 0.055) / 1.055) ** 2.4) @ _LUMA
    # A film scan with a faded black or a dimmed white has less than that:
    # judged where AgX stays between what the look shows of nothing and of
    # sixty times clipping.
    ends = film_sims.apply_official(_grey([0.0, 60.0]), sim, 1.0)[0].astype(np.float64)
    low, high = np.where(ends <= 0.04045, ends / 12.92, ((ends + 0.055) / 1.055) ** 2.4) @ _LUMA
    within = (wanted > low + 2e-3) & (wanted < high - 2e-3) if sim in film_sims.CLUT_SIMS else slice(None)
    assert np.count_nonzero(np.ones(60, bool)[within]) > 20, sim
    assert np.abs(shown - wanted)[within].max() < 2e-3, sim
    if sim in _GREY_LOOKS:
        colours = np.random.default_rng(1).random((1, 200, 3)).astype(np.float32)
        grey = film_sims.apply_official(colours, sim, 1.0, agx=True)[0]
        assert np.abs(grey[:, 0] - grey[:, 1]).max() < 1e-3 and np.abs(grey[:, 1] - grey[:, 2]).max() < 1e-3


def test_agx_under_a_look_keeps_the_looks_colour():
    # A colour look still differs from plain AgX, and Velvia stays more
    # saturated than Eterna.
    lin = np.random.default_rng(12).random((1, 400, 3)).astype(np.float32) * 0.8

    def chroma(sim: str) -> float:
        out = film_sims.apply_official(lin, sim, 1.0, agx=True)[0]
        return float((out.max(axis=1) - out.min(axis=1)).mean())

    assert chroma("velvia") > chroma("eterna") + 0.03


def test_a_frame_taller_than_one_band_is_the_same_picture_under_agx(monkeypatch):
    lin = np.random.default_rng(13).random((40, 12, 3)).astype(np.float32) * 1.4
    whole = film_sims.apply_official(lin, "provia", 1.0, agx=True)
    monkeypatch.setattr(film_sims, "_SAMPLE_BAND_ROWS", 16)
    # A tolerance, not equality: cv2.transform rounds by position on x86.
    np.testing.assert_allclose(
        film_sims.apply_official(lin, "provia", 1.0, agx=True), whole, atol=1e-4
    )


def test_intensity_blends_agx_under_a_look_with_plain_agx():
    lin = np.random.default_rng(14).random((16, 16, 3)).astype(np.float32) * 0.6

    def render(**over) -> np.ndarray:
        adj = develop.normalize({"process": "5", "tone_mapper": "agx", **over})
        return np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=True)).astype(float)

    plain, full = render(), render(film_sim="velvia")
    half = render(film_sim="velvia", lut_intensity=50)
    assert np.abs(full - plain).max() > 8
    assert np.abs(half - (plain + full) / 2).max() <= 1.5


# --- analog film looks (spektrafilm's and spectral_film_lut's stocks, process 4 and up) ---

_ANALOG = list(film_sims.ANALOG_SIMS)


@pytest.mark.parametrize("sim", _ANALOG)
def test_the_shipped_analog_cubes_are_sound(sim):
    film_sims.analog_cube.cache_clear()
    cube = film_sims.analog_cube(sim)
    assert cube is not None and cube.shape == (65, 65, 65, 3)
    # A grey ramp in scene reflectance, a quarter stop a step: the medium's
    # black is black, 18% grey is middle grey, six stops over it is the
    # medium's white on display white, and it never turns back.
    ramp = _grey(np.concatenate([[0.0], 0.18 * 2.0 ** np.linspace(-8.0, 6.0, 57)]))
    luma = film_sims._sample_cube(film_sims._flog2(ramp), cube)[0] @ _LUMA
    assert luma[0] < 0.03
    assert abs(luma[33] - 0.46) < 0.03, sim
    assert luma[-1] > 0.98, sim
    assert np.all(np.diff(luma) > -2e-3), sim


def test_an_analog_look_is_lifted_by_what_its_own_shoulder_is_short_of_white():
    # A pushed negative on paper is at its white where the sensor clips; a cine
    # negative on print film is most of a stop short of it.
    assert film_sims._analog_top("kodak_portra_800_push2") == 0.0
    assert 0.5 < film_sims._analog_top("kodak_vision3_500t") < 1.5
    # Nothing missing is the anchor alone, whatever the frame was lifted by.
    for white in (1.0, 4.0):
        assert np.allclose(film_sims._stills_factors(white, 0.0)[1], film_sims._STILLS_ANCHOR)
    # Fujifilm's cubes keep the shoulder measured for them.
    np.testing.assert_array_equal(
        film_sims._stills_factors(2.0)[1],
        film_sims._stills_factors(2.0, float(film_sims._STILLS_SHOULDER[-1]))[1],
    )


@pytest.mark.parametrize("sim", _ANALOG)
def test_an_analog_look_on_a_display_picture_keeps_black_grey_and_white(sim):
    cube = film_sims._sim_cube(sim)
    assert cube.shape == (33, 33, 33, 3)
    grey = cube[np.arange(33), np.arange(33), np.arange(33)] @ _LUMA
    assert grey[0] < 0.03 and grey[-1] > 0.96, sim
    assert abs(grey[16] - 0.5) < 0.04, sim
    assert np.all(np.diff(grey) > -1e-3), sim


def test_the_black_and_white_analog_look_renders_grey():
    assert not np.ptp(film_sims.analog_cube("kodak_doublex"), axis=-1).any()
    colours = np.random.default_rng(2).random((1, 200, 3)).astype(np.float32)
    for out in (
        film_sims.apply_official(colours, "kodak_doublex", 1.0)[0],
        film_sims.apply_film_sim(colours, "kodak_doublex")[0],
    ):
        assert np.abs(out[:, 0] - out[:, 1]).max() < 1e-3 and np.abs(out[:, 1] - out[:, 2]).max() < 1e-3


def test_an_analog_look_exists_from_process_4_on_and_on_a_jpeg_too():
    lin = np.random.default_rng(21).random((16, 16, 3)).astype(np.float32) * 0.6

    def render(raw_source: bool = True, **over) -> np.ndarray:
        adj = develop.normalize(over)
        return np.asarray(thumbnails.apply_adjustments_linear(lin, 1.0, adj, raw_source=raw_source)).astype(int)

    for process in ("4", "5"):
        adj = develop.normalize({"film_sim": "kodak_portra_400", "process": process})
        assert film_sims.official_sim(adj, True) == "kodak_portra_400"
        assert np.abs(render(film_sim="kodak_portra_400", process=process) - render(process=process)).max() > 8
    assert film_sims.official_sim(develop.normalize({"film_sim": "kodak_portra_400", "process": "3"}), True) is None
    assert np.abs(
        render(False, film_sim="kodak_kodachrome_64", process="5") - render(False, process="5")
    ).max() > 8


def test_an_analog_look_without_its_cube_leaves_the_picture_alone(measured_dir):
    arr = _srgb_image()
    assert film_sims.apply_film_sim(arr, "kodak_portra_400") is arr
    adj = develop.normalize({"film_sim": "kodak_portra_400", "process": "5"})
    assert film_sims.official_sim(adj, True) is None


# --- film scan looks (the RawTherapee collection's display cubes) --------------

_CLUT = list(film_sims.CLUT_SIMS)
# Expired or first-generation instant film: the scan's black is a grey and its
# white a cream, which is the look.
_FADED = {"polaroid_px_70", "polaroid_px_680", "polaroid_time_zero"}


@pytest.mark.parametrize("sim", _CLUT)
def test_the_shipped_film_scan_cubes_are_sound(sim):
    film_sims.clut_cube.cache_clear()
    cube = film_sims.clut_cube(sim)
    assert cube is not None and cube.shape == (33, 33, 33, 3)
    assert cube.min() >= 0.0 and cube.max() <= 1.0
    grey = cube[np.arange(33), np.arange(33), np.arange(33)] @ _LUMA
    if sim not in _FADED:
        assert grey[0] < 0.1 and grey[-1] > 0.9, sim
    # The grey axis rises; a step back is one of the 8 bits the scans came in.
    assert grey[-1] > grey[16] > grey[0], sim
    assert np.all(np.diff(grey) > -0.01), sim


def test_the_black_and_white_film_scans_render_grey():
    grey_cubes = [s for s in _CLUT if not np.ptp(film_sims.clut_cube(s), axis=-1).any()]
    assert len(grey_cubes) >= 22 and "kodak_tri_x_400" in grey_cubes and "ilford_hp5_plus_400" in grey_cubes
    colours = np.random.default_rng(1).random((1, 200, 3)).astype(np.float32)
    for sim in grey_cubes:
        for out in (film_sims.apply_official(colours, sim, 1.0)[0], film_sims.apply_film_sim(colours, sim)[0]):
            assert np.abs(out[:, 0] - out[:, 1]).max() < 1e-3 and np.abs(out[:, 1] - out[:, 2]).max() < 1e-3, sim


@pytest.mark.parametrize("sim", _CLUT)
def test_a_film_scans_scene_cube_is_provia_with_the_scan_laid_over_it(sim):
    for process in ("4", "5"):
        adj = develop.normalize({"film_sim": sim, "process": process})
        assert film_sims.official_sim(adj, True) == sim
    assert film_sims.official_sim(develop.normalize({"film_sim": sim, "process": "3"}), True) is None
    cube = film_sims._scene_cube(sim, True)
    assert cube.shape == (65, 65, 65, 3)
    # F-Log2 code values, as the cubes are looked up.
    code = np.random.default_rng(5).random((40, 200, 3)).astype(np.float32)
    laid_over = film_sims._sample_cube(
        film_sims._sample_cube(code, film_sims.official_cube("provia")), film_sims.clut_cube(sim)
    )
    # The scene cube is the scan sampled at Provia's 65 nodes: between them it
    # is smoother than the scan, which shows in the most saturated colours.
    off = np.abs(film_sims._sample_cube(code, cube) - laid_over)
    assert off.mean() < 0.005 and np.percentile(off, 99) < 0.06, sim


@pytest.mark.parametrize("sim", _CLUT)
def test_a_film_scan_on_a_display_picture_keeps_its_own_black_and_white(sim):
    cube = film_sims._sim_cube(sim)
    scan = film_sims.clut_cube(sim)
    assert cube.shape == (33, 33, 33, 3)
    grey = cube[np.arange(33), np.arange(33), np.arange(33)] @ _LUMA
    # The ends are the scan's - a faded instant film stays faded - and what
    # lies between runs from one to the other.
    assert abs(grey[0] - scan[0, 0, 0] @ _LUMA) < 0.02 and abs(grey[-1] - scan[-1, -1, -1] @ _LUMA) < 0.03, sim
    assert np.all(np.diff(grey) > -1e-3), sim


def test_clicking_through_the_film_scans_keeps_only_a_few_cubes():
    scene = np.full((2, 2, 3), 0.2, np.float32)
    for sim in _CLUT[:12]:
        film_sims.apply_official(scene, sim, 1.0)
    assert film_sims._clut_scene_cube.cache_info().currsize <= film_sims._CLUT_SCENE_CACHE
    assert len(film_sims._atlases) <= film_sims._ATLAS_CACHE


def test_a_film_scan_without_its_cube_leaves_the_picture_alone(measured_dir):
    arr = _srgb_image()
    assert film_sims.apply_film_sim(arr, "kodak_tri_x_400") is arr
    adj = develop.normalize({"film_sim": "kodak_tri_x_400", "process": "5"})
    assert film_sims.official_sim(adj, True) is None


# --- film looks keep to the simulations' tone (film_sims._film_factors) --------

_FILM = _ANALOG + _CLUT


def _still_ramp(sim: str) -> np.ndarray:
    """Display luma of a grey ramp from five stops under metered middle grey
    to sensor clipping."""
    ramp = _grey(0.097 * 2.0 ** np.linspace(-5.0, 3.3, 60))
    return film_sims.apply_official(ramp, sim, 1.0)[0] @ _LUMA


@pytest.fixture()
def film_tone(monkeypatch):
    def set_tone(tone: float) -> None:
        monkeypatch.setattr(film_sims, "_FILM_TONE", tone)
        film_sims._film_factors.cache_clear()

    yield set_tone
    film_sims._film_factors.cache_clear()


def test_a_film_look_is_most_of_the_way_on_provias_tone_curve(film_tone):
    provia = _still_ramp("provia")
    # The stocks on their own curves: a consumer negative, a high-key and a
    # hard black & white scan are far off the standard picture.
    film_tone(0.0)
    own = {sim: float(np.abs(_still_ramp(sim) - provia).max()) for sim in _FILM}
    assert own["fujifilm_xtra_400"] > 0.08 and own["agfa_apx_100"] > 0.2 and own["rollei_retro_80s"] > 0.12
    # All the way there, a look whose black and white are the display's has
    # Provia's grey ramp.
    film_tone(1.0)
    for sim in ("fujifilm_xtra_400", "kodak_portra_400", "kodak_vision3_500t", "rollei_ortho_25"):
        assert np.abs(_still_ramp(sim) - provia).max() < 0.03, sim


@pytest.mark.parametrize("sim", _FILM)
def test_a_film_looks_tone_stays_near_the_standard_picture(sim):
    off = np.abs(_still_ramp(sim) - _still_ramp("provia"))
    # What is left is a quarter of the stock's own curve (the high-key scans
    # are 0.2 and more off on their own), and the black and white a scan has
    # of its own.
    cube = film_sims._scene_cube(sim, True)
    ends = max(float(cube[0, 0, 0] @ _LUMA), 1.0 - float(cube[-1, -1, -1] @ _LUMA))
    assert off.max() < 0.08 + ends, sim
    # Middle grey itself, unless the scan's ends are in the way - or its grey
    # is as blue as cross-processed Superia's, where the luma of the code
    # values is no longer the luminance the curve is matched in.
    if sim not in _FADED | {"fuji_superia_200_xpro"}:
        assert off[np.argmin(np.abs(np.linspace(-5.0, 3.3, 60)))] < 0.06, sim


def test_a_film_look_keeps_its_colour_under_the_shared_tone_curve():
    lin = (np.random.default_rng(31).random((1, 400, 3)) * 0.5).astype(np.float32)
    provia = film_sims.apply_official(lin, "provia", 1.0)
    for sim in ("kodak_portra_400", "kodak_kodachrome_64", "fuji_velvia_50"):
        assert np.abs(film_sims.apply_official(lin, sim, 1.0) - provia).mean() > 0.01, sim


def test_a_frame_taller_than_one_band_is_the_same_picture_under_a_film_look(monkeypatch):
    lin = np.random.default_rng(32).random((40, 12, 3)).astype(np.float32) * 1.4
    whole = film_sims.apply_official(lin, "kodak_portra_400", 1.0)
    monkeypatch.setattr(film_sims, "_SAMPLE_BAND_ROWS", 16)
    # A tolerance, not equality: cv2.transform rounds by position on x86.
    np.testing.assert_allclose(film_sims.apply_official(lin, "kodak_portra_400", 1.0), whole, atol=1e-4)
