"""The import review's lightbox never leaves the user staring at an empty stage.

Opening a card whose preview the background pass hasn't rendered yet renders it
on the request. That wait is bounded now: when every render slot is busy the
route sheds with 503 + Retry-After (the lightbox asks again) instead of parking
a server thread for the length of the queue - a few of those starved the polls
that keep the review alive. And a row analysed before a restart, whose render
job died with the old process, is offered to the background pass again on the
next poll, so its first opening isn't a cold demosaic.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, ImportSession, ImportStagedFile, User
from app.services import import_pipeline
from app.services.import_pipeline import (
    ReviewRenderBusy,
    ensure_session_processing,
    render_review_derivatives,
    render_staged_full,
    staged_preview_path,
    staged_thumb_dir,
)


class _User:
    id = 1


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
def dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "import_staging_root", tmp_path / "staging")
    monkeypatch.setattr(settings, "library_root", tmp_path / "library")
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    (tmp_path / "library").mkdir()
    return tmp_path


def _session(db: Session) -> ImportSession:
    session = ImportSession(owner_id=1, source_path="DCIM")
    db.add(session)
    db.commit()
    return session


def _staged(db: Session, session: ImportSession, name: str, *, processed: bool = True) -> ImportStagedFile:
    staged_dir = settings.import_staging_root / session.id
    staged_dir.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", (640, 480), "teal").save(staged_dir / name, "JPEG")
    row = ImportStagedFile(
        import_session_id=session.id,
        staged_path=f"{session.id}/{name}",
        original_filename=name,
        file_type=FileType.jpeg,
        sha256=f"sha-{name}",
        processed=processed,
        selected=True,
        exif_json="{}",
    )
    db.add(row)
    db.commit()
    db.refresh(session)
    return row


def _photo(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", (800, 600), "teal").save(path, "JPEG")
    return path


# --- the bounded wait ---------------------------------------------------------


def test_a_render_waits_only_as_long_as_it_is_told(dirs, monkeypatch, tmp_path):
    thumb_dir = staged_thumb_dir("s1")
    thumb_dir.mkdir(parents=True)
    source = _photo(tmp_path / "src.jpg")
    gate = threading.BoundedSemaphore(1)
    monkeypatch.setattr(import_pipeline, "RAW_RENDER_SLOTS", gate)

    gate.acquire()  # somebody else's demosaic holds the only slot
    with pytest.raises(ReviewRenderBusy):
        render_review_derivatives(source, "f1", thumb_dir, is_raw=False, slot_timeout=0.05)
    assert not staged_preview_path(thumb_dir, "f1").exists()
    gate.release()

    # The background pass passes no timeout and simply waits its turn.
    render_review_derivatives(source, "f1", thumb_dir, is_raw=False)
    assert staged_preview_path(thumb_dir, "f1").exists()
    # And the slot was handed back afterwards.
    assert gate.acquire(blocking=False)


def test_the_full_render_sheds_while_the_single_slot_is_held(dirs, tmp_path):
    thumb_dir = staged_thumb_dir("s1")
    thumb_dir.mkdir(parents=True)
    source = _photo(tmp_path / "src.jpg")
    with import_pipeline._staged_full_render_lock:
        with pytest.raises(ReviewRenderBusy):
            render_staged_full(source, "f1", thumb_dir, lock_timeout=0.05)
    # Free again: the render goes through.
    assert render_staged_full(source, "f1", thumb_dir, lock_timeout=0.05).exists()


def test_a_busy_slot_answers_the_lightbox_with_503_and_retry_after(db, dirs, monkeypatch):
    session = _session(db)
    row = _staged(db, session, "a.jpg")

    def _busy(*args, **kwargs):
        assert kwargs.get("slot_timeout"), "the route must bound its wait"
        raise ReviewRenderBusy()

    monkeypatch.setattr(routes, "render_review_derivatives", _busy)
    with pytest.raises(HTTPException) as exc:
        routes.get_staged_file_preview(session.id, row.id, db=db, current_user=_User())
    assert exc.value.status_code == 503
    assert exc.value.headers["Retry-After"] == "2"


# --- the self-heal ------------------------------------------------------------


def test_an_analysed_row_without_a_preview_is_offered_to_the_render_pass_again(db, dirs, monkeypatch):
    session = _session(db)
    row = _staged(db, session, "a.jpg", processed=True)
    offered: list[str] = []
    monkeypatch.setattr(
        import_pipeline, "_enqueue_review_derivatives", lambda src, path, sid, tdir, raw: offered.append(sid)
    )
    monkeypatch.setattr(import_pipeline, "_enqueue_analysis", lambda *a, **k: pytest.fail("nothing is pending"))

    ensure_session_processing(session)
    assert offered == [row.id]

    # Once the preview exists the row is left alone.
    offered.clear()
    thumb_dir = staged_thumb_dir(session.id)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    staged_preview_path(thumb_dir, row.id).write_bytes(b"jpeg")
    ensure_session_processing(session)
    assert offered == []


def test_a_queued_review_render_is_not_queued_twice(dirs, monkeypatch, tmp_path):
    thumb_dir = staged_thumb_dir("s1")
    thumb_dir.mkdir(parents=True)
    jobs = []
    monkeypatch.setattr(import_pipeline._derivative_executor, "submit", lambda fn: jobs.append(fn))
    monkeypatch.setattr(import_pipeline, "render_review_derivatives", lambda *a, **k: None)

    for _ in range(3):
        import_pipeline._enqueue_review_derivatives(None, tmp_path / "src.jpg", "f1", thumb_dir, False)
    assert len(jobs) == 1

    _photo(tmp_path / "src.jpg")
    jobs[0]()  # the job ran: the file may be queued again afterwards
    import_pipeline._enqueue_review_derivatives(None, tmp_path / "src.jpg", "f1", thumb_dir, False)
    assert len(jobs) == 2
