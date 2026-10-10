"""The backend goes away when the app does.

Two things kept the app alive after a quit: exiftool -stay_open helpers,
which never exit on their own, and an import whose progress record stayed
"active" after an exception, which held the desktop shell's "finish in
background" open for good. Pinned here: the shutdown hook ends every helper,
a staging batch or a commit that raises settles its progress, and the
embedding backfill reports itself running only while it encodes.
"""

import threading
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import main as app_main
from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import ImportSession, ImportStagedFile, User
from app.services import exif as exif_service
from app.services import import_pipeline, lens_profile, white_balance
from app.workers import queue


class _Helper:
    def __init__(self):
        self.terminated = False

    def terminate(self):
        self.terminated = True


# --- exiftool helpers ----------------------------------------------------------


def test_close_helper_ends_each_modules_exiftool(monkeypatch):
    helpers = [_Helper() for _ in range(3)]
    monkeypatch.setattr(exif_service, "_helper", helpers[0])
    monkeypatch.setattr(lens_profile, "_helper", helpers[1])
    monkeypatch.setattr(white_balance, "_helper", helpers[2])

    exif_service.close_helper()
    lens_profile.close_helper()
    white_balance.close_helper()

    assert all(h.terminated for h in helpers)
    assert exif_service._helper is None and lens_profile._helper is None and white_balance._helper is None
    # Idempotent: nothing to close the second time, no error.
    exif_service.close_helper()


def test_shutdown_hook_closes_the_helpers_and_sweeps_the_rest(monkeypatch):
    helper = _Helper()
    monkeypatch.setattr(exif_service, "_helper", helper)
    swept = []
    monkeypatch.setattr(app_main, "terminate_own_helpers", lambda: swept.append(True) or 0)

    app_main.on_shutdown()

    assert helper.terminated
    assert swept == [True]


def test_shutdown_hook_survives_a_helper_that_fails_to_close(monkeypatch):
    class _Broken:
        def terminate(self):
            raise RuntimeError("pipe gone")

    monkeypatch.setattr(exif_service, "_helper", _Broken())
    monkeypatch.setattr(app_main, "terminate_own_helpers", lambda: 0)
    app_main.on_shutdown()
    assert exif_service._helper is None


def test_own_helper_sweep_matches_only_this_backends_stay_open_children(monkeypatch):
    import os
    import subprocess

    me = os.getpid()
    ps = (
        f"  101  {me} /usr/bin/exiftool -stay_open True -@ -\n"
        f"  102  {me} /usr/bin/exiftool -ver\n"
        f"  103    1 /usr/bin/exiftool -stay_open True -@ -\n"
        f"  104  {me} /usr/bin/python other -stay_open\n"
    )

    class _Run:
        stdout = ps

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Run())
    killed = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: killed.append(pid))

    assert exif_service.terminate_own_helpers() == 1
    assert killed == [101]


# --- import progress -----------------------------------------------------------


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
    monkeypatch.setattr(import_pipeline, "_progress", {})
    return tmp_path


def _card(tmp_path: Path) -> Path:
    card = tmp_path / "card" / "100FUJI"
    card.mkdir(parents=True)
    for name, data in (("DSCF0001.JPG", b"one"), ("DSCF0002.JPG", b"two"), ("DSCF0003.JPG", b"three")):
        (card / name).write_bytes(data)
    return card


def test_a_staging_batch_that_raises_does_not_stay_active(db, dirs, tmp_path, monkeypatch):
    """The second file's analysis job fails to enqueue: the files that got no
    job come off the target, so the session reads as idle once the one job
    that did start is done - not as "active" forever."""
    enqueued = []

    def enqueue(session_id, staged_id, source=None):
        if len(enqueued) == 1:
            raise RuntimeError("pool gone")
        enqueued.append(staged_id)

    monkeypatch.setattr(import_pipeline, "_enqueue_analysis", enqueue)
    session = ImportSession(owner_id=1, source_path="DCIM")
    db.add(session)
    db.commit()
    uploads = [routes._LocalUpload(p) for p in sorted(_card(tmp_path).iterdir())]
    try:
        with pytest.raises(RuntimeError):
            import_pipeline.append_uploaded_files(db, session, 1, uploads)
    finally:
        for upload in uploads:
            upload.file.close()

    progress = import_pipeline._progress[session.id]
    assert len(enqueued) == 1
    assert progress["total"] == 1 and progress["copied"] <= 1
    assert import_pipeline.has_active_import_work()  # the one job is outstanding
    import_pipeline._progress_step(session.id)
    assert not import_pipeline.has_active_import_work()


def test_a_commit_that_raises_settles_its_progress(db, dirs, monkeypatch):
    session = ImportSession(owner_id=1, source_path="DCIM")
    db.add(session)
    db.commit()

    def fail(db_, session_, owner_id, *rest):
        import_pipeline._progress_begin(session_.id, "commit", 5)
        import_pipeline._progress_step(session_.id)
        raise OSError("disk full")

    monkeypatch.setattr(import_pipeline, "_commit_import_session", fail)
    with pytest.raises(OSError):
        import_pipeline.commit_import_session(db, session, 1)

    assert import_pipeline._progress[session.id]["phase"] == "idle"
    assert not import_pipeline.has_active_import_work()


# --- embedding backfill ---------------------------------------------------------


def test_embeddings_running_only_while_encoding(monkeypatch):
    stop = threading.Event()
    thread = threading.Thread(target=stop.wait, daemon=True)
    thread.start()
    try:
        monkeypatch.setattr(queue, "_backfill_thread", thread)
        monkeypatch.setattr(queue, "_backfill_encoding", False)
        assert not queue.embeddings_running()
        monkeypatch.setattr(queue, "_backfill_encoding", True)
        assert queue.embeddings_running()
    finally:
        stop.set()
        thread.join()
    assert not queue.embeddings_running()
