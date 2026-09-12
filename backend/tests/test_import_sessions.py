"""Import sessions live until the user ends them: import a hundred of a card's
five thousand photos today, the next hundred tomorrow, add a second card or a
folder along the way, continue copying whenever a card is back in. What that
rests on:

- a partial import keeps the session open, and the files it took read as
  "already in library" from then on - never importable twice;
- the session closes by itself only once nothing is left in it or on its
  sources;
- a session collects from several sources, each scanned and continued on its
  own, and adding a folder it already has only brings in what is new;
- a card is recognised by its volume identity, not by its mount name.
"""

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import (
    FileType,
    Image,
    ImportSession,
    ImportSessionSource,
    ImportSessionStatus,
    ImportStagedFile,
    User,
)
from app.services import import_pipeline, volumes
from app.services.volumes import VolumeInfo, resolve_source_root


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
    # Commit's post-import side effects are not what these tests are about.
    monkeypatch.setattr(import_pipeline, "enqueue_post_import", lambda *a, **k: None)
    monkeypatch.setattr(import_pipeline, "get_immich_config", lambda db: None)
    monkeypatch.setattr(import_pipeline.geocode, "annotate_images", lambda images: None)
    return tmp_path


def _session(db: Session) -> ImportSession:
    session = ImportSession(owner_id=1, source_path="DCIM")
    db.add(session)
    db.commit()
    return session


def _source(db: Session, session: ImportSession, root: Path, file_count: int | None = None):
    source = ImportSessionSource(
        import_session_id=session.id,
        label=root.name,
        root=str(root),
        file_count=file_count,
    )
    db.add(source)
    db.commit()
    db.refresh(session)
    return source


def _staged(
    db: Session,
    session: ImportSession,
    name: str,
    *,
    selected: bool = True,
    source: ImportSessionSource | None = None,
    relpath: str | None = None,
    size: int | None = None,
) -> ImportStagedFile:
    staged_dir = settings.import_staging_root / session.id
    staged_dir.mkdir(parents=True, exist_ok=True)
    (staged_dir / name).write_bytes(name.encode())
    row = ImportStagedFile(
        import_session_id=session.id,
        staged_path=f"{session.id}/{name}",
        original_filename=name,
        file_type=FileType.jpeg,
        sha256=f"sha-{name}",
        processed=True,
        selected=selected,
        exif_json='{"taken_at": "2026-07-01T12:00:00+00:00"}',
        source_id=source.id if source else None,
        source_relpath=relpath,
        source_size=size,
    )
    db.add(row)
    db.commit()
    return row


def _card(tmp_path: Path, name: str = "card") -> Path:
    card = tmp_path / name
    (card / "100FUJI").mkdir(parents=True)
    (card / "100FUJI" / "DSCF0001.JPG").write_bytes(b"one")
    (card / "100FUJI" / "DSCF0002.JPG").write_bytes(b"two")
    (card / "100FUJI" / "DSCF0002.RAF").write_bytes(b"raw two")
    return card


# --- partial import -----------------------------------------------------------


def test_a_partial_import_keeps_the_session_open(db, dirs):
    session = _session(db)
    first = _staged(db, session, "A.JPG", selected=True)
    later = _staged(db, session, "B.JPG", selected=False)

    images = import_pipeline.commit_import_session(db, session, 1)

    assert [img.original_filename for img in images] == ["A.JPG"]
    db.refresh(session)
    assert session.status == ImportSessionStatus.staging
    # The rest of the batch is still there to import another day.
    assert (settings.import_staging_root / session.id / "B.JPG").exists()
    db.refresh(first)
    db.refresh(later)
    # The imported one now reads exactly like a file already in the library.
    assert first.imported and not first.selected
    assert first.duplicate_of_image_id == images[0].id
    assert not later.imported


def test_what_was_imported_is_never_imported_again(db, dirs):
    session = _session(db)
    first = _staged(db, session, "A.JPG", selected=True)
    _staged(db, session, "B.JPG", selected=False)
    import_pipeline.commit_import_session(db, session, 1)

    # Re-ticking it is refused like any file already in the library...
    with pytest.raises(routes.HTTPException) as refused:
        routes.update_staged_file(
            session.id, first.id, routes.schemas.StagedFileUpdate(selected=True), db, _User()
        )
    assert refused.value.status_code == 400
    # ...and even forced, the next commit leaves it alone.
    first.selected = True
    db.commit()
    assert import_pipeline.commit_import_session(db, session, 1) == []
    assert db.query(Image).count() == 1


def test_an_imported_file_stays_blocked_after_its_photo_is_deleted_for_good(db, dirs):
    session = _session(db)
    first = _staged(db, session, "A.JPG", selected=True)
    _staged(db, session, "B.JPG", selected=False)
    import_pipeline.commit_import_session(db, session, 1)
    # hard_delete_images nulls the link; the staged bytes left with the photo.
    first.duplicate_of_image_id = None
    first.selected = True
    db.commit()
    assert import_pipeline.commit_import_session(db, session, 1) == []


def test_the_session_closes_once_nothing_is_left(db, dirs):
    session = _session(db)
    _staged(db, session, "A.JPG", selected=True)
    later = _staged(db, session, "B.JPG", selected=False)
    import_pipeline.commit_import_session(db, session, 1)

    later.selected = True
    db.commit()
    import_pipeline.commit_import_session(db, session, 1)

    db.refresh(session)
    assert session.status == ImportSessionStatus.committed
    assert not (settings.import_staging_root / session.id).exists()


def test_a_session_with_photos_still_on_a_source_stays_open(db, dirs, tmp_path):
    session = _session(db)
    source = _source(db, session, _card(tmp_path), file_count=3)
    _staged(db, session, "A.JPG", source=source, relpath="100FUJI/DSCF0001.JPG", size=3)

    import_pipeline.commit_import_session(db, session, 1)

    db.refresh(session)
    # Everything copied is imported, but two photos were never copied.
    assert session.status == ImportSessionStatus.staging


def test_a_photo_imported_through_one_session_is_known_to_another(db, dirs):
    """Each session loads its duplicate index once - and sessions now stay
    open for days, so a commit must reach the others' indexes too."""
    other = _session(db)
    state = import_pipeline._session_state(other.id)
    state.loaded = True
    try:
        session = _session(db)
        _staged(db, session, "A.JPG", selected=True)
        [image] = import_pipeline.commit_import_session(db, session, 1)
        assert state.image_by_hash["sha-A.JPG"][0] == image.id
    finally:
        import_pipeline._drop_session_state(other.id)


# --- continuing from the sources ----------------------------------------------


def test_rescan_hands_back_only_what_is_not_copied_yet(db, dirs, tmp_path):
    session = _session(db)
    source = _source(db, session, _card(tmp_path), file_count=3)
    _staged(db, session, "DSCF0001.JPG", source=source, relpath="100FUJI/DSCF0001.JPG", size=3)

    [found] = routes.rescan_session_sources(session.id, db=db, current_user=_User()).sources

    assert found.available and found.id == source.id
    assert sorted(f.name for f in found.files) == ["DSCF0002.JPG", "DSCF0002.RAF"]
    assert found.file_count == 3


def test_rescan_picks_up_photos_shot_since(db, dirs, tmp_path):
    session = _session(db)
    card = _card(tmp_path)
    source = _source(db, session, card, file_count=3)
    for name, size in [("DSCF0001.JPG", 3), ("DSCF0002.JPG", 3), ("DSCF0002.RAF", 7)]:
        _staged(db, session, name, source=source, relpath=f"100FUJI/{name}", size=size)
    (card / "100FUJI" / "DSCF0003.JPG").write_bytes(b"three")

    [found] = routes.rescan_session_sources(session.id, db=db, current_user=_User()).sources

    assert [f.name for f in found.files] == ["DSCF0003.JPG"]
    db.refresh(source)
    assert source.file_count == 4


def test_a_reused_file_name_with_other_bytes_is_new(db, dirs, tmp_path):
    """Card formatted and shot again: DSCF0001 is a different photo now."""
    session = _session(db)
    source = _source(db, session, _card(tmp_path), file_count=1)
    _staged(db, session, "DSCF0001.JPG", source=source, relpath="100FUJI/DSCF0001.JPG", size=999)

    [found] = routes.rescan_session_sources(session.id, db=db, current_user=_User()).sources

    assert "DSCF0001.JPG" in [f.name for f in found.files]


def test_rescan_covers_every_source_and_says_which_is_not_connected(db, dirs, tmp_path):
    session = _session(db)
    _source(db, session, _card(tmp_path, "card-one"), file_count=3)
    _source(db, session, tmp_path / "card-two", file_count=40)

    found = routes.rescan_session_sources(session.id, db=db, current_user=_User()).sources

    assert [(s.label, s.available, len(s.files)) for s in found] == [
        ("card-one", True, 3),
        ("card-two", False, 0),
    ]
    # A source that isn't there keeps what its last scan knew.
    assert found[1].file_count == 40


def test_a_folder_can_be_scanned_before_it_belongs_to_the_session(db, dirs, tmp_path):
    """Adding another folder: what it would bring in, before anything of it is
    copied - so it has no source row yet."""
    session = _session(db)
    _source(db, session, _card(tmp_path, "card-one"), file_count=3)
    second = _card(tmp_path, "card-two")

    found = routes.rescan_session_sources(
        session.id, routes.schemas.ImportRescanRequest(path=str(second)), db, _User()
    ).sources

    assert len(found) == 1
    assert found[0].id is None and found[0].label == "card-two"
    assert len(found[0].files) == 3 and found[0].file_count == 3


def test_adding_a_folder_the_session_already_has_only_brings_the_new_files(db, dirs, tmp_path):
    session = _session(db)
    card = _card(tmp_path)
    source = _source(db, session, card, file_count=3)
    _staged(db, session, "DSCF0001.JPG", source=source, relpath="100FUJI/DSCF0001.JPG", size=3)

    [found] = routes.rescan_session_sources(
        session.id, routes.schemas.ImportRescanRequest(path=str(card)), db, _User()
    ).sources

    assert found.id == source.id
    assert sorted(f.name for f in found.files) == ["DSCF0002.JPG", "DSCF0002.RAF"]


def test_a_whole_batch_from_a_source_records_every_file_under_it(db, dirs, tmp_path, monkeypatch):
    """Through the real copy loop, several files at once: the second file of a
    batch once found the source root overwritten by the first file's size."""
    monkeypatch.setattr(import_pipeline, "_enqueue_analysis", lambda *a, **k: None)
    session = _session(db)
    card = _card(tmp_path)
    source = _source(db, session, card)
    uploads = [routes._LocalUpload(p) for p in sorted((card / "100FUJI").iterdir())]
    try:
        import_pipeline.append_uploaded_files(db, session, 1, uploads, (source.id, source.root))
    finally:
        for upload in uploads:
            upload.file.close()

    rows = db.query(ImportStagedFile).filter_by(import_session_id=session.id).all()
    assert sorted((r.source_relpath, r.source_size) for r in rows) == [
        ("100FUJI/DSCF0001.JPG", 3),
        ("100FUJI/DSCF0002.JPG", 3),
        ("100FUJI/DSCF0002.RAF", 7),
    ]
    assert {r.source_id for r in rows} == {source.id}


def test_a_source_is_recorded_once_per_folder(db, dirs, tmp_path):
    session = _session(db)
    first = _card(tmp_path, "card-one")
    second = _card(tmp_path, "card-two")

    a = routes._source_row(db, session, first, 3)
    again = routes._source_row(db, session, first, 4)
    b = routes._source_row(db, session, second, 3)

    assert again.id == a.id and again.file_count == 4
    assert b.id != a.id
    db.refresh(session)
    assert len(session.sources) == 2


def test_the_same_card_under_another_name_is_not_a_second_source(db, dirs, tmp_path, monkeypatch):
    session = _session(db)
    source = _source(db, session, tmp_path / "Untitled" / "DCIM", file_count=3)
    source.volume_mount = str(tmp_path / "Untitled")
    source.volume_uuid = "CARD"
    db.commit()
    remounted = tmp_path / "Untitled 1" / "DCIM"
    remounted.mkdir(parents=True)
    monkeypatch.setattr(
        volumes, "find_mount", lambda uuid: str(tmp_path / "Untitled 1") if uuid == "CARD" else None
    )

    again = routes._source_row(db, session, remounted, 5)

    assert again.id == source.id and again.root == str(remounted)
    db.refresh(session)
    assert len(session.sources) == 1


def test_open_sessions_are_listed_with_their_sources(db, dirs, tmp_path):
    session = _session(db)
    source = _source(db, session, _card(tmp_path), file_count=3)
    _staged(db, session, "A.JPG", selected=True, source=source, relpath="100FUJI/DSCF0001.JPG", size=3)
    _staged(db, session, "B.JPG", selected=False)
    import_pipeline.commit_import_session(db, session, 1)
    done = _session(db)
    done.status = ImportSessionStatus.committed
    db.commit()

    [listed] = routes.list_open_sessions(db, _User())

    assert listed.id == session.id
    assert (listed.file_count, listed.imported_count, listed.selected_count) == (2, 1, 0)
    [only] = listed.sources
    assert only.available and only.copied == 1 and only.remaining == 2


# --- which card is which ------------------------------------------------------


def test_the_card_is_found_under_another_mount_name(tmp_path, monkeypatch):
    remounted = tmp_path / "Untitled 1"
    (remounted / "DCIM").mkdir(parents=True)
    monkeypatch.setattr(volumes, "find_mount", lambda uuid: str(remounted) if uuid == "CARD" else None)

    found = resolve_source_root(str(tmp_path / "Untitled" / "DCIM"), str(tmp_path / "Untitled"), "CARD")

    assert found == remounted / "DCIM"


def test_another_card_under_the_same_name_is_not_it(tmp_path, monkeypatch):
    mount = tmp_path / "Untitled"
    (mount / "DCIM").mkdir(parents=True)
    monkeypatch.setattr(volumes, "volume_of", lambda p: VolumeInfo(str(mount), "OTHER", "Untitled"))
    monkeypatch.setattr(volumes, "find_mount", lambda uuid: None)

    assert resolve_source_root(str(mount / "DCIM"), str(mount), "CARD") is None


def test_without_a_volume_identity_the_path_decides(tmp_path):
    folder = tmp_path / "photos"
    folder.mkdir()
    assert resolve_source_root(str(folder), None, None) == folder
    assert resolve_source_root(str(tmp_path / "nope"), None, None) is None
