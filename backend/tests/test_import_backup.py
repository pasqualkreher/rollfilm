"""A copy session can keep its collection folder as a backup: the folder then
holds every photo the session read, the ones added to the library are copied
there instead of moved, and the folder stays when the session closes."""

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import Image, ImportSession, ImportSessionStatus, ImportStagedFile, User
from app.services import import_pipeline

DAY = "2026/2026-07-01"


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
    monkeypatch.setattr(import_pipeline, "enqueue_post_import", lambda *a, **k: None)
    monkeypatch.setattr(import_pipeline, "get_immich_config", lambda db: None)
    monkeypatch.setattr(import_pipeline.geocode, "annotate_images", lambda images: None)
    monkeypatch.setattr(import_pipeline, "_enqueue_analysis", lambda *a, **k: None)
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: 10**15)
    return tmp_path


def _card(tmp_path: Path, files=("A.JPG", "B.JPG")) -> Path:
    card = tmp_path / "card"
    card.mkdir(parents=True, exist_ok=True)
    for f in files:
        (card / f).write_bytes(f"card/{f}".encode())
    return card


def _start(db, card: Path, *, keep_backup=True, mode="copy", session_id=None):
    """Stage the whole card and mark it analyzed (analysis is stubbed out)."""
    files = sorted(p for p in card.iterdir() if p.is_file())
    out = routes.stage_local_paths(
        schemas.StagePathsRequest(
            paths=[str(p) for p in files],
            source_label="DCIM",
            session_id=session_id,
            mode=mode,
            source_root=str(card),
            source_file_count=len(files),
            keep_backup=keep_backup,
        ),
        db,
        _User(),
    )
    rows = (
        db.query(ImportStagedFile)
        .filter(ImportStagedFile.import_session_id == out.id)
        .order_by(ImportStagedFile.original_filename)
        .all()
    )
    for r in rows:
        r.processed = True
        r.exif_json = '{"taken_at": "2026-07-01T12:00:00+00:00"}'
    db.commit()
    return db.get(ImportSession, out.id), rows


def test_a_backup_session_keeps_every_photo_in_its_folder_and_copies_the_keepers(db, dirs):
    card = _card(dirs)
    session, (a, b) = _start(db, card)
    folder = Path(session.staging_dir)
    b.selected = False
    db.commit()

    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert image.file_path == f"{DAY}/A.JPG"
    in_library = settings.library_root / image.file_path
    assert in_library.read_bytes() == (card / "A.JPG").read_bytes()
    # The folder still holds the whole card - the photo added and the one not.
    assert sorted(p.name for p in folder.iterdir()) == ["A.JPG", "B.JPG"]
    assert (folder / "A.JPG").read_bytes() == in_library.read_bytes()
    db.refresh(a)
    assert a.imported and a.staged_path == str(folder / "A.JPG")


def test_without_backup_the_keepers_still_move(db, dirs):
    card = _card(dirs)
    session, _ = _start(db, card, keep_backup=False)
    folder = Path(session.staging_dir)

    import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert list(folder.iterdir()) == []
    assert sorted(p.name for p in (settings.library_root / DAY).iterdir()) == ["A.JPG", "B.JPG"]


def test_backup_is_ignored_when_photos_stay_where_they_are(db, dirs):
    session, _ = _start(db, _card(dirs), mode="reference")
    assert session.staging_dir is None and session.keep_backup is False


def test_a_later_batch_cannot_turn_backup_on(db, dirs):
    card = _card(dirs)
    session, _ = _start(db, card, keep_backup=False)
    (card / "C.JPG").write_bytes(b"card/C.JPG")

    session, _ = _start(db, card, keep_backup=True, session_id=session.id)

    assert session.keep_backup is False


def test_open_sessions_say_which_keep_a_backup(db, dirs):
    kept, _ = _start(db, _card(dirs))
    plain, _ = _start(db, _card(dirs), keep_backup=False)

    listed = {s.id: s.keep_backup for s in routes.list_open_sessions(db, _User())}

    assert listed == {kept.id: True, plain.id: False}


def test_a_backup_session_that_runs_out_keeps_its_folder(db, dirs):
    session, _ = _start(db, _card(dirs))
    folder = Path(session.staging_dir)

    import_pipeline.commit_import_session(db, session, 1)

    db.refresh(session)
    assert session.status == ImportSessionStatus.committed
    assert sorted(p.name for p in folder.iterdir()) == ["A.JPG", "B.JPG"]
    assert not (settings.import_staging_root / session.id).exists()


def test_closing_a_backup_session_leaves_its_folder(db, dirs):
    session, _ = _start(db, _card(dirs))
    folder = Path(session.staging_dir)

    routes.discard_session(session.id, db=db, current_user=_User())

    db.expire_all()
    assert db.get(ImportSession, session.id).status == ImportSessionStatus.discarded
    assert sorted(p.name for p in folder.iterdir()) == ["A.JPG", "B.JPG"]
    assert not (settings.import_staging_root / session.id).exists()


def test_closing_without_backup_deletes_the_folder_unasked(db, dirs):
    session, _ = _start(db, _card(dirs), keep_backup=False)
    folder = Path(session.staging_dir)

    routes.discard_session(session.id, db=db, current_user=_User())

    assert not folder.exists()


def test_a_cancelled_backup_import_still_removes_its_folder(db, dirs):
    session, _ = _start(db, _card(dirs))
    folder = Path(session.staging_dir)

    routes.discard_session(session.id, keep_folder=False, db=db, current_user=_User())

    assert not folder.exists()


def test_a_failed_backup_commit_is_picked_up_without_a_second_copy(db, dirs):
    card = _card(dirs, files=("A.JPG",))
    session, _ = _start(db, card)
    # What a commit that died after its copy phase leaves: the bytes in the
    # day folder, no row for them - and, in a backup session, the staged file
    # still in place.
    day = settings.library_root / DAY
    day.mkdir(parents=True)
    (day / "A.JPG").write_bytes((card / "A.JPG").read_bytes())

    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert image.file_path == f"{DAY}/A.JPG"
    assert [p.name for p in day.iterdir()] == ["A.JPG"]


def test_another_photo_with_the_same_name_is_not_mistaken_for_the_copy(db, dirs):
    card = _card(dirs, files=("A.JPG",))
    session, _ = _start(db, card)
    day = settings.library_root / DAY
    day.mkdir(parents=True)
    (day / "A.JPG").write_bytes(b"some other camera's A.JPG")

    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert image.file_path == f"{DAY}/A_1.JPG"
    assert (day / "A.JPG").read_bytes() == b"some other camera's A.JPG"
    assert (day / "A_1.JPG").read_bytes() == (card / "A.JPG").read_bytes()


def test_an_interrupted_copy_leaves_nothing_under_the_final_name(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    session, _ = _start(db, card)
    real_copy = import_pipeline.shutil.copy2

    def dies_half_way(src, dst, **kwargs):
        Path(dst).write_bytes(b"half")
        raise OSError("disk went away")

    monkeypatch.setattr(import_pipeline.shutil, "copy2", dies_half_way)
    with pytest.raises(OSError):
        import_pipeline.commit_import_session(db, session, 1, keep_open=True)
    db.rollback()

    day = settings.library_root / DAY
    assert list(day.iterdir()) == []
    assert db.query(Image).count() == 0

    # The retry goes through like a first attempt.
    monkeypatch.setattr(import_pipeline.shutil, "copy2", real_copy)
    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)
    assert (settings.library_root / image.file_path).read_bytes() == (card / "A.JPG").read_bytes()


def test_a_backup_commit_is_refused_when_the_library_disk_is_too_full(db, dirs, monkeypatch):
    backup, _ = _start(db, _card(dirs))
    plain, _ = _start(db, _card(dirs), keep_backup=False)
    # Exactly the reserve is free: a move still fits, a second copy does not.
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: routes._DISK_SPACE_RESERVE_BYTES)
    keep_open = schemas.CommitImportRequest(keep_session_open=True)

    with pytest.raises(routes.HTTPException) as refused:
        routes.commit_session(backup.id, keep_open, db, _User())
    assert refused.value.status_code == 507
    assert db.query(Image).count() == 0

    # Both sessions read the same card, so the plain one adds its photos...
    assert len(routes.commit_session(plain.id, keep_open, db, _User())) == 2
