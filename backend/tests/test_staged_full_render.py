"""The import review lightbox loads full-resolution pixels once you zoom in.

Culling an import is where critical focus gets judged, and the review's preview
tops out at STAGED_PREVIEW_PX - zooming past fit was magnifying 2048px of it.
The lightbox now upgrades to the staged file's own pixels on zoom, the same way
the library's photo view does.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import threading
import time
from pathlib import Path

import pytest
from PIL import Image as PILImage

from app.config import settings
from app.services import import_pipeline
from app.services.import_pipeline import (
    STAGED_PREVIEW_PX,
    StagedFullSuperseded,
    render_review_derivatives,
    render_staged_full,
    staged_full_render_path,
    staged_preview_path,
    staged_thumb_dir,
)


@pytest.fixture()
def staged(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "import_staging_root", tmp_path / "staging")
    thumb_dir = staged_thumb_dir("session-1")
    thumb_dir.mkdir(parents=True)
    return thumb_dir


def _photo(path: Path, size=(3000, 2000)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", size, "teal").save(path, "JPEG")
    return path


def test_the_full_render_keeps_the_photos_own_pixels(staged, tmp_path):
    """The point of the whole thing: the preview is capped at 2048px, the full
    render is the source's real size."""
    source = _photo(tmp_path / "src.jpg")
    render_review_derivatives(source, "file-1", staged, is_raw=False)
    assert max(PILImage.open(staged_preview_path(staged, "file-1")).size) == STAGED_PREVIEW_PX

    out = render_staged_full(source, "file-1", staged)
    assert PILImage.open(out).size == (3000, 2000)


def test_the_render_is_cached_for_the_next_zoom(staged, tmp_path):
    source = _photo(tmp_path / "src.jpg", size=(800, 600))
    out = render_staged_full(source, "file-2", staged)
    assert out == staged_full_render_path(staged, "file-2")

    # Re-zooming the same photo must be a file serve, not a second render - so
    # a cached file is returned without the source being touched at all.
    source.unlink()
    assert render_staged_full(source, "file-2", staged) == out


def test_superseded_at_entry_never_renders(staged, tmp_path):
    """A request that is already stale on arrival bails before the decode -
    the missing source would blow up inside the render, which is the point."""
    with pytest.raises(StagedFullSuperseded):
        render_staged_full(tmp_path / "missing.jpg", "file-3", staged, is_stale=lambda: True)


def test_a_cached_render_is_served_even_when_stale(staged, tmp_path):
    """Staleness only ever skips a RENDER; an existing file is one cheap serve."""
    out = staged_full_render_path(staged, "file-4")
    out.write_bytes(b"jpeg-bytes")
    assert render_staged_full(tmp_path / "missing.jpg", "file-4", staged, is_stale=lambda: True) == out


def test_superseded_while_queued_on_the_render_lock(staged, tmp_path):
    """The case that matters: a render that went stale WHILE waiting for the
    single render slot (the user zoomed on to another photo) must bail after
    acquiring it, instead of making the newest zoom wait behind it."""
    source = _photo(tmp_path / "src.jpg", size=(400, 300))
    stale = threading.Event()
    lock_held = threading.Event()
    release = threading.Event()

    def holder():
        with import_pipeline._staged_full_render_lock:
            lock_held.set()
            assert release.wait(5)

    outcome: dict[str, bool] = {}

    def worker():
        try:
            render_staged_full(source, "file-5", staged, is_stale=stale.is_set)
        except StagedFullSuperseded:
            outcome["superseded"] = True
        except Exception:
            outcome["superseded"] = False

    t_hold = threading.Thread(target=holder)
    t_hold.start()
    assert lock_held.wait(5)

    t_work = threading.Thread(target=worker)
    t_work.start()
    # Let the worker pass its entry check and block on the lock, then mark it
    # stale and let it through.
    time.sleep(0.2)
    stale.set()
    release.set()
    t_work.join(5)
    t_hold.join(5)
    assert outcome.get("superseded") is True
    assert not staged_full_render_path(staged, "file-5").exists()
