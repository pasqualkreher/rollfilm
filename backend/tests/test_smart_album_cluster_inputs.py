"""Which photos the Moments build feeds to the clusterer.

0.1.49 rebound the live-id set to a Query object while narrowing the RAW-pair
rule, so the later `image_id in live_ids` membership test compared plain ids
against result rows and never matched: every photo was filtered out and the
section came up empty. These tests pin the three inputs the build reads.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services.smart_albums import _cluster_inputs


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(id: str, **extra) -> Image:
    fields = dict(
        id=id,
        owner_id=1,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
    )
    fields.update(extra)
    return Image(**fields)


def test_live_photos_are_clusterable(db: Session):
    db.add_all([_image("keep"), _image("trashed", deleted_at=datetime(2026, 7, 2))])
    db.commit()

    live_ids, paired_raw_ids, meta = _cluster_inputs(db)

    # Plain string ids, so the caller's membership test works.
    assert live_ids == {"keep"}
    assert paired_raw_ids == set()
    assert meta["keep"] == (2026, None)


def test_raw_half_of_a_live_pair_is_dropped(db: Session):
    db.add_all(
        [
            _image("shot.jpg"),
            _image("shot.raf", file_type=FileType.raw, paired_image_id="shot.jpg"),
        ]
    )
    db.commit()

    live_ids, paired_raw_ids, _ = _cluster_inputs(db)

    assert live_ids == {"shot.jpg", "shot.raf"}
    assert paired_raw_ids == {"shot.raf"}


def test_raw_survives_when_its_jpeg_is_in_the_trash(db: Session):
    db.add_all(
        [
            _image("shot.jpg", deleted_at=datetime(2026, 7, 2)),
            _image("shot.raf", file_type=FileType.raw, paired_image_id="shot.jpg"),
        ]
    )
    db.commit()

    live_ids, paired_raw_ids, _ = _cluster_inputs(db)

    # The RAW is all that is left of that shot, so it must still cluster.
    assert live_ids == {"shot.raf"}
    assert paired_raw_ids == set()


def test_lone_raw_clusters(db: Session):
    db.add(_image("only.raf", file_type=FileType.raw))
    db.commit()

    _, paired_raw_ids, _ = _cluster_inputs(db)
    assert paired_raw_ids == set()


def test_country_and_year_metadata(db: Session):
    db.add_all(
        [
            _image("italy", gps_country="Italy", taken_at=datetime(2024, 5, 1)),
            _image("undated", taken_at=None),
        ]
    )
    db.commit()

    _, _, meta = _cluster_inputs(db)
    assert meta["italy"] == (2024, "Italy")
    assert meta["undated"] == (None, None)
