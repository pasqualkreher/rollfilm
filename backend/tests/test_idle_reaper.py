"""Memory the editor and the models hold is given back once they sit idle.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import time

import numpy as np

from app.services import embeddings, idle_reaper, masks, segmentation, thumbnails


def _fill_editor_caches() -> None:
    with thumbnails._base_cache_lock:
        thumbnails._BASE_CACHE[("img", "path", 1, 1600)] = (np.zeros((4, 4, 3), np.float16), 1.0)
    thumbnails._tile_cache_put("tile", np.zeros((4, 4, 3), np.float32))
    thumbnails._GRAIN_CACHE[(4, 4, 1.0, 0.5, 0.5)] = np.zeros((4, 4), np.float32)


def test_caches_survive_while_the_editor_is_busy(monkeypatch):
    _fill_editor_caches()
    thumbnails.note_editor_activity()
    assert thumbnails.release_editor_caches_if_idle(60.0) is False
    assert not thumbnails.editor_caches_empty()


def test_caches_are_released_after_the_idle_period(monkeypatch):
    _fill_editor_caches()
    monkeypatch.setattr(thumbnails, "_editor_last_activity", time.monotonic() - 1000.0)
    assert thumbnails.release_editor_caches_if_idle(60.0) is True
    assert thumbnails.editor_caches_empty()
    # Nothing left: a second sweep reports nothing to do.
    assert thumbnails.release_editor_caches_if_idle(60.0) is False


def test_the_sweep_clears_the_mask_fields_with_the_bases(monkeypatch):
    _fill_editor_caches()
    with masks._field_cache_lock:
        masks._FIELD_CACHE[("t", "{}", 4, 4, None)] = np.zeros((4, 4), np.float32)
    monkeypatch.setattr(thumbnails, "_editor_last_activity", time.monotonic() - 1000.0)
    idle_reaper.sweep_once()
    assert thumbnails.editor_caches_empty()
    assert not masks._FIELD_CACHE


def test_models_unload_only_when_loaded_and_idle(monkeypatch):
    # Nothing loaded: nothing to do, and no torch import for it.
    monkeypatch.setattr(segmentation, "_model", None)
    monkeypatch.setattr(embeddings, "_model", None)
    assert segmentation.unload_if_idle(0.0) is False
    assert embeddings.unload_if_idle(0.0) is False

    monkeypatch.setattr(segmentation, "_model", object())
    monkeypatch.setattr(segmentation, "_last_used", time.monotonic())
    assert segmentation.unload_if_idle(600.0) is False  # used just now
    monkeypatch.setattr(segmentation, "_last_used", time.monotonic() - 1000.0)
    assert segmentation.unload_if_idle(600.0) is True
    assert segmentation._model is None

    monkeypatch.setattr(embeddings, "_model", object())
    monkeypatch.setattr(embeddings, "_last_used", time.monotonic() - 1000.0)
    assert embeddings.unload_if_idle(600.0) is True
    assert embeddings._model is None
