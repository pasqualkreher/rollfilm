"""Superseded editor-preview renders are dropped, not rendered.

The editor client aborts a stale preview fetch the instant a newer edit state
exists, but an aborted request's thread still runs its render to completion -
and the full/native tiers additionally queue on _full_render_lock for seconds
each. render_editor_preview_bytes therefore takes an `is_stale` callable and
bails with PreviewSuperseded before the expensive work: at entry, and again
right after acquiring the render lock (where stale settle renders used to pile
up and keep the CPU pinned during a busy editing session).

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import threading
import time

import pytest

from app.services import develop, thumbnails


class _FakeImage:
    def __init__(self, image_id: str):
        self.id = image_id


def test_superseded_at_entry_never_touches_the_file():
    """A request that is already stale on arrival must bail before resolving
    the image path (the fake has no file at all - reaching the decode would
    blow up, which is the point)."""
    with pytest.raises(thumbnails.PreviewSuperseded):
        thumbnails.render_editor_preview_bytes(
            _FakeImage("img-stale"),
            rotation=0,
            crop=None,
            adjustments=develop.normalize(None),
            is_stale=lambda: True,
        )


def test_superseded_while_queued_on_the_full_render_lock(monkeypatch, tmp_path):
    """The important case: a full-quality settle render that went stale WHILE
    waiting for _full_render_lock must bail right after acquiring it instead of
    rendering a frame nobody will look at."""
    from app.services import filesystem

    # The path resolves before the lock; the decode would only happen after the
    # stale check, which must fire first - so a nonexistent file is fine.
    monkeypatch.setattr(filesystem, "resolve_image_path", lambda image: tmp_path / "absent.jpg")
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
            thumbnails.render_editor_preview_bytes(
                _FakeImage("img-queued"),
                rotation=0,
                crop=None,
                adjustments=develop.normalize(None),
                full_quality=True,
                is_stale=stale.is_set,
            )
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
