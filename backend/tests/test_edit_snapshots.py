"""Named snapshots of a photo's edit, and lifting an edit to the current
process version. A snapshot is the whole PATCH /edits payload, geometry
included; restoring it and the upgrade both go through that save, so they
render and move the edit revision exactly as the editor's own save does."""

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import edit_snapshots as routes
from app.api.routes.images import save_edits
from app.db.base import Base
from app.db.models import EditSnapshot, FileType, Image, User
from app.services import develop, thumbnails, trash


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add(User(id=1, username="local"))
    session.commit()
    session.add(
        Image(
            id="photo",
            owner_id=1,
            file_path="2026/2026-07-01/photo.raf",
            original_filename="photo.raf",
            file_hash="hash-photo",
            file_type=FileType.raw,
            file_size=3,
            taken_at=datetime(2026, 7, 1, 12, 0, 0),
        )
    )
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def renders(monkeypatch) -> list[str]:
    """The derivative render, recorded instead of run."""
    done: list[str] = []
    monkeypatch.setattr(thumbnails, "regenerate_for_image", lambda image, slot_timeout=None: done.append(image.id))
    monkeypatch.setattr(thumbnails, "warm_full_cache", lambda image_id: None)
    monkeypatch.setattr(thumbnails, "defer_derivatives", lambda image_id: None)
    monkeypatch.setattr(thumbnails, "take_deferred", lambda image_id: False)
    return done


def _user(db: Session) -> User:
    return db.get(User, 1)


def _save(db: Session, **adjustments) -> Image:
    payload = schemas.ImageEdits(rotation=90, adjustments=adjustments)
    return save_edits("photo", payload, defer_derivatives=False, db=db, current_user=_user(db))


def test_a_snapshot_keeps_the_stored_edit_geometry_and_all(db, renders):
    _save(db, exposure=1.0)
    snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="bright"), db, _user(db))
    assert snap.name == "bright"
    assert snap.edits.rotation == 90
    assert snap.edits.adjustments["exposure"] == 1.0


def test_a_snapshot_of_the_editors_state_and_a_default_name(db, renders):
    edits = schemas.ImageEdits(flip_h=True, adjustments={"contrast": 20})
    snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(edits=edits), db, _user(db))
    assert snap.name == "Snapshot 1"
    assert snap.edits.flip_h and snap.edits.adjustments["contrast"] == 20
    # What a save would refuse is refused here too.
    with pytest.raises(HTTPException) as err:
        routes.create_snapshot(
            "photo", schemas.EditSnapshotCreate(edits=schemas.ImageEdits(rotation=45)), db, _user(db)
        )
    assert err.value.status_code == 400


def test_snapshots_list_newest_first(db, renders):
    for day, name in enumerate(("one", "two", "three"), start=1):
        snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(name=name), db, _user(db))
        db.get(EditSnapshot, snap.id).created_at = datetime(2026, 10, day)
    db.commit()
    assert [s.name for s in routes.list_snapshots("photo", db, _user(db))] == ["three", "two", "one"]


def test_restoring_writes_the_edit_and_moves_the_revision_like_a_save(db, renders):
    _save(db, exposure=1.0)
    snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="a"), db, _user(db))
    _save(db, exposure=-2.0)
    rev_before = db.get(Image, "photo").edit_rev
    renders.clear()

    image = routes.restore_snapshot("photo", snap.id, db, _user(db))

    assert develop.loads(image.edit_adjustments)["exposure"] == 1.0
    assert image.edit_rotation == 90
    assert renders == ["photo"]  # rendered, like PATCH /edits
    assert image.edit_rev > rev_before
    assert "edit" in image.tags


def test_deleting_a_snapshot(db, renders):
    snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="gone"), db, _user(db))
    routes.delete_snapshot("photo", snap.id, db, _user(db))
    assert routes.list_snapshots("photo", db, _user(db)) == []
    with pytest.raises(HTTPException) as err:
        routes.restore_snapshot("photo", snap.id, db, _user(db))
    assert err.value.status_code == 404


def test_a_snapshot_belongs_to_its_own_photo(db, renders):
    db.add(Image(id="other", owner_id=1, file_path="o.jpg", original_filename="o.jpg",
                 file_hash="o", file_type=FileType.jpeg, file_size=1))
    db.commit()
    snap = routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="mine"), db, _user(db))
    with pytest.raises(HTTPException):
        routes.delete_snapshot("other", snap.id, db, _user(db))


def test_deleting_the_photo_for_good_takes_its_snapshots(db, renders):
    routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="a"), db, _user(db))
    routes.create_snapshot("photo", schemas.EditSnapshotCreate(name="b"), db, _user(db))
    trash.hard_delete_images(db, [db.get(Image, "photo")], delete_files=False)
    db.commit()
    assert db.get(Image, "photo") is None
    assert db.query(EditSnapshot).count() == 0


def test_upgrade_lifts_the_process_and_renders(db, renders):
    image = _save(db, exposure=1.0, process="2")
    rev = image.edit_rev
    renders.clear()

    image = routes.upgrade_process("photo", db, _user(db))

    adj = develop.loads(image.edit_adjustments)
    assert adj["process"] == develop.CURRENT_PROCESS
    assert adj["exposure"] == 1.0 and image.edit_rotation == 90  # the rest stays
    assert renders == ["photo"] and image.edit_rev > rev
    # Already there: nothing is saved or rendered again.
    renders.clear()
    routes.upgrade_process("photo", db, _user(db))
    assert renders == []
