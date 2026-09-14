"""An import can leave photos where they are instead of copying them into the
library: the review works the same, but nothing is staged on disk, and at
commit each chosen photo becomes a row at its own absolute path under a
source root for its folder - one created without startup scanning, so the
photos left out of the review are never indexed behind the user's back."""

import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import (
    FileType,
    Image,
    ImportMode,
    ImportSession,
    ImportSessionSource,
    ImportSessionStatus,
    ImportStagedFile,
    SourceRoot,
    User,
)
from app.services import import_pipeline, sources
from app.services.hashing import sha256_file


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
    # Staging tests only look at what lands on disk and in the rows.
    monkeypatch.setattr(import_pipeline, "_enqueue_analysis", lambda *a, **k: None)
    return tmp_path


def _session(db: Session, mode: ImportMode = ImportMode.reference) -> ImportSession:
    session = ImportSession(owner_id=1, source_path="archive", mode=mode)
    db.add(session)
    db.commit()
    return session


def _folder(tmp_path: Path, name: str = "archive", files=("A.JPG", "B.JPG")) -> Path:
    folder = tmp_path / name
    folder.mkdir(parents=True, exist_ok=True)
    for f in files:
        (folder / f).write_bytes(f"{name}/{f}".encode())
    return folder


def _source(db: Session, session: ImportSession, root: Path, file_count: int | None = None):
    source = ImportSessionSource(
        import_session_id=session.id, label=root.name, root=str(root), file_count=file_count
    )
    db.add(source)
    db.commit()
    db.refresh(session)
    return source


def _referenced(
    db: Session,
    session: ImportSession,
    path: Path,
    *,
    selected: bool = True,
    source: ImportSessionSource | None = None,
    duplicate_of: str | None = None,
) -> ImportStagedFile:
    """A staged row as an in-place session records one: the original's
    absolute path, nothing under the staging root."""
    row = ImportStagedFile(
        import_session_id=session.id,
        staged_path=str(path),
        original_filename=path.name,
        file_type=FileType.jpeg,
        sha256=sha256_file(path) if path.exists() else f"sha-{path.name}",
        processed=True,
        selected=selected,
        exif_json='{"taken_at": "2026-07-01T12:00:00+00:00"}',
        source_id=source.id if source else None,
        source_relpath=path.relative_to(source.root).as_posix() if source else None,
        source_size=path.stat().st_size if source and path.exists() else None,
        duplicate_of_image_id=duplicate_of,
    )
    db.add(row)
    db.commit()
    return row


def _stage(db, paths, *, session_id=None, mode="reference", root=None, count=None):
    return routes.stage_local_paths(
        schemas.StagePathsRequest(
            paths=[str(p) for p in paths],
            source_label="archive",
            session_id=session_id,
            total_bytes=sum(Path(p).stat().st_size for p in paths),
            source_root=str(root) if root else None,
            source_file_count=count,
            mode=mode,
        ),
        db,
        _User(),
    )


# --- where a staged row's bytes are -------------------------------------------


def test_staged_file_path_is_under_staging_unless_recorded_absolute(dirs):
    relative = ImportStagedFile(staged_path="s1/A.JPG")
    assert import_pipeline.staged_file_path(relative) == settings.import_staging_root / "s1/A.JPG"
    absolute = ImportStagedFile(staged_path=str(dirs / "archive" / "A.JPG"))
    assert import_pipeline.staged_file_path(absolute) == dirs / "archive" / "A.JPG"


# --- staging -------------------------------------------------------------------


def test_staging_in_place_copies_nothing(db, dirs, monkeypatch):
    folder = _folder(dirs)
    # A full disk doesn't matter when nothing is copied.
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: 0)

    session = _stage(db, sorted(folder.iterdir()), root=folder, count=2)

    assert session.mode == ImportMode.reference
    rows = db.query(ImportStagedFile).order_by(ImportStagedFile.original_filename).all()
    assert [r.staged_path for r in rows] == [str(folder / "A.JPG"), str(folder / "B.JPG")]
    assert [r.sha256 for r in rows] == [sha256_file(folder / "A.JPG"), sha256_file(folder / "B.JPG")]
    assert [r.source_relpath for r in rows] == ["A.JPG", "B.JPG"]
    staged = settings.import_staging_root / session.id
    assert [p.name for p in staged.iterdir()] == [".thumbnails"]


def test_copying_still_checks_the_disk_first(db, dirs, monkeypatch):
    folder = _folder(dirs)
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: 0)
    with pytest.raises(routes.HTTPException) as refused:
        _stage(db, sorted(folder.iterdir()), mode="copy", root=folder, count=2)
    assert refused.value.status_code == 507


def test_a_later_batch_follows_the_sessions_mode(db, dirs):
    folder = _folder(dirs)
    session = _stage(db, [folder / "A.JPG"], root=folder, count=2)
    # The client's flag on an append is ignored - the session was created in place.
    _stage(db, [folder / "B.JPG"], session_id=session.id, mode="copy", root=folder)
    rows = db.query(ImportStagedFile).order_by(ImportStagedFile.original_filename).all()
    assert [r.staged_path for r in rows] == [str(folder / "A.JPG"), str(folder / "B.JPG")]
    assert not any(p.suffix for p in (settings.import_staging_root / session.id).iterdir())


def test_photos_inside_the_library_folder_become_managed_where_they_are(db, dirs):
    inside = _folder(settings.library_root, "Trips")
    session = _session(db)
    _referenced(db, session, inside / "A.JPG")

    [image] = import_pipeline.commit_import_session(db, session, 1)

    # No copy, no date sorting: the file is adopted at its own path.
    assert image.file_path == "Trips/A.JPG"
    assert image.source_root_id is None
    assert (inside / "A.JPG").exists()
    assert db.query(SourceRoot).count() == 0


# --- commit --------------------------------------------------------------------


def test_commit_indexes_the_chosen_photos_where_they_are(db, dirs):
    folder = _folder(dirs)
    session = _session(db)
    source = _source(db, session, folder, file_count=2)
    kept = _referenced(db, session, folder / "A.JPG", source=source)
    left_out = _referenced(db, session, folder / "B.JPG", source=source, selected=False)

    [image] = import_pipeline.commit_import_session(db, session, 1)

    assert image.file_path == str(folder / "A.JPG")
    root = db.get(SourceRoot, image.source_root_id)
    assert root is not None and root.path == str(folder) and root.auto_scan is False
    assert root.name == "archive"
    # Nothing moved, nothing copied.
    assert (folder / "A.JPG").exists() and (folder / "B.JPG").exists()
    assert list(settings.library_root.iterdir()) == []
    db.refresh(kept)
    db.refresh(left_out)
    assert kept.imported and kept.duplicate_of_image_id == image.id
    assert not left_out.imported
    db.refresh(session)
    # Like any session: open until the rest is imported or left for good.
    assert session.status == ImportSessionStatus.staging
    assert import_pipeline.session_is_exhausted(session) is False


def test_picked_files_are_recorded_under_their_own_folder(db, dirs):
    one = _folder(dirs, "one", files=("A.JPG", "B.JPG"))
    two = _folder(dirs, "two", files=("C.JPG",))
    session = _session(db)
    for path in (one / "A.JPG", one / "B.JPG", two / "C.JPG"):
        _referenced(db, session, path)

    images = import_pipeline.commit_import_session(db, session, 1)

    roots = {img.original_filename: db.get(SourceRoot, img.source_root_id).path for img in images}
    assert roots == {"A.JPG": str(one), "B.JPG": str(one), "C.JPG": str(two)}
    assert db.query(SourceRoot).count() == 2
    assert all(not r.auto_scan for r in db.query(SourceRoot).all())


def test_an_existing_source_root_is_used_as_it_is(db, dirs):
    folder = _folder(dirs)
    existing = SourceRoot(owner_id=1, name="NAS", path=str(folder))
    db.add(existing)
    db.commit()
    session = _session(db)
    _referenced(db, session, folder / "A.JPG")

    [image] = import_pipeline.commit_import_session(db, session, 1)

    assert image.source_root_id == existing.id
    db.refresh(existing)
    assert existing.auto_scan is True and existing.name == "NAS"


def test_in_place_never_promotes_or_restores(db, dirs):
    folder = _folder(dirs)
    other = SourceRoot(owner_id=1, name="other", path=str(dirs / "elsewhere"))
    db.add(other)
    db.flush()
    scanned = Image(
        owner_id=1,
        file_path=str(dirs / "elsewhere" / "A.JPG"),
        source_root_id=other.id,
        original_filename="A.JPG",
        file_hash=sha256_file(folder / "A.JPG"),
        file_type=FileType.jpeg,
        file_size=1,
    )
    trashed = Image(
        owner_id=1,
        file_path="2026/2026-07-01/B.JPG",
        original_filename="B.JPG",
        file_hash=sha256_file(folder / "B.JPG"),
        file_type=FileType.jpeg,
        file_size=1,
        deleted_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
    )
    db.add_all([scanned, trashed])
    db.commit()
    session = _session(db)
    a = _referenced(db, session, folder / "A.JPG", duplicate_of=scanned.id)
    b = _referenced(db, session, folder / "B.JPG", duplicate_of=trashed.id)

    # The review refuses to tick them...
    for staged in (a, b):
        with pytest.raises(routes.HTTPException) as refused:
            routes.update_staged_file(
                session.id, staged.id, schemas.StagedFileUpdate(selected=True), db, _User()
            )
        assert refused.value.status_code == 400
    assert routes._trashed_duplicate_ids(db, session, [a, b]) == set()
    # ...and even forced, the commit leaves the existing rows alone.
    assert import_pipeline.commit_import_session(db, session, 1) == []
    db.refresh(scanned)
    db.refresh(trashed)
    assert scanned.source_root_id == other.id
    assert trashed.deleted_at is not None


def test_a_vanished_original_and_an_indexed_path_are_skipped(db, dirs):
    folder = _folder(dirs)
    taken = Image(
        owner_id=1,
        file_path=str(folder / "B.JPG"),
        source_root_id=None,
        original_filename="B.JPG",
        file_hash="something-else",
        file_type=FileType.jpeg,
        file_size=1,
    )
    db.add(taken)
    db.commit()
    session = _session(db)
    _referenced(db, session, folder / "gone.JPG")
    _referenced(db, session, folder / "B.JPG")

    assert import_pipeline.commit_import_session(db, session, 1) == []
    assert db.query(Image).count() == 1
    db.refresh(session)
    assert session.status == ImportSessionStatus.staging


# --- analysis and startup scan --------------------------------------------------


def test_analysis_blocks_every_exact_match_in_place(db, dirs, monkeypatch):
    folder = _folder(dirs)
    other = SourceRoot(owner_id=1, name="other", path=str(dirs / "elsewhere"))
    db.add(other)
    db.flush()
    scanned = Image(
        owner_id=1,
        file_path=str(dirs / "elsewhere" / "A.JPG"),
        source_root_id=other.id,
        original_filename="A.JPG",
        file_hash=sha256_file(folder / "A.JPG"),
        file_type=FileType.jpeg,
        file_size=1,
    )
    db.add(scanned)
    db.commit()
    session = _session(db)
    row = ImportStagedFile(
        import_session_id=session.id,
        staged_path=str(folder / "A.JPG"),
        original_filename="A.JPG",
        file_type=FileType.jpeg,
        sha256=sha256_file(folder / "A.JPG"),
        processed=False,
        selected=True,
    )
    db.add(row)
    db.commit()
    monkeypatch.setattr(import_pipeline, "SessionLocal", sessionmaker(bind=db.get_bind()))
    import_pipeline._drop_session_state(session.id)

    import_pipeline._apply_analysis(
        session.id,
        1,
        import_pipeline._Analyzed(
            id=row.id,
            staged_rel_path=str(folder / "A.JPG"),
            original_filename="A.JPG",
            file_type="jpeg",
            sha256=row.sha256,
            perceptual_hash=None,
            exif_json=json.dumps({}),
        ),
    )

    db.expire_all()
    assert row.processed and row.duplicate_of_image_id == scanned.id
    # Copy mode would leave it ticked (importing promotes the scanned row);
    # in place there is nothing to promote to.
    assert row.selected is False


def test_the_startup_scan_leaves_import_created_roots_alone(db, dirs, monkeypatch):
    auto = SourceRoot(owner_id=1, name="NAS", path=str(dirs))
    manual = SourceRoot(owner_id=1, name="archive", path=str(dirs / "archive"), auto_scan=False)
    db.add_all([auto, manual])
    db.commit()
    started: list[str] = []
    monkeypatch.setattr(sources, "SessionLocal", sessionmaker(bind=db.get_bind()))
    monkeypatch.setattr(sources, "start_scan", lambda sid, include_excluded=False: started.append(sid))

    sources.scan_all_sources()

    assert started == [auto.id]


# --- a copy session collects its cards in a folder of its own ----------------


def test_a_copy_session_collects_in_its_own_folder_and_cleans_up(db, dirs, monkeypatch):
    card = _folder(dirs, "card")
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: 10**15)

    session = routes.stage_local_paths(
        schemas.StagePathsRequest(
            paths=[str(card / "A.JPG"), str(card / "B.JPG")],
            source_label="DCIM",
            mode="copy",
            source_root=str(card),
            source_file_count=2,
        ),
        db,
        _User(),
    )

    # Default location: an "Import" folder inside the library, one folder
    # per session, named after the source.
    folder = Path(session.staging_dir)
    assert folder.parent == settings.library_root / "Import"
    assert folder.name.startswith("DCIM ")
    rows = db.query(ImportStagedFile).order_by(ImportStagedFile.original_filename).all()
    assert [r.staged_path for r in rows] == [str(folder / "A.JPG"), str(folder / "B.JPG")]
    assert (folder / "A.JPG").read_bytes() == (card / "A.JPG").read_bytes()
    # Nothing but review derivatives in the hidden staging area.
    assert [p.name for p in (settings.import_staging_root / session.id).iterdir()] == [".thumbnails"]

    # Committing moves the chosen copy into the library by date; the session
    # closes once nothing is left, and its folder goes with it. (Analysis is
    # stubbed out above, so mark the rows analyzed by hand.)
    a, b = rows
    for r in rows:
        r.processed = True
        r.exif_json = '{"taken_at": "2026-07-01T12:00:00+00:00"}'
    b.selected = False
    db.commit()
    session_row = db.get(ImportSession, session.id)
    [image] = import_pipeline.commit_import_session(db, session_row, 1)
    assert image.file_path == "2026/2026-07-01/A.JPG"
    assert image.source_root_id is None
    assert not (folder / "A.JPG").exists() and (folder / "B.JPG").exists()
    b.selected = True
    db.commit()
    import_pipeline.commit_import_session(db, session_row, 1)
    db.refresh(session_row)
    assert session_row.status == ImportSessionStatus.committed
    assert not folder.exists()
    assert not (settings.import_staging_root / session.id).exists()


def test_the_collection_folder_can_live_elsewhere_and_dies_with_a_discard(db, dirs, monkeypatch):
    card = _folder(dirs, "card")
    elsewhere = dirs / "external"
    elsewhere.mkdir()
    monkeypatch.setattr(routes, "_free_disk_bytes", lambda *a: 10**15)

    session = routes.stage_local_paths(
        schemas.StagePathsRequest(
            paths=[str(card / "A.JPG")], source_label="DCIM", mode="copy", staging_folder=str(elsewhere)
        ),
        db,
        _User(),
    )
    folder = Path(session.staging_dir)
    assert folder.parent == elsewhere and (folder / "A.JPG").exists()
    assert list(settings.library_root.iterdir()) == []

    import_pipeline.discard_import_session(db, db.get(ImportSession, session.id))
    assert not folder.exists() and elsewhere.exists()


def test_a_missing_collection_base_is_refused(db, dirs):
    card = _folder(dirs, "card")
    with pytest.raises(routes.HTTPException) as refused:
        routes.stage_local_paths(
            schemas.StagePathsRequest(
                paths=[str(card / "A.JPG")], mode="copy", staging_folder=str(dirs / "nope")
            ),
            db,
            _User(),
        )
    assert refused.value.status_code == 400


def test_a_session_can_be_renamed(db, dirs):
    session = _session(db)
    renamed = routes.rename_import_session(
        session.id, schemas.ImportSessionUpdate(name="  Norway trip "), db, _User()
    )
    assert renamed.source_path == "Norway trip"
    with pytest.raises(routes.HTTPException):
        routes.rename_import_session(session.id, schemas.ImportSessionUpdate(name="  "), db, _User())
