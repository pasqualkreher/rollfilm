"""The culling flag (images.flag): pick / reject / none, set one at a time or
in bulk, mirrored onto the RAW+JPEG partner like the stars, and a filter of
the library listing."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.images import _filtered_images_query, bulk_update_images, update_image
from app.db.base import Base
from app.db.models import FileType, Image, User


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(id_: str, **kw) -> Image:
    base = dict(
        id=id_, owner_id=1, file_path=f"{id_}.jpg", original_filename=f"{id_}.jpg",
        file_hash=id_, file_type=FileType.jpeg, file_size=1,
    )
    base.update(kw)
    return Image(**base)


def test_a_flag_is_set_taken_off_and_mirrored_onto_the_partner(db, monkeypatch):
    from app.api.routes import images as routes
    monkeypatch.setattr(routes.sidecar_service, "touch", lambda *a, **k: None)
    user = db.get(User, 1)
    db.add(_image("jpg"))
    db.commit()
    db.add(_image("raw", file_type=FileType.raw, paired_image_id="jpg"))
    db.commit()
    db.get(Image, "jpg").paired_image_id = "raw"
    db.commit()

    out = update_image("jpg", schemas.ImageUpdate(flag="pick"), db, user)
    assert out.flag == "pick"
    assert db.get(Image, "raw").flag == "pick"

    update_image("raw", schemas.ImageUpdate(flag=""), db, user)
    assert db.get(Image, "jpg").flag is None
    assert db.get(Image, "raw").flag is None

    # Omitted leaves it alone.
    update_image("jpg", schemas.ImageUpdate(flag="reject"), db, user)
    update_image("jpg", schemas.ImageUpdate(rating=3), db, user)
    assert db.get(Image, "jpg").flag == "reject"


def test_bulk_flags_and_the_filter(db, monkeypatch):
    from app.api.routes import images as routes
    monkeypatch.setattr(routes.sidecar_service, "touch", lambda *a, **k: None)
    user = db.get(User, 1)
    for i in range(4):
        db.add(_image(f"p{i}"))
    db.commit()
    bulk_update_images(schemas.BulkImageUpdate(image_ids=["p0", "p1"], flag="pick"), db, user)
    bulk_update_images(schemas.BulkImageUpdate(image_ids=["p2"], flag="reject"), db, user)

    def ids(flag):
        q = _filtered_images_query(db, user, "combined", None, None, None, None, None, None, None, None, None, None, None, None, flag=flag)
        return sorted(i.id for i in q.all())

    assert ids("pick") == ["p0", "p1"]
    assert ids("reject") == ["p2"]
    assert ids("unflagged") == ["p3"]
    assert ids(None) == ["p0", "p1", "p2", "p3"]


def test_the_state_filter(db):
    from datetime import datetime, timezone
    user = db.get(User, 1)
    db.add(_image("edited", edit_rev=2))
    db.add(_image("rated", rating=3, gps_lat=1.0, gps_lon=2.0))
    db.add(_image("plain"))
    db.commit()

    def ids(state):
        q = _filtered_images_query(db, user, "combined", None, None, None, None, None, None, None, None, None, None, None, None, state=state)
        return sorted(i.id for i in q.all())

    assert ids("edited") == ["edited"]
    assert ids("unedited") == ["plain", "rated"]
    assert ids("unrated") == ["edited", "plain"]
    assert ids("located") == ["rated"]
    assert ids("unlocated") == ["edited", "plain"]
