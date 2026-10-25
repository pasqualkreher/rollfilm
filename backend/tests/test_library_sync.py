"""The library sync never removes a photo on its own.

A managed file that is not where its row says - the drive not mounted, the
folder moved in Finder, a permissions hiccup - used to cost the photo its row,
and with it the stars, tags, albums and edits. Now the row is marked
(images.missing_since), the next sync that finds the file again clears the
mark, and removing the entries is the user's step. Above a threshold the sync
marks nothing at all: a library that lost a twentieth of itself since the
last look has not lost it.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import maintenance
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
    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda *a, **k: None)
    maintenance._last_sync_abort["missing"] = 0
    return root


def _add(db: Session, library: Path, name: str, content: bytes, rating: int = 0) -> Image:
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
        rating=rating,
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def test_a_vanished_file_is_marked_not_removed(db, library):
    gone = _add(db, library, "gone.jpg", b"one", rating=4)
    (library / gone.file_path).unlink()
    _add(db, library, "kept.jpg", b"two")

    result = maintenance.sync_db_with_library(db, 1)

    assert result["missing_files"] == 1
    assert result["missing_total"] == 1
    assert result["removed_missing_files"] == 0
    row = db.get(Image, "gone.jpg")
    assert row is not None and row.missing_since is not None
    assert row.rating == 4
    assert db.get(Image, "kept.jpg").missing_since is None


def test_a_file_that_comes_back_is_unmarked(db, library):
    gone = _add(db, library, "gone.jpg", b"one")
    path = library / gone.file_path
    path.unlink()
    maintenance.sync_db_with_library(db, 1)
    assert db.get(Image, "gone.jpg").missing_since is not None

    path.write_bytes(b"one")
    result = maintenance.sync_db_with_library(db, 1)

    assert result["recovered_files"] == 1
    assert result["missing_total"] == 0
    assert db.get(Image, "gone.jpg").missing_since is None


def test_a_file_moved_in_finder_is_still_followed(db, library):
    moved = _add(db, library, "moved.jpg", b"same bytes")
    old = library / moved.file_path
    new = library / "2026" / "elsewhere" / "renamed.jpg"
    new.parent.mkdir(parents=True)
    old.rename(new)

    result = maintenance.sync_db_with_library(db, 1)

    assert result["renamed_files_followed"] == 1
    assert result["missing_files"] == 0
    row = db.get(Image, "moved.jpg")
    assert row.file_path == "2026/elsewhere/renamed.jpg"
    assert row.missing_since is None


def test_too_many_missing_at_once_marks_nothing(db, library, monkeypatch):
    monkeypatch.setattr(maintenance, "MISSING_ABORT_MIN", 2)
    rows = [_add(db, library, f"p{i}.jpg", bytes([i]) * 8) for i in range(10)]
    for row in rows[:5]:
        (library / row.file_path).unlink()

    result = maintenance.sync_db_with_library(db, 1)

    assert result["too_many_missing"] == 5
    assert result["missing_files"] == 0
    assert all(db.get(Image, row.id).missing_since is None for row in rows)
    assert all(db.get(Image, row.id) is not None for row in rows)
    status = maintenance.missing_files_status(db, 1)
    assert status["count"] == 0
    assert status["sync_aborted_missing"] == 5


def test_already_marked_rows_do_not_count_towards_the_threshold(db, library, monkeypatch):
    monkeypatch.setattr(maintenance, "MISSING_ABORT_MIN", 2)
    rows = [_add(db, library, f"p{i}.jpg", bytes([i]) * 8) for i in range(6)]
    # Two go first, under the limit: marked.
    for row in rows[:2]:
        (library / row.file_path).unlink()
    assert maintenance.sync_db_with_library(db, 1)["missing_files"] == 2
    # Then one more: still under the limit on its own, although three are
    # missing in all.
    (library / rows[2].file_path).unlink()
    result = maintenance.sync_db_with_library(db, 1)
    assert result["too_many_missing"] == 0
    assert result["missing_files"] == 1
    assert result["missing_total"] == 3
    assert maintenance.missing_files_status(db, 1)["sync_aborted_missing"] == 0


def test_removing_the_missing_entries_is_the_users_step(db, library):
    gone = _add(db, library, "gone.jpg", b"one")
    (library / gone.file_path).unlink()
    kept = _add(db, library, "kept.jpg", b"two")
    maintenance.sync_db_with_library(db, 1)

    assert maintenance.remove_missing_images(db, 1) == 1
    assert db.get(Image, "gone.jpg") is None
    assert db.get(Image, kept.id) is not None
    assert maintenance.missing_files_status(db, 1)["count"] == 0


def test_virtual_copies_of_a_missing_photo_stay_with_it(db, library):
    source = _add(db, library, "src.jpg", b"one")
    copy = Image(
        id="src-vc",
        owner_id=1,
        file_path=f"{source.file_path}#vc-1",
        original_filename="src.jpg",
        file_hash=source.file_hash,
        file_type=FileType.jpeg,
        file_size=source.file_size,
        virtual_of_image_id=source.id,
    )
    db.add(copy)
    db.commit()
    (library / source.file_path).unlink()

    result = maintenance.sync_db_with_library(db, 1)

    assert result["missing_files"] == 1
    assert db.get(Image, "src-vc") is not None
    assert maintenance.remove_missing_images(db, 1) == 1
    assert db.get(Image, "src-vc") is None


def test_the_startup_sync_does_not_ask_every_photo_for_its_thumbnails(db, library, monkeypatch):
    """25,000 lookups in the cache folder were 130 s on a USB drive: the
    startup sync leaves missing thumbnails to the queue's journal, Settings'
    sync still looks."""
    queued: list[str] = []
    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda image_id, path: queued.append(image_id))
    _add(db, library, "a.jpg", b"one")
    assert maintenance.sync_db_with_library(db, 1, check_derivatives=False)["thumbnails_queued"] == 0
    assert queued == []
    assert maintenance.sync_db_with_library(db, 1)["thumbnails_queued"] == 1
    assert queued == ["a.jpg"]
