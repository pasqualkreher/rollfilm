"""The camera filters: make as a list, ISO, aperture and shutter speed as
ranges - on the list, the count, the facets and their cross-filtering. The
shutter range reaches both spellings of a stop ("0.004" and "1/250").
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import count_images, list_facets, list_images
from app.db.base import Base
from app.db.models import FileType, Image, User


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    shots = (
        ("fuji", dict(camera_make="FUJIFILM", camera_model="X-T5", iso=400, aperture=2.0, shutter_speed="0.004")),
        ("fuji2", dict(camera_make="FUJIFILM", camera_model="X-T5", iso=1600, aperture=1.4, shutter_speed="1/250")),
        ("sony", dict(camera_make="SONY", camera_model="ILCE-7M4", iso=6400, aperture=2.8, shutter_speed="2")),
        ("bare", {}),
    )
    for n, (id, extra) in enumerate(shots):
        session.add(Image(
            id=id, owner_id=1, file_path=f"2026/{id}.jpg", original_filename=f"{id}.jpg",
            file_hash=f"hash-{id}", file_type=FileType.jpeg, file_size=3,
            taken_at=datetime(2026, 7, 1, 12, 0, n), **extra,
        ))
    session.commit()
    yield session
    session.close()


def _ids(db, **kw) -> list[str]:
    kw.setdefault("tags", None)
    return sorted(i.id for i in list_images(limit=100, db=db, current_user=db.get(User, 1), **kw))


def _count(db, **kw) -> int:
    kw.setdefault("tags", None)
    return count_images(db=db, current_user=db.get(User, 1), **kw).count


def _facets(db, **kw):
    kw.setdefault("tags", None)
    return list_facets(db=db, current_user=db.get(User, 1), **kw)


def test_make_iso_and_aperture_filter_the_list(db):
    assert _ids(db) == ["bare", "fuji", "fuji2", "sony"]
    assert _ids(db, camera_make="SONY") == ["sony"]
    assert _ids(db, iso_min=400, iso_max=1600) == ["fuji", "fuji2"]
    assert _ids(db, iso_min=6400) == ["sony"]
    assert _ids(db, aperture_min=1.4, aperture_max=2.0) == ["fuji", "fuji2"]
    assert _ids(db, aperture_min=2.8) == ["sony"]


def test_a_shutter_range_reaches_both_spellings_of_a_stop(db):
    assert _ids(db, shutter_min=0.004, shutter_max=0.004) == ["fuji", "fuji2"]
    assert _ids(db, shutter_min=1.0) == ["sony"]
    assert _ids(db, shutter_max=0.01) == ["fuji", "fuji2"]
    assert _ids(db, shutter_min=0.01, shutter_max=0.5) == []
    assert _count(db, shutter_min=0.004, shutter_max=0.004) == 2


def test_facets_list_the_sliders_stops(db):
    f = _facets(db)
    assert [(m.value, m.count) for m in f.makes] == [("FUJIFILM", 2), ("SONY", 1)]
    assert [i.value for i in f.isos] == ["400", "1600", "6400"]
    assert [a.value for a in f.apertures] == ["1.4", "2", "2.8"]
    # One stop for 1/250 whichever way it is written, ordered by seconds.
    assert [(s.value, s.count) for s in f.shutters] == [("0.004", 2), ("2", 1)]
    assert [round(s.seconds, 4) for s in f.shutters] == [0.004, 2.0]


def test_facets_are_cross_filtered_but_keep_their_own_alternatives(db):
    f = _facets(db, iso_min=6400)
    assert [i.value for i in f.isos] == ["400", "1600", "6400"]
    assert [m.value for m in f.makes] == ["SONY"]
    assert [a.value for a in f.apertures] == ["2.8"]
    f = _facets(db, camera_make="FUJIFILM")
    assert [m.value for m in f.makes] == ["FUJIFILM", "SONY"]
    assert [s.value for s in f.shutters] == ["0.004"]
