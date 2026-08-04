"""The CLIP stage of search only ever returns photos the current view allows.

That scoping used to be done by loading every id in scope into a set and
testing the model's candidates against it - a full pass over the library on
every search. It now asks the database about the candidates instead, which is
the same answer for a fraction of the work; these tests pin the behaviour that
must not have changed with it.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.search import search_images
from app.db.base import Base
from app.db.models import ColorLabel, FileType, Image, User
from app.services import embeddings


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


@pytest.fixture()
def ranked(monkeypatch):
    """Stand in for the model: search gets whatever ranking the test sets, so
    these tests need neither the CLIP weights nor a vector table."""
    order: list[str] = []

    def _set(*image_ids: str) -> None:
        order[:] = list(image_ids)

    monkeypatch.setattr(embeddings, "encode_text", lambda q: [0.0])
    monkeypatch.setattr(
        embeddings,
        "query_similar",
        lambda engine, vector, k: [(i, 0.1 * n) for n, i in enumerate(order)],
    )
    return _set


def _search(db: Session, q: str, **kw):
    kw.setdefault("tags", None)
    return search_images(q=q, limit=10, db=db, current_user=db.get(User, 1), **kw)


def test_results_follow_the_model_ranking(db: Session, ranked):
    for name in ("a", "b", "c"):
        db.add(_image(name))
    db.commit()
    ranked("c", "a", "b")

    assert [r.image.id for r in _search(db, "sunset")] == ["c", "a", "b"]


def test_photos_outside_the_filters_are_dropped(db: Session, ranked):
    db.add(_image("keeper", rating=5))
    db.add(_image("filtered-out", rating=1))
    db.commit()
    # The model likes the low-rated one best; the active filter still wins.
    ranked("filtered-out", "keeper")

    assert [r.image.id for r in _search(db, "sunset", rating_min=4)] == ["keeper"]


def test_trashed_photos_never_come_back(db: Session, ranked):
    db.add(_image("live"))
    db.add(_image("trashed", deleted_at=datetime(2026, 7, 2, 9, 0, 0)))
    db.commit()
    ranked("trashed", "live")

    assert [r.image.id for r in _search(db, "sunset")] == ["live"]


def test_a_colour_filter_scopes_the_visual_stage(db: Session, ranked):
    db.add(_image("red", color_label=ColorLabel.red))
    db.add(_image("green", color_label=ColorLabel.green))
    db.commit()
    ranked("green", "red")

    assert [r.image.id for r in _search(db, "sunset", color_label=ColorLabel.red)] == ["red"]


def test_a_candidate_the_model_did_not_rank_is_not_invented(db: Session, ranked):
    db.add(_image("ranked"))
    db.add(_image("unranked"))
    db.commit()
    ranked("ranked")

    assert [r.image.id for r in _search(db, "sunset")] == ["ranked"]


def test_more_candidates_than_one_sql_chunk(db: Session, ranked):
    """The candidate ids go to SQLite in chunks (its parameter limit). Every
    chunk has to be asked about, or candidates past the first would silently
    drop out of every search."""
    names = [f"img{n:04d}" for n in range(1200)]
    for name in names:
        db.add(_image(name))
    db.commit()
    ranked(*names)

    # limit=10 caps the result, so check the tail explicitly: the last candidate
    # sits well past the chunk boundary and must still be findable.
    results = search_images(
        q="sunset", limit=1500, db=db, current_user=db.get(User, 1), tags=None
    )
    assert [r.image.id for r in results] == names
