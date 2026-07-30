"""Superseded 100%-zoom full renders are dropped, not rendered.

Same mechanism as the editor previews (see test_editor_preview_superseded):
the lightbox client aborts a /full fetch the moment the user pages on, but the
request's thread would still render ~14s of full-resolution frame while
holding _full_render_lock - and during zoom-and-page browsing those stale
renders queued up and stalled everything else on the lock. generate_full takes
an `is_stale` callable and bails with PreviewSuperseded before the expensive
work; an already-cached full.jpg is served regardless of staleness.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import threading
import time

import pytest

from app.services import thumbnails


class _FakeImage:
    def __init__(self, image_id: str):
        self.id = image_id


def test_superseded_at_entry_never_renders():
    """A request that is already stale on arrival (and has no cached file)
    must bail before touching the image - the fake would blow up inside
    render_full_from_stored_edits, which is the point."""
    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.generate_full(_FakeImage("full-stale"), is_stale=lambda: True)


def test_cached_file_is_served_even_when_stale(tmp_path):
    """Staleness only ever skips a RENDER: when full.jpg already exists the
    request is one cheap file serve and must succeed regardless."""
    image = _FakeImage("full-cached")
    out = thumbnails.derivative_dir(image.id) / "full.jpg"
    out.write_bytes(b"jpeg-bytes")
    assert thumbnails.generate_full(image, is_stale=lambda: True) == out


def test_superseded_while_queued_on_the_full_render_lock():
    """The important case: a full render that went stale WHILE waiting for
    _full_render_lock (the user zoomed a newer photo) must bail right after
    acquiring it instead of rendering a frame nobody will look at."""
    stale = threading.Event()
    lock_held = threading.Event()
    release = threading.Event()

    def holder():
        with thumbnails._full_render_lock:
            lock_held.set()
            assert release.wait(5)

    outcome: dict[str, bool] = {}

    def worker():
        try:
            thumbnails.generate_full(_FakeImage("full-queued"), is_stale=stale.is_set)
        except thumbnails.PreviewSuperseded:
            outcome["superseded"] = True
        except Exception:
            outcome["superseded"] = False

    t_hold = threading.Thread(target=holder)
    t_hold.start()
    assert lock_held.wait(5)

    t_work = threading.Thread(target=worker)
    t_work.start()
    # Give the worker time to pass its entry check and block on the lock, then
    # mark it stale and let it through.
    time.sleep(0.2)
    stale.set()
    release.set()
    t_work.join(5)
    t_hold.join(5)
    assert outcome.get("superseded") is True
