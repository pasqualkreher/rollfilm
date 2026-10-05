"""The Selects tray is stored with the library: it comes back after a restart,
holds each photo once in the order it was added, and lets go of photos that
are in the Trash or gone."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.selects import read_selects, write_selects
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services.settings_store import get_selects, set_selects


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    for id in ("a", "b", "c"):
        session.add(
            Image(
                id=id,
                owner_id=1,
                file_path=f"2026/2026-07-01/{id}.jpg",
                original_filename=f"{id}.jpg",
                file_hash=f"hash-{id}",
                file_type=FileType.jpeg,
                file_size=3,
            )
        )
    session.commit()
    yield session
    session.close()


def _user(db: Session) -> User:
    return db.get(User, 1)


def test_an_untouched_library_has_an_empty_tray(db):
    assert read_selects(db, _user(db)).ids == []


def test_the_tray_is_stored_in_order_and_each_photo_once(db):
    saved = write_selects(schemas.Selects(ids=["c", "a", "c", "b"]), db, _user(db))
    assert saved.ids == ["c", "a", "b"]
    assert read_selects(db, _user(db)).ids == ["c", "a", "b"]


def test_photos_that_do_not_exist_are_not_kept(db):
    saved = write_selects(schemas.Selects(ids=["a", "from-another-library"]), db, _user(db))
    assert saved.ids == ["a"]
    assert get_selects(db) == ["a"]


def test_a_photo_in_the_trash_is_out_of_the_tray(db):
    write_selects(schemas.Selects(ids=["a", "b"]), db, _user(db))
    db.get(Image, "b").deleted_at = datetime(2026, 7, 10, tzinfo=timezone.utc)
    db.commit()
    assert read_selects(db, _user(db)).ids == ["a"]


def test_a_stored_tray_that_cannot_be_read_counts_as_empty(db):
    from app.services.settings_store import SELECTS, set_setting

    set_setting(db, SELECTS, "{not json")
    db.commit()
    assert read_selects(db, _user(db)).ids == []
    set_selects(db, ["a"])
    db.commit()
    assert read_selects(db, _user(db)).ids == ["a"]
