"""The "Edited" smart album must collect exactly the photos with develop work:
in-place edits (edit_rev > 0) and saved edit copies (applied_adjustments)."""

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services.smart_albums import get_edits_album, get_time_albums


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


def test_edits_album_membership(db: Session):
    db.add_all(
        [
            _image("plain"),
            _image("edited", edit_rev=3, edit_adjustments=json.dumps({"exposure": 1.0})),
            _image("edit-copy", applied_adjustments=json.dumps({"contrast": 20})),
            _image("deleted-edit", edit_rev=1, deleted_at=datetime(2026, 7, 2)),
        ]
    )
    db.commit()

    albums = get_edits_album(db, owner_id=1)
    assert len(albums) == 1
    album = albums[0]
    assert album.id == "edits:all"
    # The plain photo and the trashed edit stay out; the in-place edit and the
    # edit copy are in.
    assert album.image_count == 2
    assert album.cover_image_id in {"edited", "edit-copy"}


def test_edits_album_hides_when_nothing_edited(db: Session):
    db.add(_image("plain"))
    db.commit()
    assert get_edits_album(db, owner_id=1) == []


def test_edits_album_carries_mosaic_covers(db: Session):
    db.add_all(
        [
            _image(f"e{i}", edit_rev=1, taken_at=datetime(2026, 7, 1, 10 + i))
            for i in range(6)
        ]
    )
    db.commit()
    album = get_edits_album(db, owner_id=1)[0]
    # Up to 4 covers, newest first, and the single cover is the first of them.
    assert album.cover_image_ids == ["e5", "e4", "e3", "e2"]
    assert album.cover_image_id == "e5"


def test_time_albums_carry_mosaic_covers(db: Session):
    db.add_all(
        [_image(f"t{i}", taken_at=datetime(2026, 7, 1, 8 + i)) for i in range(5)]
    )
    db.commit()
    years = get_time_albums(db, owner_id=1)["years"]
    assert len(years) == 1
    assert years[0].image_count == 5
    assert years[0].cover_image_ids == ["t4", "t3", "t2", "t1"]
    assert years[0].cover_image_id == "t4"


def test_mosaic_covers_prefer_jpegs_over_raws(db: Session):
    # 2 JPEGs among newer RAWs: the covers must be the JPEGs only - RAWs never
    # mix in, even though slots are free and the RAWs are newer.
    db.add_all(
        [
            _image("j0", taken_at=datetime(2026, 7, 1, 8)),
            _image("j1", taken_at=datetime(2026, 7, 1, 9)),
        ]
        + [
            _image(f"r{i}", file_type=FileType.raw, taken_at=datetime(2026, 7, 1, 10 + i))
            for i in range(4)
        ]
    )
    db.commit()
    years = get_time_albums(db, owner_id=1)["years"]
    assert years[0].image_count == 6
    assert years[0].cover_image_ids == ["j1", "j0"]
    assert years[0].cover_image_id == "j1"


def test_mosaic_covers_fall_back_to_raws(db: Session):
    db.add_all(
        [
            _image(f"r{i}", file_type=FileType.raw, taken_at=datetime(2026, 7, 1, 8 + i))
            for i in range(3)
        ]
    )
    db.commit()
    years = get_time_albums(db, owner_id=1)["years"]
    assert years[0].cover_image_ids == ["r2", "r1", "r0"]


def test_edits_covers_prefer_jpegs(db: Session):
    db.add_all(
        [
            _image("raw-edit", file_type=FileType.raw, edit_rev=1,
                   taken_at=datetime(2026, 7, 2, 12)),
            _image("jpg-edit", edit_rev=1, taken_at=datetime(2026, 7, 1, 12)),
        ]
    )
    db.commit()
    album = get_edits_album(db, owner_id=1)[0]
    assert album.image_count == 2
    assert album.cover_image_ids == ["jpg-edit"]
