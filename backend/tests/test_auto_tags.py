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
from app.api.routes.tags import delete_tag, prune_unused_tags, tag_usage
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


def test_auto_tags_cannot_be_deleted_or_pruned(db: Session):
    db.add_all([Tag(id="t-edit", owner_id=1, name="edit"), Tag(id="t-old", owner_id=1, name="old")])
    db.commit()

    with pytest.raises(HTTPException) as exc:
        delete_tag("edit", db, _User())
    assert exc.value.status_code == 400

    result = prune_unused_tags(db, _User())
    assert result.removed == ["old"]
    assert [u.name for u in tag_usage(db, _User())] == ["edit"]


def test_tag_reset_keeps_auto_tags(db: Session):
    image = db.get(Image, "img")
    _add_tag_to_image(db, 1, image, "virtual copy")
    _add_tag_to_image(db, 1, image, "edit copy")
    _add_tag_to_image(db, 1, image, "travel")
    db.commit()

    bulk_reset_metadata(BulkResetRequest(image_ids=["img"], tags=True), db, _User())
    assert sorted(db.get(Image, "img").tags) == ["edit copy", "virtual copy"]
