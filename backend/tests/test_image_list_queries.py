"""A page of the grid is a handful of queries, however many photos are on it.

Each photo's tags, albums and pair partner live in other rows. Left to lazy
loading they cost several small queries per photo - unnoticeable on an idle
backend, but each one has to win the interpreter back from whatever else is
running, so during a library merge or a batch of RAW renders a 200-photo page
took seconds and the grid looked stuck."""

from datetime import datetime

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.images import list_images
from app.db.base import Base
from app.db.models import Album, AlbumImage, FileType, Image, ImageTag, Tag, User


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _library(db: Session, shots: int) -> None:
    """`shots` RAW+JPEG pairs, every file tagged twice and in an album."""
    db.add(Album(id="trip", owner_id=1, name="Trip"))
    for name in ("iceland", "keeper"):
        db.add(Tag(id=f"tag-{name}", owner_id=1, name=name))
    for n in range(shots):
        halves = []
        for file_type, ext in ((FileType.raw, "RAF"), (FileType.jpeg, "JPG")):
            image = Image(
                id=f"{n}-{ext}",
                owner_id=1,
                file_path=f"2026/2026-07-01/DSCF{n:04d}.{ext}",
                original_filename=f"DSCF{n:04d}.{ext}",
                file_hash=f"hash-{n}-{ext}",
                file_type=file_type,
                file_size=3,
                taken_at=datetime(2026, 7, 1, 12, 0, n),
            )
            db.add(image)
            halves.append(image)
            db.add(AlbumImage(album_id="trip", image_id=image.id, position=n))
            for name in ("iceland", "keeper"):
                db.add(ImageTag(image_id=image.id, tag_id=f"tag-{name}"))
        halves[0].paired_image_id, halves[1].paired_image_id = halves[1].id, halves[0].id
    db.commit()


def _queries_for_a_page(db: Session) -> tuple[int, list[schemas.ImageOut]]:
    db.expire_all()
    user = db.get(User, 1)
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(db.get_bind(), "before_cursor_execute", count)
    try:
        rows = list_images(view_mode="raw_only", tags=None, limit=500, db=db, current_user=user)
        # What FastAPI does with the rows: this is where the tags, the albums
        # and the partner are read.
        page = [schemas.ImageOut.model_validate(row) for row in rows]
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", count)
    return len(statements), page


def test_a_bigger_page_costs_no_more_queries(db):
    _library(db, shots=3)
    few, page = _queries_for_a_page(db)
    assert len(page) == 3
    assert page[0].tags == ["iceland", "keeper"]
    assert page[0].album_ids == ["trip"]
    assert page[0].paired_image_id == f"{page[0].id.split('-')[0]}-JPG"

    db.query(ImageTag).delete()
    db.query(AlbumImage).delete()
    db.query(Image).delete()
    db.query(Tag).delete()
    db.query(Album).delete()
    db.commit()
    _library(db, shots=40)
    many, page = _queries_for_a_page(db)
    assert len(page) == 40

    assert many == few
    assert many <= 6
