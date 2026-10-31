"""Find similar with a phrase: the phrase re-ranks the candidates, counts as
much as the reference, and leaves the search without one exactly as it was.
The model and the vector table are stood in for, so no weights are needed."""

from datetime import datetime

import numpy as np
import pytest
import sqlite_vec
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as routes
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import embeddings

REFERENCE = np.array([1.0, 0.0, 0.0], dtype=np.float32)
PHRASE = np.array([0.0, 1.0, 0.0], dtype=np.float32)


def _unit(*values: float) -> np.ndarray:
    v = np.array(values, dtype=np.float32)
    return v / np.linalg.norm(v)


VECTORS = {
    "ref": REFERENCE,
    "photo-only": _unit(1.0, 0.05, 0.0),
    "both": _unit(0.8, 0.6, 0.0),
    "text-only": _unit(0.05, 1.0, 0.0),
    "neither": _unit(0.0, 0.0, 1.0),
}


def _distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b))


@pytest.fixture()
def db(monkeypatch) -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    for image_id in VECTORS:
        session.add(
            Image(
                id=image_id,
                owner_id=1,
                file_path=f"2026/{image_id}.jpg",
                original_filename=f"{image_id}.jpg",
                file_hash=f"hash-{image_id}",
                file_type=FileType.jpeg,
                file_size=3,
                taken_at=datetime(2026, 7, 1, 12, 0, 0),
                gps_country="Italy" if image_id != "photo-only" else "France",
            )
        )
    session.commit()

    monkeypatch.setattr(
        routes,
        "_vectors_for",
        lambda _db, _owner, ids: ([session.get(Image, i) for i in ids], [VECTORS[i] for i in ids], []),
    )
    monkeypatch.setattr(embeddings, "encode_text", lambda q: PHRASE.copy())
    monkeypatch.setattr(
        embeddings,
        "query_similar",
        lambda engine, vector, k, min_distance=None: sorted(
            ((i, d) for i, d in ((i, _distance(v, vector)) for i, v in VECTORS.items()) if min_distance is None or d >= min_distance),
            key=lambda m: m[1],
        )[:k],
    )
    monkeypatch.setattr(
        embeddings, "get_embeddings", lambda engine, ids: {i: VECTORS[i] for i in ids if i in VECTORS}
    )
    yield session
    session.close()


def _pick(db: Session, **fields) -> list[str]:
    payload = schemas.AutoPickRequest(reference_ids=["ref"], **fields)
    return [r.image.id for r in routes.auto_pick_images(payload, db=db, current_user=db.get(User, 1))]


def test_a_phrase_moves_what_goes_with_both_to_the_front(db):
    assert _pick(db, count=4)[0] == "photo-only"
    picked = _pick(db, count=4, query="bauhaus style")
    assert picked[0] == "both"
    assert picked[-1] == "neither"
    assert "ref" not in picked


def test_without_a_phrase_the_model_is_not_asked(db, monkeypatch):
    def refuse(*_args):
        raise AssertionError("no phrase, no text model and no re-ranking")

    monkeypatch.setattr(embeddings, "encode_text", refuse)
    monkeypatch.setattr(embeddings, "get_embeddings", refuse)
    expected = ["photo-only", "both", "text-only", "neither"]
    assert _pick(db, count=4) == expected
    assert _pick(db, count=4, query=None) == expected
    assert _pick(db, count=4, query="   ") == expected


def test_the_similarity_floor_still_means_alike_the_reference(db):
    # 0.5 cosine: "text-only" would rank high on the phrase alone but is far
    # from the reference, so it stays out; the page still fills from the rest.
    picked = _pick(db, count=2, query="bauhaus style", min_similarity=0.5)
    assert picked == ["both", "photo-only"]


def test_a_phrase_works_inside_a_place(db):
    picked = _pick(db, count=4, country="Italy", query="bauhaus style")
    assert picked[0] == "both"
    assert "photo-only" not in picked


def test_a_ceiling_leaves_out_what_is_too_alike(db):
    assert _pick(db, count=3, max_similarity=0.9) == ["both", "text-only", "neither"]


def test_floor_and_ceiling_keep_only_the_band(db):
    assert _pick(db, count=4, min_similarity=0.5, max_similarity=0.9) == ["both"]


def test_a_ceiling_holds_with_a_phrase(db):
    # "photo-only" comes back among the phrase's neighbours and still stays out.
    picked = _pick(db, count=4, query="bauhaus style", max_similarity=0.9)
    assert picked[0] == "both"
    assert "photo-only" not in picked


def test_a_ceiling_inside_a_place_reaches_past_the_nearest(db, monkeypatch):
    # More near-duplicates than the usual count + 50 depth: without looking at
    # every candidate the page would come back empty.
    for n in range(60):
        image_id = f"near-{n}"
        monkeypatch.setitem(VECTORS, image_id, _unit(1.0, 0.01 * (n + 1) / 60, 0.0))
        db.add(
            Image(
                id=image_id,
                owner_id=1,
                file_path=f"2026/{image_id}.jpg",
                original_filename=f"{image_id}.jpg",
                file_hash=f"hash-{image_id}",
                file_type=FileType.jpeg,
                file_size=3,
                taken_at=datetime(2026, 7, 1, 12, 0, 0),
                gps_country="Italy",
            )
        )
    db.commit()
    assert _pick(db, count=1, country="Italy", max_similarity=0.9) == ["both"]


def test_query_similar_returns_the_nearest_beyond_the_limit():
    # The real vector table: the distance limit is part of the query, so k
    # counts what lies beyond it.
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _load(connection, _record):
        connection.enable_load_extension(True)
        sqlite_vec.load(connection)
        connection.enable_load_extension(False)

    embeddings.ensure_embeddings_table(engine)
    query = np.zeros(embeddings.EMBEDDING_DIM, dtype=np.float32)
    query[0] = 1.0
    for n in range(10):
        angle = n * 0.15
        vector = np.zeros(embeddings.EMBEDDING_DIM, dtype=np.float32)
        vector[0], vector[1] = np.cos(angle), np.sin(angle)
        embeddings.upsert_embedding(engine, f"p{n}", vector)

    assert [i for i, _ in embeddings.query_similar(engine, query, k=3)] == ["p0", "p1", "p2"]
    beyond = embeddings.query_similar(engine, query, k=3, min_distance=0.5)
    assert [i for i, _ in beyond] == ["p4", "p5", "p6"]
    assert all(d >= 0.5 for _, d in beyond)
