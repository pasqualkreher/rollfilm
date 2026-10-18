"""Recent imports: one smart album per day photos came in (imported_at)."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import _filtered_images_query
from app.db.base import Base
from app.db.models import FileType, Image, ImportSession, ImportSessionStatus, User
from app.services import smart_albums


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(id_: str, imported: datetime) -> Image:
    return Image(
        id=id_, owner_id=1, file_path=f"{id_}.jpg", original_filename=f"{id_}.jpg",
        file_hash=id_, file_type=FileType.jpeg, file_size=1,
        taken_at=datetime(2020, 1, 1, tzinfo=timezone.utc), imported_at=imported,
    )


def test_one_album_per_import_day_newest_first(db):
    db.add(_image("a", datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc)))
    db.add(_image("b", datetime(2026, 10, 12, 18, 0, tzinfo=timezone.utc)))
    db.add(_image("c", datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)))
    db.commit()

    albums = smart_albums.get_import_albums(db, 1)

    assert [a.id for a in albums] == ["imported:2026-10-12", "imported:2026-10-01"]
    assert albums[0].image_count == 2
    assert albums[0].name == "October 12, 2026"

    user = db.get(User, 1)
    q = _filtered_images_query(db, user, "combined", None, None, None, None, None, None, None, None, None, None, None, None, imported="2026-10-12")
    assert sorted(i.id for i in q.all()) == ["a", "b"]


def _roll(db, id_: str, name: str, created: datetime, status=ImportSessionStatus.committed) -> ImportSession:
    session = ImportSession(id=id_, owner_id=1, source_path=name, status=status, created_at=created)
    db.add(session)
    db.commit()
    return session


def test_one_album_per_roll_newest_first(db):
    _roll(db, "r1", "Norway", datetime(2026, 10, 1, tzinfo=timezone.utc))
    _roll(db, "r2", "DCIM", datetime(2026, 10, 12, tzinfo=timezone.utc))
    # A roll nothing came out of (discarded) and an open session are no rolls.
    _roll(db, "r3", "Empty", datetime(2026, 10, 13, tzinfo=timezone.utc), status=ImportSessionStatus.discarded)
    _roll(db, "r4", "Open", datetime(2026, 10, 14, tzinfo=timezone.utc), status=ImportSessionStatus.staging)
    for id_, roll, taken, camera in [
        ("a", "r1", datetime(2026, 7, 12, tzinfo=timezone.utc), "X-T5"),
        ("b", "r1", datetime(2026, 7, 14, tzinfo=timezone.utc), "X-T5"),
        ("c", "r1", datetime(2026, 7, 13, tzinfo=timezone.utc), "X100V"),
        ("d", "r2", datetime(2026, 9, 1, tzinfo=timezone.utc), None),
        ("e", "r3", datetime(2026, 9, 1, tzinfo=timezone.utc), None),
        ("f", "r4", datetime(2026, 9, 1, tzinfo=timezone.utc), None),
    ]:
        image = _image(id_, datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc))
        image.import_session_id = roll
        image.taken_at = taken
        image.camera_model = camera
        db.add(image)
    db.commit()

    albums = smart_albums.get_roll_albums(db, 1)

    assert [a.id for a in albums] == ["roll:r2", "roll:r1"]
    norway = albums[1]
    assert (norway.name, norway.image_count, norway.group) == ("Norway", 3, "2026")
    assert norway.roll["taken_from"] == datetime(2026, 7, 12)
    assert norway.roll["taken_to"] == datetime(2026, 7, 14)
    assert norway.roll["cameras"] == ["X-T5", "X100V"]
    assert set(norway.cover_image_ids) == {"a", "b", "c"}

    user = db.get(User, 1)
    q = _filtered_images_query(db, user, "combined", None, None, None, None, None, None, None, None, None, None, None, None, roll="r1")
    assert sorted(i.id for i in q.all()) == ["a", "b", "c"]


def test_photos_without_a_roll_fall_back_to_import_days(db):
    _roll(db, "r1", "Norway", datetime(2026, 10, 1, tzinfo=timezone.utc))
    with_roll = _image("a", datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc))
    with_roll.import_session_id = "r1"
    db.add(with_roll)
    db.add(_image("b", datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)))
    db.commit()

    assert [a.id for a in smart_albums.get_import_albums(db, 1)] == ["imported:2026-10-01"]
