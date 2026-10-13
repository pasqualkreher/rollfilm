"""Recent imports: one smart album per day photos came in (imported_at)."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import _filtered_images_query
from app.db.base import Base
from app.db.models import FileType, Image, User
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
