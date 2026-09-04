"""The library index is the whole filtered library in one response, and the
grid lays itself out from it - so its exact shape is a contract with the
frontend, not an implementation detail.

It is also the largest synchronous thing the backend does: on a big library it
builds tens of thousands of rows on every first load and every new filter
combination. That is why it hand-builds its JSON and asks the database for
plain strings instead of mapped Enum/datetime objects. These tests pin the
output so that optimisation cannot quietly change what the client receives.
"""

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import library_index
from app.db.base import Base
from app.db.models import ColorLabel, FileType, Image, User


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


def _index(db: Session) -> list[dict]:
    # tags defaults to FastAPI's Query(None) marker, which only the framework
    # resolves - pass the real value when calling the endpoint directly.
    return json.loads(library_index(db=db, current_user=_User(), tags=None).body)["images"]


def test_a_photo_serialises_every_field_the_grid_needs(db):
    # The JPEG half exists first: paired_image_id is a real foreign key.
    db.add(_image("b", taken_at=datetime(2026, 6, 1, 12, 0, 0)))
    db.flush()
    db.add(
        _image(
            "a",
            file_type=FileType.raw,
            color_label=ColorLabel.yellow,
            rating=3,
            immich_sync=True,
            paired_image_id="b",
        )
    )
    db.commit()

    # Newest first, so the RAW under test comes before its older partner.
    assert _index(db)[0] == {
        "id": "a",
        "original_filename": "a.jpg",
        # Enums serialise as their VALUE, not "FileType.raw".
        "file_type": "raw",
        "width": 6000,
        "height": 4000,
        "taken_at": "2026-07-01T12:00:00",
        "rating": 3,
        "color_label": "yellow",
        "immich_sync": True,
        "paired_image_id": "b",
        "source_root_id": None,
        "thumb_version": "",
        "virtual_of_image_id": None,
    }


def test_capture_time_is_iso_seconds(db):
    """The client feeds this straight to `new Date(...)`. SQLite stores the
    column as "YYYY-MM-DD HH:MM:SS.ffffff"; neither the space separator nor a
    six-digit fraction is what the frontend has ever been given."""
    db.add(_image("a", taken_at=datetime(2026, 7, 1, 12, 34, 56)))
    db.commit()

    assert _index(db)[0]["taken_at"] == "2026-07-01T12:34:56"


def test_a_photo_without_a_capture_date_survives(db):
    """Photos whose EXIF hasn't been read yet have no date at all - the grid
    buckets them under "Unknown date" and must not get a crash instead."""
    db.add(_image("a", taken_at=None))
    db.commit()

    assert _index(db)[0]["taken_at"] is None


def test_immich_sync_is_a_real_boolean(db):
    """SQLite hands booleans back as 0/1, and the frontend puts this straight
    into a checkbox - a 0 would tick it."""
    db.add(_image("a", immich_sync=False))
    db.commit()

    synced = _index(db)[0]["immich_sync"]
    assert synced is False


def test_edited_photos_carry_their_cache_buster(db):
    """thumb_version is what makes a thumbnail URL change after an edit. Never
    edited (edit_rev 0) sends "" - the client substitutes its own default, so
    the vast majority of rows stay short."""
    db.add(_image("a", edit_rev=0))
    db.add(_image("b", edit_rev=7))
    db.commit()

    versions = {row["id"]: row["thumb_version"] for row in _index(db)}
    assert versions == {"a": "", "b": "7"}


def test_newest_first_with_deterministic_tie_breakers(db):
    """Burst shots share a capture second; without total ordering their
    relative order is whatever the planner felt like, and the grid reshuffles
    between requests. The tie-breakers descend WITH taken_at: filenames
    ascending inside a descending timeline made a multi-second burst zigzag
    (forward within each second, backward across seconds) when paging
    through it in the lightbox."""
    same = datetime(2026, 7, 1, 12, 0, 0)
    db.add(_image("c", taken_at=same, original_filename="b.jpg"))
    db.add(_image("a", taken_at=same, original_filename="a.jpg"))
    db.add(_image("b", taken_at=datetime(2026, 8, 1, 12, 0, 0), original_filename="z.jpg"))
    db.commit()

    assert [row["id"] for row in _index(db)] == ["b", "c", "a"]


def test_deleted_photos_are_not_in_the_index(db):
    db.add(_image("a"))
    db.add(_image("b", deleted_at=datetime(2026, 7, 2, 12, 0, 0)))
    db.commit()

    assert [row["id"] for row in _index(db)] == ["a"]
