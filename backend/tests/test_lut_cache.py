"""The film looks' cubes live in one byte-bounded cache instead of a pile of
unbounded lru_caches, and the idle reaper lets them go.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import time

import numpy as np

from app.services import film_sims, idle_reaper


def setup_function() -> None:
    film_sims.release()


def test_a_hit_is_the_same_object_and_defaults_share_the_entry():
    a = film_sims._sim_cube("velvia")
    assert a is film_sims._sim_cube("velvia", False)
    assert a is film_sims._sim_cube("velvia", measured=False)
    assert sum(1 for key in film_sims._lut_cache if key[0] == "_sim_cube") == 1
    # has_measured compares by identity: a look without a measured cube hands
    # the recipe's cube back under both keys.
    assert film_sims.has_measured("velvia") is False


def test_none_results_are_cached_too(monkeypatch):
    calls = []
    monkeypatch.setattr(film_sims, "_load_scene_cube", lambda path: calls.append(path))
    assert film_sims.official_cube("velvia") is None
    assert film_sims.official_cube("velvia") is None
    assert len(calls) == 1


def test_the_budget_bounds_the_bytes_and_the_oldest_go_first(monkeypatch):
    cube = film_sims.official_cube("provia")
    assert cube is not None
    monkeypatch.setattr(film_sims, "_LUT_CACHE_MAX_BYTES", cube.nbytes * 2 + 1)
    film_sims.release()
    sims = sorted(film_sims.OFFICIAL_SIMS)[:4]
    for sim in sims:
        assert film_sims.official_cube(sim) is not None
        assert film_sims.lut_cache_bytes() <= cube.nbytes * 2 + 1
    kept = [key[1][0] for key in film_sims._lut_cache]
    assert kept == sims[-2:]
    # A look that was evicted is loaded again - a fresh object, same numbers.
    first = film_sims.official_cube(sims[0])
    assert first is not None and first.shape == cube.shape


def test_cache_clear_only_drops_that_functions_entries():
    film_sims.official_cube("provia")
    film_sims._sim_cube("velvia")
    before = film_sims.lut_cache_bytes()
    film_sims.official_cube.cache_clear()
    assert all(key[0] != "official_cube" for key in film_sims._lut_cache)
    assert any(key[0] == "_sim_cube" for key in film_sims._lut_cache)
    assert 0 < film_sims.lut_cache_bytes() < before


def test_release_empties_the_cache_and_the_atlases():
    cube = film_sims.official_cube("provia")
    film_sims._atlas(cube)
    assert film_sims._atlases and film_sims.lut_cache_bytes() > 0
    film_sims.release()
    assert not film_sims._atlases and film_sims.lut_cache_bytes() == 0
    assert not film_sims._lut_cache


def test_the_idle_release_waits_for_the_quiet_period(monkeypatch):
    assert film_sims.release_if_idle(0.0) is False  # nothing cached
    film_sims.official_cube("provia")
    assert film_sims.release_if_idle(60.0) is False  # used just now
    monkeypatch.setattr(film_sims, "_lut_cache_used_at", time.monotonic() - 1000.0)
    assert film_sims.release_if_idle(60.0) is True
    assert film_sims.lut_cache_bytes() == 0


def test_the_reaper_sweeps_the_looks_with_the_editor_caches(monkeypatch):
    film_sims.official_cube("provia")
    monkeypatch.setattr(film_sims, "_lut_cache_used_at", time.monotonic() - 1000.0)
    idle_reaper.sweep_once()
    assert film_sims.lut_cache_bytes() == 0


def test_the_looks_render_the_same_through_the_new_cache():
    arr = np.random.default_rng(1).random((6, 6, 3)).astype(np.float32)
    first = film_sims.apply_film_sim(arr, "velvia")
    film_sims.release()
    np.testing.assert_array_equal(first, film_sims.apply_film_sim(arr, "velvia"))


def test_an_entry_cap_keeps_only_a_functions_last_few():
    sims = sorted(film_sims.CLUT_SIMS)[: film_sims._CLUT_SCENE_CACHE + 3]
    scene = np.full((2, 2, 3), 0.2, np.float32)
    misses = film_sims._clut_scene_cube.cache_info().misses
    for sim in sims:
        film_sims.apply_official(scene, sim, 1.0)
    info = film_sims._clut_scene_cube.cache_info()
    assert info.currsize == film_sims._CLUT_SCENE_CACHE
    assert info.maxsize == film_sims._CLUT_SCENE_CACHE
    assert info.misses - misses == len(sims)
    kept = [key[1][0] for key in film_sims._lut_cache if key[0] == "_clut_scene_cube"]
    assert kept == sims[-film_sims._CLUT_SCENE_CACHE:]
