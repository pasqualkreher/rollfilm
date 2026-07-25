"""Search must expose RAW+JPEG pairs exactly like the library index does: a
match on either half returns *both* halves (JPEG first), so the grid's merge
toggle behaves identically in search and in the library - collapsing the pair
onto its JPEG when merged, and showing the RAW next to the JPEG when unmerged.

The ranked, limit-capped search result set frequently carries only one half of a
pair, so the client-side pair logic can't complete it - the missing partner has
to be added server-side."""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.search import search_images
from app.db.base import Base
from app.db.models import FileType, Image, ImageTag, Tag, User


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(id: str, file_type: FileType, **extra) -> Image:
    ext = "raw" if file_type == FileType.raw else "jpg"
    fields = dict(
        id=id,
        owner_id=1,
        file_path=f"2026/2026-07-01/{id}.{ext}",
        original_filename=f"{id}.{ext}",
        file_hash=f"hash-{id}",
        file_type=file_type,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
    )
    fields.update(extra)
    return Image(**fields)


def _tag(db: Session, image_id: str, name: str) -> None:
    tag = db.query(Tag).filter_by(owner_id=1, name=name).first()
    if tag is None:
        tag = Tag(id=f"tag-{name}", owner_id=1, name=name)
        db.add(tag)
        db.flush()
    db.add(ImageTag(image_id=image_id, tag_id=tag.id))


def _search(db: Session, q: str, **kw):
    # limit=1 keeps the whole thing in the tag stage: with the slot filled, the
    # location and CLIP-embedding stages are skipped, so the test needs neither
    # the geocoder dataset nor the CLIP model.
    user = db.get(User, 1)
    # tags defaults to a FastAPI Query() sentinel when the function is called
    # directly rather than through the router, so pass it explicitly.
    kw.setdefault("tags", None)
    return search_images(q=q, limit=1, db=db, current_user=user, **kw)


def test_raw_match_returns_both_halves_jpeg_first(db: Session):
    raw = _image("shot.raw", FileType.raw, paired_image_id="shot.jpg")
    jpeg = _image("shot.jpg", FileType.jpeg, paired_image_id="shot.raw")
    db.add_all([raw, jpeg])
    db.flush()
    _tag(db, "shot.raw", "sunset")  # only the RAW half carries the tag
    db.commit()

    # Both halves come back (JPEG first) even though only the RAW matched and the
    # limit is 1 - so merged view can collapse onto the JPEG and unmerged view
    # can show the RAW beside it, just like the library.
    results = _search(db, "sunset")
    assert [r.image.id for r in results] == ["shot.jpg", "shot.raw"]


def test_jpeg_match_pulls_in_raw_partner(db: Session):
    # Symmetric direction: the JPEG matched, but the RAW partner must also come
    # back so the unmerged view can place them side by side.
    raw = _image("shot.raw", FileType.raw, paired_image_id="shot.jpg")
    jpeg = _image("shot.jpg", FileType.jpeg, paired_image_id="shot.raw")
    db.add_all([raw, jpeg])
    db.flush()
    _tag(db, "shot.jpg", "sunset")
    db.commit()

    results = _search(db, "sunset")
    assert [r.image.id for r in results] == ["shot.jpg", "shot.raw"]


def test_raw_without_jpeg_partner_is_kept(db: Session):
    # A lone RAW (no JPEG sibling) must still be returned - there's nothing to
    # substitute.
    db.add(_image("lonely.raw", FileType.raw))
    db.flush()
    _tag(db, "lonely.raw", "sunset")
    db.commit()

    results = _search(db, "sunset")
    assert [r.image.id for r in results] == ["lonely.raw"]


def test_raw_only_view_keeps_the_raw(db: Session):
    # In the raw_only view the user explicitly wants RAWs; no JPEG substitution.
    raw = _image("shot.raw", FileType.raw, paired_image_id="shot.jpg")
    jpeg = _image("shot.jpg", FileType.jpeg, paired_image_id="shot.raw")
    db.add_all([raw, jpeg])
    db.flush()
    _tag(db, "shot.raw", "sunset")
    db.commit()

    results = _search(db, "sunset", view_mode="raw_only")
    assert [r.image.id for r in results] == ["shot.raw"]
