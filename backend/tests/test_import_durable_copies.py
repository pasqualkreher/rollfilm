"""Every copy the import makes lands under a ".part" name and takes its real
name only once it is flushed, so a copy that dies half-way leaves nothing
under a photo's name; with "verify copies" on, each copy is read back against
the source's hash and a bad one is removed on the spot."""

import errno
import os
import shutil
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import ImportSession, ImportStagedFile, User
from app.services import import_pipeline
from app.services.settings_store import IMPORT_VERIFY_COPIES, set_setting

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
        (card / f).write_bytes(f"card/{f}".encode() * 1000)
    return card


def _stage(db, card: Path, *, keep_backup=False):
    files = sorted(p for p in card.iterdir() if p.is_file())
    out = routes.stage_local_paths(
        schemas.StagePathsRequest(
            paths=[str(p) for p in files],
            source_label="DCIM",
            mode="copy",
            source_root=str(card),
            source_file_count=len(files),
            keep_backup=keep_backup,
        ),
        db,
        _User(),
    )
    return db.get(ImportSession, out.id)


def _ready(db, session) -> list[ImportStagedFile]:
    """Mark everything analyzed (analysis is stubbed out) and ticked."""
    rows = (
        db.query(ImportStagedFile)
        .filter(ImportStagedFile.import_session_id == session.id)
        .order_by(ImportStagedFile.original_filename)
        .all()
    )
    for r in rows:
        r.processed = True
        r.selected = True
        r.exif_json = '{"taken_at": "2026-07-01T12:00:00+00:00"}'
    db.commit()
    return rows


def _parts(root: Path) -> list[Path]:
    return [p for p in root.rglob("*.part")]


def _verify_on(db) -> None:
    set_setting(db, IMPORT_VERIFY_COPIES, "1")
    db.commit()


def test_no_part_file_is_left_after_staging_and_commit(db, dirs):
    card = _card(dirs)
    session = _stage(db, card)
    folder = Path(session.staging_dir)
    assert sorted(p.name for p in folder.iterdir()) == ["A.JPG", "B.JPG"]
    assert _parts(dirs) == []

    _ready(db, session)
    images = import_pipeline.commit_import_session(db, session, 1, keep_open=True)
    assert len(images) == 2
    assert _parts(dirs) == []
    for image in images:
        assert (settings.library_root / image.file_path).read_bytes() == (card / image.original_filename).read_bytes()


def test_a_crash_between_write_and_rename_leaves_no_file(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))

    def _no_replace(src, dst):
        raise OSError(errno.EIO, "pulled the cable")

    monkeypatch.setattr(import_pipeline.os, "replace", _no_replace)
    with pytest.raises(OSError, match="cable"):
        _stage(db, card)

    # Neither the photo's name nor a stray ".part" anywhere in the library.
    staged = [p for p in dirs.rglob("A.JPG") if card not in p.parents]
    assert staged == []
    assert _parts(dirs) == []
    assert db.query(ImportStagedFile).count() == 0


def test_a_commit_copy_that_dies_leaves_no_file_under_the_library_name(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    session = _stage(db, card, keep_backup=True)
    _ready(db, session)

    def _no_replace(src, dst):
        raise OSError(errno.EIO, "pulled the cable")

    monkeypatch.setattr(import_pipeline.os, "replace", _no_replace)
    with pytest.raises(OSError, match="cable"):
        import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert not (settings.library_root / DAY / "A.JPG").exists()
    assert _parts(settings.library_root) == []
    # The backup folder still has its copy for the retry.
    assert (Path(session.staging_dir) / "A.JPG").exists()


def test_verification_catches_a_corrupted_staging_copy(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    _verify_on(db)
    real = import_pipeline._stream_to_file

    def _flips_a_byte(src, part):
        digest, size = real(src, part)
        with part.open("r+b") as f:
            f.seek(0)
            f.write(b"\x00")
        return digest, size

    monkeypatch.setattr(import_pipeline, "_stream_to_file", _flips_a_byte)
    with pytest.raises(import_pipeline.CopyVerificationError, match="A.JPG.*does not match"):
        _stage(db, card)

    staged = [p for p in dirs.rglob("A.JPG") if card not in p.parents]
    assert staged == []
    assert _parts(dirs) == []


def test_verification_catches_a_corrupted_commit_copy(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    session = _stage(db, card, keep_backup=True)
    _ready(db, session)
    _verify_on(db)

    def _bad_copy2(src, dst):
        Path(dst).write_bytes(b"garbage")

    monkeypatch.setattr(import_pipeline.shutil, "copy2", _bad_copy2)
    with pytest.raises(import_pipeline.CopyVerificationError, match="A.JPG"):
        import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert not (settings.library_root / DAY / "A.JPG").exists()
    assert _parts(settings.library_root) == []
    assert db.query(ImportStagedFile).filter(ImportStagedFile.imported.is_(True)).count() == 0


def test_a_good_copy_passes_verification(db, dirs):
    card = _card(dirs, files=("A.JPG",))
    _verify_on(db)
    session = _stage(db, card, keep_backup=True)
    _ready(db, session)
    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)
    assert (settings.library_root / image.file_path).read_bytes() == (card / "A.JPG").read_bytes()


def test_a_move_across_devices_copies_durably_and_removes_the_source(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    session = _stage(db, card)
    _ready(db, session)
    staged = Path(session.staging_dir) / "A.JPG"
    real_rename = os.rename

    def _other_device(src, dst):
        if Path(src) == staged:
            raise OSError(errno.EXDEV, "cross-device link")
        return real_rename(src, dst)

    monkeypatch.setattr(import_pipeline.os, "rename", _other_device)
    [image] = import_pipeline.commit_import_session(db, session, 1, keep_open=True)

    assert (settings.library_root / image.file_path).read_bytes() == (card / "A.JPG").read_bytes()
    assert not staged.exists()
    assert _parts(dirs) == []


def test_a_folder_that_refuses_fsync_does_not_stop_the_import(db, dirs, monkeypatch):
    card = _card(dirs, files=("A.JPG",))
    real_fsync = os.fsync

    def _dirs_refuse(fd):
        # A directory handle: what exFAT through FSKit answers.
        if os.fstat(fd).st_mode & 0o040000:
            raise OSError(errno.EINVAL, "Invalid argument")
        return real_fsync(fd)

    monkeypatch.setattr(import_pipeline.os, "fsync", _dirs_refuse)
    session = _stage(db, card)
    assert (Path(session.staging_dir) / "A.JPG").exists()
