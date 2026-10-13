"""The per-image generation locks are a bounded table: the oldest unheld
ones go, a held one never does.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import threading

from app.services import thumbnails


def setup_function() -> None:
    with thumbnails._gen_locks_guard:
        thumbnails._gen_locks.clear()


def test_the_table_keeps_the_most_recent_locks(monkeypatch):
    monkeypatch.setattr(thumbnails, "_GEN_LOCKS_MAX", 3)
    for image_id in "abcde":
        with thumbnails._gen_locked(image_id, None):
            pass
    assert list(thumbnails._gen_locks) == ["c", "d", "e"]
    # Asking again moves a lock to the recent end.
    with thumbnails._gen_locked("c", None):
        pass
    assert list(thumbnails._gen_locks) == ["d", "e", "c"]


def test_a_held_lock_stays_and_is_the_same_object(monkeypatch):
    monkeypatch.setattr(thumbnails, "_GEN_LOCKS_MAX", 2)
    held = threading.Event()
    release = threading.Event()

    def hold() -> None:
        with thumbnails._gen_locked("held", None):
            held.set()
            release.wait(5.0)

    worker = threading.Thread(target=hold)
    worker.start()
    assert held.wait(5.0)
    lock = thumbnails._gen_locks["held"].lock
    for image_id in "abcd":
        with thumbnails._gen_locked(image_id, None):
            pass
    assert "held" in thumbnails._gen_locks
    assert thumbnails._gen_locks["held"].lock is lock
    # A second caller for the same photo waits on that very lock.
    assert thumbnails._gen_lock("held") is lock
    assert not lock.acquire(timeout=0.05)
    release.set()
    worker.join(5.0)
    assert thumbnails._gen_locks["held"].holders == 0


def test_the_lock_is_reentrant_and_the_count_returns_to_zero():
    with thumbnails._gen_locked("x", None):
        with thumbnails._gen_locked("x", 0.1):
            assert thumbnails._gen_locks["x"].holders == 2
    assert thumbnails._gen_locks["x"].holders == 0


def test_a_waiter_that_gives_up_is_not_counted_any_more():
    with thumbnails._gen_locked("busy", None):
        failed = []

        def wait() -> None:
            try:
                with thumbnails._gen_locked("busy", 0.05):
                    pass
            except thumbnails.RenderBusy:
                failed.append(True)

        worker = threading.Thread(target=wait)
        worker.start()
        worker.join(5.0)
        assert failed == [True]
        assert thumbnails._gen_locks["busy"].holders == 1
