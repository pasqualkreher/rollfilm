"""Metadata edited in the import review (services/metadata_edit.py, staged
part): the edit sits beside the file's values, reaches the RAW+JPEG partner,
shows in the review list, can be forgotten again, and at commit becomes the
photo's values - marked as hand edits, so sidecar and exports write them.
"""

from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import import_ as routes
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, ImportMode, ImportSession, ImportStagedFile, User
from app.services import import_pipeline, metadata_edit


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
    monkeypatch.setattr(metadata_edit.geocode, "country_for", lambda lat, lon: "Chile")
    return tmp_path


_EXIF = (
    '{"taken_at": "2026-07-01T12:00:00+02:00", "camera_make": "FUJIFILM", "camera_model": "X-T5",'
    ' "iso": 200, "shutter_speed": "0.01", "creator": "Old", "caption": "from the file"}'
)


def _pair(db: Session, folder: Path) -> tuple[ImportSession, ImportStagedFile, ImportStagedFile]:
    folder.mkdir(parents=True, exist_ok=True)
    session = ImportSession(owner_id=1, source_path="archive", mode=ImportMode.reference)
    db.add(session)
    db.commit()
    rows = []
    for name, kind in (("DSCF1.JPG", FileType.jpeg), ("DSCF1.RAF", FileType.raw)):
        (folder / name).write_bytes(name.encode())
        row = ImportStagedFile(
            import_session_id=session.id,
            staged_path=str(folder / name),
            original_filename=name,
            file_type=kind,
            sha256=f"sha-{name}",
            processed=True,
            selected=True,
            exif_json=_EXIF,
        )
        db.add(row)
        rows.append(row)
    db.commit()
    db.refresh(session)
    return session, rows[0], rows[1]


def test_review_edit_reaches_the_partner_shows_and_can_be_forgotten(db, dirs):
    session, jpg, raw = _pair(db, dirs / "archive")
    out = routes.edit_staged_metadata(
        session.id,
        schemas.StagedMetadataEdit(
            file_ids=[jpg.id],
            fields={"creator": "Ana", "gps": {"lat": -33.4, "lon": -70.6}, "shutter_speed": "1/250"},
        ),
        db,
        _User(),
    )
    by_id = {f.id: f for f in out}
    for row in (by_id[jpg.id], by_id[raw.id]):
        assert row.creator == "Ana"
        assert (row.gps_lat, row.gps_lon) == (-33.4, -70.6)
        assert row.shutter_speed == "0.004"
        assert row.camera_make == "FUJIFILM"
        assert row.meta_edited is True

    summary = routes.staged_metadata_summary(session.id, schemas.StagedMetadataIds(file_ids=[jpg.id, raw.id]), db, _User())
    assert summary["values"]["creator"] == "Ana"
    assert summary["values"]["taken_at"] == "2026-07-01T12:00:00"
    assert summary["values"]["description"] == "from the file"
    assert summary["edited"] is True

    with pytest.raises(routes.HTTPException):
        routes.edit_staged_metadata(
            session.id, schemas.StagedMetadataEdit(file_ids=[jpg.id], fields={"iso": "abc"}), db, _User()
        )

    out = routes.revert_staged_metadata(session.id, schemas.StagedMetadataIds(file_ids=[raw.id]), db, _User())
    for row in out:
        assert row.creator == "Old" and row.gps_lat is None and row.meta_edited is False


def test_a_shift_moves_each_file_from_its_own_date_and_keeps_the_zone(db, dirs):
    session, jpg, raw = _pair(db, dirs / "archive")
    routes.edit_staged_metadata(
        session.id, schemas.StagedMetadataEdit(file_ids=[jpg.id, raw.id], shift_seconds=-7200), db, _User()
    )
    db.refresh(jpg)
    assert metadata_edit.staged_edits(jpg)["taken_at"] == "2026-07-01T10:00:00+02:00"


def test_commit_carries_the_edit_as_hand_edits(db, dirs):
    session, jpg, raw = _pair(db, dirs / "archive")
    routes.edit_staged_metadata(
        session.id,
        schemas.StagedMetadataEdit(
            file_ids=[jpg.id],
            fields={
                "taken_at": "2024-05-01T14:30",
                "gps": {"lat": -33.4, "lon": -70.6},
                "creator": "Ana",
                "camera_model": "X100",
                "description": "the market",
            },
        ),
        db,
        _User(),
    )
    images = import_pipeline.commit_import_session(db, session, 1)
    assert len(images) == 2
    for image in images:
        assert image.taken_at.replace(tzinfo=None) == datetime(2024, 5, 1, 14, 30)
        assert (image.gps_lat, image.gps_lon, image.gps_country) == (-33.4, -70.6, "Chile")
        assert image.creator == "Ana"
        assert image.camera_model == "X100"
        assert image.camera_make == "FUJIFILM"
        assert image.description == "the market"
        assert metadata_edit.edited_fields(image) == {"taken_at", "gps", "creator", "camera_model"}
