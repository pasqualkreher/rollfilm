"""The queue writes down whom it still owes a thumbnail, so a quit mid-run
is picked up on the next start without asking every photo's cache folder
(which the startup sync did, 130 s on a USB drive)."""

import json
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.workers import queue


@pytest.fixture()
def held(monkeypatch, tmp_path):
    """The pool replaced by a list (jobs run when the test says), the journal
    and its counters fresh, the cache folder in tmp."""
    jobs: list[tuple] = []

    class _Held:
        def submit(self, fn, *args):
            jobs.append((fn, args))

    monkeypatch.setattr(queue, "_executor", _Held())
    monkeypatch.setattr(queue, "_journal", {})
    monkeypatch.setattr(queue, "_journal_dirty", False)
    monkeypatch.setattr(queue, "_journal_timer", None)
    monkeypatch.setattr(queue, "_pending_derivatives", 0)
    monkeypatch.setattr(queue, "_waiting_jobs", queue.deque())
    monkeypatch.setattr(queue, "_waiting_rerenders", queue.deque())
    monkeypatch.setattr(queue, "schedule_embedding_backfill", lambda: None)
    monkeypatch.setattr(queue, "generate_derivatives", lambda image_id, path: None)
    monkeypatch.setattr(queue, "has_derivatives", lambda image_id: False)
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    yield jobs
    with queue._pending_derivatives_lock:
        if queue._journal_timer is not None:
            queue._journal_timer.cancel()


def _journal_ids() -> list[str]:
    path = settings.thumbnail_cache_root / "pending-derivatives.json"
    return json.loads(path.read_text()) if path.exists() else []


def test_a_queued_photo_is_written_down_until_its_job_is_through(held, tmp_path):
    queue.enqueue_post_import("a", tmp_path / "a.jpg")
    queue.enqueue_post_import("b", tmp_path / "b.jpg")
    queue.flush_derivative_journal()
    assert _journal_ids() == ["a", "b"]
    fn, args = held.pop(0)
    fn(*args)  # "a" is through
    queue.flush_derivative_journal()
    assert _journal_ids() == ["b"]
    fn, args = held.pop(0)
    fn(*args)
    queue.flush_derivative_journal()
    assert _journal_ids() == []
    assert not (settings.thumbnail_cache_root / "pending-derivatives.json").exists()


def test_the_next_start_queues_only_what_is_still_owed(held, tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'library.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add(User(id=1, username="local"))
    db.commit()
    library = tmp_path / "library"
    library.mkdir()
    for image_id, deleted in (("owed", None), ("trashed", datetime(2026, 7, 2)), ("unreachable", None)):
        if image_id != "unreachable":
            (library / f"{image_id}.jpg").write_bytes(b"x")
        db.add(Image(
            id=image_id, owner_id=1, file_path=f"{image_id}.jpg", original_filename=f"{image_id}.jpg",
            file_hash=image_id, file_type=FileType.jpeg, file_size=1, taken_at=datetime(2026, 7, 1),
            deleted_at=deleted,
        ))
    db.commit()
    db.close()
    monkeypatch.setattr(queue, "SessionLocal", factory)
    monkeypatch.setattr(queue, "resolve_image_path", lambda image: library / image.file_path)
    path = settings.thumbnail_cache_root / "pending-derivatives.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(["owed", "trashed", "unreachable", "gone"]))

    assert queue.resume_derivative_journal() == 1
    assert queue.derivatives_pending() == 1
    # The journal now holds just what is queued again.
    assert _journal_ids() == ["owed"]


def test_no_journal_is_nothing_to_resume(held):
    assert queue.resume_derivative_journal() == 0
