"""A RAW+JPEG pair is only a pair while both halves are on the same side of the
Trash.

Deleting one half used to leave the link dangling in both directions: the
surviving photo kept badging itself "RAW+JPG" (and its detail view still
offered the trashed half for viewing), and the trashed half showed up in the
Trash as "RAW+JPG" although only one file was actually in there. Both cleared
up only once the photo was deleted for good - which is when hard_delete_images
finally nulls the column.
"""

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.images import _apply_to_pair, library_index, list_trash
from app.db.base import Base
from app.db.models import FileType, Image, User


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


def _image(id: str, **extra) -> Image:
    fields = dict(
        id=id,
        owner_id=1,
        file_path=f"2026/2026-07-01/{id}.jpg",
        original_filename=f"{id}.jpg",
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=3,
        width=6000,
        height=4000,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
    )
    fields.update(extra)
    return Image(**fields)


@pytest.fixture()
def pair(db: Session) -> Session:
    """RAW "raw" + JPEG "jpg", linked symmetrically the way the importer does."""
    db.add(_image("jpg"))
    db.flush()
    db.add(_image("raw", file_type=FileType.raw, paired_image_id="jpg"))
    db.flush()
    db.get(Image, "jpg").paired_image_id = "raw"
    db.commit()
    return db


def _index(db: Session) -> dict[str, dict]:
    rows = json.loads(library_index(db=db, current_user=_User(), tags=None).body)["images"]
    return {row["id"]: row for row in rows}


def _trash(db: Session) -> dict[str, schemas.ImageOut]:
    return {
        image.id: schemas.ImageOut.model_validate(image)
        for image in list_trash(db=db, current_user=_User())
    }


def _trash_one(db: Session, image_id: str) -> None:
    db.get(Image, image_id).deleted_at = datetime.now(timezone.utc)
    db.commit()


def test_pair_is_reported_while_both_halves_are_in_the_library(pair):
    index = _index(pair)
    assert index["raw"]["paired_image_id"] == "jpg"
    assert index["jpg"]["paired_image_id"] == "raw"


def test_trashing_the_jpeg_leaves_the_raw_unpaired_in_the_library(pair):
    _trash_one(pair, "jpg")
    index = _index(pair)
    assert "jpg" not in index
    # The RAW is on its own now - badging it "RAW+JPG" would claim a JPEG that
    # the user just deleted, and the detail view would still show that JPEG.
    assert index["raw"]["paired_image_id"] is None


def test_the_trashed_jpeg_does_not_claim_a_partner_that_stayed_behind(pair):
    _trash_one(pair, "jpg")
    assert _trash(pair)["jpg"].paired_image_id is None


def test_a_whole_pair_in_the_trash_is_still_a_pair(pair):
    _trash_one(pair, "jpg")
    _trash_one(pair, "raw")
    trash = _trash(pair)
    assert trash["jpg"].paired_image_id == "raw"
    assert trash["raw"].paired_image_id == "jpg"


def test_restoring_the_jpeg_brings_the_pair_back(pair):
    _trash_one(pair, "jpg")
    pair.get(Image, "jpg").deleted_at = None
    pair.commit()
    index = _index(pair)
    assert index["raw"]["paired_image_id"] == "jpg"
    assert index["jpg"]["paired_image_id"] == "raw"


def test_a_single_photo_detail_hides_a_trashed_partner(pair):
    _trash_one(pair, "jpg")
    raw = schemas.ImageOut.model_validate(pair.get(Image, "raw"))
    assert raw.paired_image_id is None


def test_rating_the_survivor_does_not_reach_into_the_trashed_half(pair):
    # Merged view mirrors a rating onto the hidden partner. Once that partner is
    # in the Trash it isn't part of the pair any more (the client isn't even
    # told about it), so the mirror has to stop at the trash line.
    _trash_one(pair, "jpg")
    raw = pair.get(Image, "raw")
    raw.rating = 5
    _apply_to_pair(pair, 1, raw, 5, None)
    pair.commit()
    assert pair.get(Image, "jpg").rating == 0


def test_rating_still_mirrors_while_both_halves_are_in_the_library(pair):
    raw = pair.get(Image, "raw")
    raw.rating = 4
    _apply_to_pair(pair, 1, raw, 4, None)
    pair.commit()
    assert pair.get(Image, "jpg").rating == 4
