"""Stopping the long maintenance runs from the title bar's task dock.

A sync looks at its flag while it reads the folder and once more right before
it removes anything: a stopped sync has changed nothing. The same run cannot
start twice. The other runs' flags (rebuild, repair, sidecars, a source scan)
are plain events the routes set; their loops are exercised by the app, not
here - they spawn exiftool helpers - so only the bookkeeping is checked.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import maintenance, sources
from app.services.hashing import sha256_file


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    cache = tmp_path / "thumbs"
    cache.mkdir()
    monkeypatch.setattr(settings, "thumbnail_cache_root", cache)
    return root


def _add(db: Session, library: Path, name: str, content: bytes) -> Image:
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True, exist_ok=True)
    (day / name).write_bytes(content)
    image = Image(
        id=name,
        owner_id=1,
        file_path=str((day / name).relative_to(library)),
        original_filename=name,
        file_hash=sha256_file(day / name),
        file_type=FileType.jpeg,
        file_size=len(content),
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def test_a_sync_stopped_before_the_sweep_removes_nothing(db, library, monkeypatch):
    """The flag is set before the folder is read: the row of a file that is
    gone stays, and the result says so."""
    gone = _add(db, library, "gone.jpg", b"one")
    (library / gone.file_path).unlink()
    _add(db, library, "kept.jpg", b"two")

    maintenance.request_sync_cancel()
    # The run clears the flag when it starts - set it again from inside the
    # sweep, the way the cancel route would while the folder is being read.
    real_rglob = Path.rglob

    def rglob_then_stop(self, pattern):
        maintenance.request_sync_cancel()
        return real_rglob(self, pattern)

    monkeypatch.setattr(Path, "rglob", rglob_then_stop)
    result = maintenance.sync_db_with_library(db, 1)

    assert result["cancelled"] is True
    assert result["removed_missing_files"] == 0
    assert db.query(Image).count() == 2


def test_a_sync_stopped_before_the_removal_keeps_the_rows(db, library, monkeypatch):
    """Stopped after the folder was read but before rows go: nothing removed,
    though a renamed file it had already followed keeps its new path."""
    moved = _add(db, library, "moved.jpg", b"same bytes")
    old = library / moved.file_path
    old.rename(old.with_name("renamed.jpg"))
    gone = _add(db, library, "gone.jpg", b"other")
    (library / gone.file_path).unlink()

    real_follow = maintenance._follow_renamed_files

    def follow_then_stop(missing, untracked):
        out = real_follow(missing, untracked)
        maintenance.request_sync_cancel()
        return out

    monkeypatch.setattr(maintenance, "_follow_renamed_files", follow_then_stop)
    result = maintenance.sync_db_with_library(db, 1)

    assert result["cancelled"] is True
    assert result["renamed_files_followed"] == 1
    assert result["removed_missing_files"] == 0
    assert db.query(Image).count() == 2
    assert db.get(Image, "moved.jpg").file_path.endswith("renamed.jpg")


def test_a_sync_that_runs_through_reports_not_cancelled(db, library):
    gone = _add(db, library, "gone.jpg", b"one")
    (library / gone.file_path).unlink()
    # A stale flag from an earlier stop must not stop this run.
    maintenance.request_sync_cancel()

    result = maintenance.sync_db_with_library(db, 1)

    assert result["cancelled"] is False
    assert result["removed_missing_files"] == 1
    assert db.query(Image).count() == 0


def test_a_second_sync_is_refused_while_one_runs(db, library):
    assert maintenance.sync_active() is False
    assert maintenance._sync_active.acquire(blocking=False)
    try:
        assert maintenance.sync_active() is True
        with pytest.raises(maintenance.AlreadyRunning):
            maintenance.sync_db_with_library(db, 1)
    finally:
        maintenance._sync_active.release()
    assert maintenance.sync_active() is False


def test_the_other_runs_flags_are_set_and_cleared():
    maintenance.request_rebuild_cancel()
    assert maintenance._rebuild_cancel.is_set()
    maintenance._rebuild_cancel.clear()
    maintenance.request_repair_cancel()
    assert maintenance._repair_cancel.is_set()
    maintenance._repair_cancel.clear()
    assert maintenance.get_repair_progress()["active"] is False


def test_a_scan_cancel_only_marks_a_running_scan():
    """Asking an idle source to stop is a no-op; a running one is marked, and
    starting the next scan forgets the mark."""
    sources.request_scan_cancel("idle")
    assert sources._cancel_requested("idle") is False

    sources._update_status("busy", running=True)
    sources.request_scan_cancel("busy")
    assert sources._cancel_requested("busy") is True
    assert sources.get_scan_status("busy")["cancelled"] is False

    with sources._status_lock:
        sources._scan_status["busy"] = {**sources._blank_status(), "running": True}
        sources._scan_cancel.discard("busy")
    assert sources._cancel_requested("busy") is False
    with sources._status_lock:
        sources._scan_status.pop("busy", None)
