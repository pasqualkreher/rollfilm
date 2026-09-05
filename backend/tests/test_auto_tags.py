"""The auto-managed tags ("edit", "edit copy", "virtual copy") belong to the app:
a user can neither hand them out nor take them away, and a tag reset leaves
them on the photo."""

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import (
    _add_tag_to_image,
    add_tag,
    bulk_add_tags,
    bulk_reset_metadata,
    remove_tag,
)
from app.api.routes.tags import delete_tag, list_tags, tag_usage
from app.db.base import Base
from app.db.models import FileType, Image, Tag, User
from app.schemas import AddTagRequest, BulkResetRequest, BulkTagRequest


class _User:
    id = 1


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    session.add(
        Image(
            id="img",
            owner_id=1,
            file_path="2026/2026-07-01/img.jpg",
            original_filename="img.jpg",
            file_hash="hash-img",
            file_type=FileType.jpeg,
            file_size=3,
            taken_at=datetime(2026, 7, 1, 12, 0, 0),
        )
    )
    session.commit()
    yield session
    session.close()


@pytest.mark.parametrize("name", ["edit", "edit copy", "virtual copy", "Edit", " EDIT COPY "])
def test_auto_tags_cannot_be_added_by_hand(db: Session, name: str):
    with pytest.raises(HTTPException) as exc:
        add_tag("img", AddTagRequest(name=name), db, _User())
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException) as exc:
        bulk_add_tags(BulkTagRequest(image_ids=["img"], tag_names=["travel", name]), db, _User())
    assert exc.value.status_code == 400
    assert db.get(Image, "img").tags == []


def test_auto_tags_cannot_be_removed_from_a_photo(db: Session):
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "edit copy")
    _add_tag_to_image(db, 1, image, "travel")
    db.commit()

    with pytest.raises(HTTPException) as exc:
        remove_tag("img", "edit copy", db, _User())
    assert exc.value.status_code == 400
    remove_tag("img", "travel", db, _User())
    assert db.get(Image, "img").tags == ["edit copy"]


def test_auto_tags_cannot_be_deleted_by_hand(db: Session):
    db.add(Tag(id="t-edit", owner_id=1, name="edit"))
    db.commit()
    with pytest.raises(HTTPException) as exc:
        delete_tag("edit", db, _User())
    assert exc.value.status_code == 400


def test_a_tag_disappears_with_its_last_photo(db: Session):
    """Tags clean up after themselves: the last photo dropping one takes the
    row with it, so the filter list never fills with tags nobody carries."""
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "travel")
    _add_tag_to_image(db, 1, image, "sea")
    db.commit()
    remove_tag("img", "travel", db, _User())
    assert [t.name for t in db.query(Tag).order_by(Tag.name)] == ["sea"]

    bulk_reset_metadata(BulkResetRequest(image_ids=["img"], tags=True), db, _User())
    assert db.query(Tag).count() == 0


def test_the_tag_list_offers_only_what_live_photos_carry(db: Session):
    """A tag that only trashed photos still carry is nothing to filter for -
    it leaves the list with the photo and comes back with a restore."""
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "travel")
    db.commit()
    assert list_tags(db, _User()) == ["travel"]
    image.deleted_at = datetime(2026, 8, 1, 9, 0, 0)
    db.commit()
    assert list_tags(db, _User()) == []
    image.deleted_at = None
    db.commit()
    assert list_tags(db, _User()) == ["travel"]


def test_settings_lists_only_the_users_own_tags_and_deletes_them_outright(db: Session):
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "travel")
    _add_tag_to_image(db, 1, image, "edit")
    db.commit()
    assert [(u.name, u.count) for u in tag_usage(db, _User())] == [("travel", 1)]

    delete_tag("travel", db, _User())
    assert db.get(Image, "img").tags == ["edit"]
    assert tag_usage(db, _User()) == []


def test_tag_reset_keeps_auto_tags(db: Session):
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "virtual copy")
    _add_tag_to_image(db, 1, image, "edit copy")
    _add_tag_to_image(db, 1, image, "travel")
    db.commit()

    bulk_reset_metadata(BulkResetRequest(image_ids=["img"], tags=True), db, _User())
    assert sorted(db.get(Image, "img").tags) == ["edit copy", "virtual copy"]
