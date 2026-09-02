"""The editor stays fluid by keeping everything else out of its way.

Three mechanisms, all added after a session where scrub frames cost 20-28ms on
an idle machine but the app still janked under real use: bulk background work
(the thumbnail rebuild, the post-save full.jpg warmer) yields while the editor
renders; concurrent decodes of the same file are serialised so the frame the
user waits on never shares its cores with a warm-up; and the base cache is
bounded by bytes instead of entry count so it can't balloon on an 8GB machine.
"""

import threading
import time
from datetime import datetime

import numpy as np
import pytest
from PIL import Image as PILImage

from app.db.models import FileType, Image
from app.services import develop, thumbnails


@pytest.fixture()
def photo(tmp_path, monkeypatch):
    path = tmp_path / "shot.jpg"
    ys, xs = np.mgrid[0:180, 0:240].astype(np.float32)
    g = 0.5 + 0.3 * np.sin(xs / 11.0) * np.cos(ys / 9.0)
    rgb = np.dstack([g, g * 0.92 + 0.04, g * 0.85 + 0.08])
    PILImage.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").save(path, "JPEG")

    image = Image(
        id="yield-test", owner_id=1, file_path=str(path), original_filename="shot.jpg",
        file_hash="hash", file_type=FileType.jpeg, file_size=path.stat().st_size,
        taken_at=datetime(2026, 9, 1, 12, 0, 0), width=240, height=180,
    )
    monkeypatch.setattr("app.services.filesystem.resolve_image_path", lambda img: path)
    thumbnails.clear_editor_base_caches()
    return image


@pytest.fixture(autouse=True)
def _quiet_editor():
    """Every test starts and ends with an editor that has never rendered."""
    thumbnails._editor_last_activity = 0.0
    yield
    thumbnails._editor_last_activity = 0.0


# --- The activity signal background work consults ----------------------------


def test_a_preview_render_marks_the_editor_active(photo):
    assert not thumbnails.editor_recently_active(60.0)
    thumbnails.render_editor_preview_bytes(
        photo, 0, None, develop.normalize(None), scrub=True
    )
    assert thumbnails.editor_recently_active(60.0)


def test_the_signal_goes_quiet_after_the_window():
    thumbnails.note_editor_activity()
    assert thumbnails.editor_recently_active(60.0)
    thumbnails._editor_last_activity = time.monotonic() - 5.0
    assert not thumbnails.editor_recently_active(4.0)
    assert thumbnails.editor_recently_active(6.0)


def test_the_full_warmer_holds_back_while_the_editor_renders(photo, monkeypatch):
    """The post-save full.jpg render used to start 4s after every save, right
    beside the session that triggered it. Now it waits for a pause in editing;
    the pending set keeps the work while it waits."""
    monkeypatch.setattr(thumbnails, "_FULL_WARM_DELAY_S", 0.01)
    monkeypatch.setattr(thumbnails, "_FULL_WARM_POLL_S", 0.01)
    rendered = threading.Event()
    monkeypatch.setattr(
        thumbnails, "generate_full", lambda image, is_stale=None: rendered.set()
    )

    class _Db:
        def get(self, model, image_id):
            return photo

        def close(self):
            pass

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: _Db())

    thumbnails.note_editor_activity()
    thumbnails.warm_full_cache(photo.id)
    assert not rendered.wait(timeout=0.3), "warmed while the editor was active"

    thumbnails._editor_last_activity = 0.0
    assert rendered.wait(timeout=5.0), "never warmed once the editor went quiet"


def test_the_rebuild_worker_waits_for_the_same_pause(monkeypatch):
    from app.services import maintenance

    monkeypatch.setattr(maintenance, "_REBUILD_EDITOR_IDLE_S", 0.15)
    thumbnails.note_editor_activity()
    started = time.monotonic()
    while maintenance.editor_recently_active(maintenance._REBUILD_EDITOR_IDLE_S):
        time.sleep(0.02)
    # It waited out the window instead of sailing through.
    assert time.monotonic() - started >= 0.1


# --- Decodes of the same file never run beside each other ---------------------


def test_the_warm_up_waits_for_an_inflight_decode():
    key = ("img", "/p/shot.jpg", 1, thumbnails.EDITOR_PREVIEW_PX)
    ev = threading.Event()
    with thumbnails._base_cache_lock:
        thumbnails._BASE_INFLIGHT[key] = ev

    def finish():
        time.sleep(0.05)
        with thumbnails._base_cache_lock:
            thumbnails._BASE_INFLIGHT.pop(key, None)
        ev.set()

    threading.Thread(target=finish, daemon=True).start()
    started = time.monotonic()
    thumbnails._wait_for_same_image_decodes("img", "/p/shot.jpg", 1)
    assert time.monotonic() - started >= 0.04


def test_a_smaller_ask_derives_from_a_bigger_decode_in_flight(photo, monkeypatch):
    """The cold-open triple decode: while the ultra base is decoding, a settle
    for a size below must wait and derive from it, not start a third decode of
    the same file."""
    from app.services import raw as raw_service

    mtime = thumbnails.editor_mtime_ns(photo)
    decodes = []
    real = raw_service.load_linear_base

    def counting(path, **kwargs):
        decodes.append(kwargs.get("max_px"))
        time.sleep(0.15)  # long enough for the smaller ask to arrive mid-decode
        return real(path, **kwargs)

    monkeypatch.setattr(raw_service, "load_linear_base", counting)

    results = {}

    def big():
        results["big"] = thumbnails._cached_editor_base(
            photo.id, photo.file_path, mtime, thumbnails.ULTRA_EDITOR_PREVIEW_PX
        )

    t = threading.Thread(target=big)
    t.start()
    time.sleep(0.05)  # the ultra decode is now in flight
    small = thumbnails._cached_editor_base(
        photo.id, photo.file_path, mtime, thumbnails.FULL_EDITOR_PREVIEW_PX
    )
    t.join(timeout=10)
    assert decodes == [thumbnails.ULTRA_EDITOR_PREVIEW_PX], (
        f"expected one decode (the ultra base), got {decodes}"
    )
    assert small[0].shape[0] > 0


# --- The base cache is bounded by bytes ---------------------------------------


def test_the_base_cache_evicts_by_bytes_oldest_first(photo, monkeypatch):
    mtime = thumbnails.editor_mtime_ns(photo)
    first = thumbnails._cached_editor_base(
        photo.id, photo.file_path, mtime, thumbnails.EDITOR_PREVIEW_PX
    )
    # Room for barely more than one entry: the next insert must push this one out.
    monkeypatch.setattr(thumbnails, "_BASE_CACHE_MAX_BYTES", first[0].nbytes + 1)
    thumbnails._cached_editor_base(
        photo.id, photo.file_path, mtime, thumbnails.SCRUB_PREVIEW_PX
    )
    with thumbnails._base_cache_lock:
        keys = list(thumbnails._BASE_CACHE)
    assert (photo.id, photo.file_path, mtime, thumbnails.SCRUB_PREVIEW_PX) in keys
    assert (photo.id, photo.file_path, mtime, thumbnails.EDITOR_PREVIEW_PX) not in keys


def test_the_newest_entry_survives_even_over_budget(photo, monkeypatch):
    """A budget smaller than a single base must not evict the base that was
    just decoded - the render about to use it comes first, the budget second."""
    monkeypatch.setattr(thumbnails, "_BASE_CACHE_MAX_BYTES", 1)
    mtime = thumbnails.editor_mtime_ns(photo)
    thumbnails._cached_editor_base(
        photo.id, photo.file_path, mtime, thumbnails.EDITOR_PREVIEW_PX
    )
    with thumbnails._base_cache_lock:
        assert len(thumbnails._BASE_CACHE) == 1
