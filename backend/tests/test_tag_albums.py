"""Tag-rule albums: an album may carry a tag_filter (list of tag names), and
photos with ANY of those tags are members automatically, alongside manually
added ones - the images listing, the album card count and the cover mosaic all
have to agree on that membership.

Also covers the Moments sibling naming: same-label clusters get distinguishing
qualifiers (scene / country / year) instead of the old "Mountains II" numbers,
and share a group label for the UI's tree row.
"""

import json
from datetime import datetime

import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes.albums import _to_album_out, create_album, update_album
from app.api.routes.images import list_images
from app.db.base import Base
from app.db.models import Album, AlbumImage, FileType, Image, ImageTag, Tag, User
from app.services import smart_albums


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


def _image(id: str, file_type: FileType = FileType.jpeg, **extra) -> Image:
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


def _list(db: Session, album_id: str):
    user = db.get(User, 1)
    return list_images(album_id=album_id, tags=None, db=db, current_user=user)


def test_tag_rule_album_lists_manual_and_tagged_members_once(db: Session):
    manual = _image("manual")
    tagged = _image("tagged")
    both = _image("both")
    other = _image("other")
    db.add_all([manual, tagged, both, other])
    album = Album(id="alb", owner_id=1, name="Beach", tag_filter=json.dumps(["beach"]))
    db.add(album)
    db.add(AlbumImage(album_id="alb", image_id="manual", position=0))
    db.add(AlbumImage(album_id="alb", image_id="both", position=1))
    db.flush()
    _tag(db, "tagged", "beach")
    _tag(db, "both", "beach")
    _tag(db, "other", "holiday")  # different tag - not a member
    db.commit()

    ids = [image.id for image in _list(db, "alb")]
    assert sorted(ids) == ["both", "manual", "tagged"]  # each exactly once

    out = _to_album_out(db, album)
    assert out.image_count == 3
    assert out.tag_filter == ["beach"]
    # Manual members keep their curated cover slots, tag members fill the rest.
    assert set(out.cover_image_ids) == {"manual", "both", "tagged"}


def test_album_without_rule_stays_manual_only(db: Session):
    member = _image("member")
    tagged = _image("tagged")
    db.add_all([member, tagged])
    album = Album(id="alb", owner_id=1, name="Plain")
    db.add(album)
    db.add(AlbumImage(album_id="alb", image_id="member", position=0))
    db.flush()
    _tag(db, "tagged", "beach")
    db.commit()

    assert [image.id for image in _list(db, "alb")] == ["member"]
    assert _to_album_out(db, album).image_count == 1


def test_create_and_update_normalize_the_rule(db: Session):
    user = db.get(User, 1)
    out = create_album(
        schemas.AlbumCreate(name="Trips", tag_filter=[" beach ", "beach", "", "family"]),
        db=db,
        current_user=user,
    )
    assert out.tag_filter == ["beach", "family"]

    out = update_album(out.id, schemas.AlbumUpdate(tag_filter=["family"]), db=db, current_user=user)
    assert out.tag_filter == ["family"]

    # Empty list clears the rule (back to a plain manual album)...
    out = update_album(out.id, schemas.AlbumUpdate(tag_filter=[]), db=db, current_user=user)
    assert out.tag_filter == []
    assert db.get(Album, out.id).tag_filter is None

    # ...while omitting the field leaves it untouched.
    update_album(out.id, schemas.AlbumUpdate(tag_filter=["beach"]), db=db, current_user=user)
    out = update_album(out.id, schemas.AlbumUpdate(name="Renamed"), db=db, current_user=user)
    assert out.tag_filter == ["beach"]


def test_tags_smart_album_section(db: Session):
    db.add_all([_image("a"), _image("b"), _image("c"), _image("untagged")])
    db.flush()
    _tag(db, "a", "beach")
    _tag(db, "b", "beach")
    _tag(db, "c", "family")
    db.commit()

    albums = smart_albums.get_tag_albums(db, 1)
    assert [(a.name, a.image_count) for a in albums] == [("beach", 2), ("family", 1)]
    assert albums[0].id == "tag:beach"
    assert set(albums[0].cover_image_ids) == {"a", "b"}

    from app.api.routes.smart_albums import smart_album_images

    user = db.get(User, 1)
    images = smart_album_images("tag:beach", db=db, current_user=user)
    assert sorted(image.id for image in images) == ["a", "b"]


# ---------------------------------------------------------------------------
# Moments sibling naming


def _no_qualifier_hits(monkeypatch):
    """Zero out the CLIP scene qualifiers so the fallbacks are exercised
    without loading the model."""
    monkeypatch.setattr(
        smart_albums,
        "_get_qualifier_matrix",
        lambda: np.zeros((len(smart_albums._QUALIFIERS), 4), dtype=np.float32),
    )


def test_sibling_names_fall_back_to_country_then_year(monkeypatch):
    _no_qualifier_hits(monkeypatch)
    group = [
        {"members": [0], "centroid": np.ones(4, dtype=np.float32)},
        {"members": [1], "centroid": np.ones(4, dtype=np.float32)},
        {"members": [2], "centroid": np.ones(4, dtype=np.float32)},
    ]
    ids = ["p0", "p1", "p2"]
    meta = {
        "p0": (2023, "Italy"),
        "p1": (2024, "Italy"),  # country taken -> falls through to its year
        "p2": (None, None),  # nothing to qualify with -> numbered
    }
    names = smart_albums._sibling_names("Mountains", group, ids, meta)
    assert names == ["Mountains · Italy", "Mountains · 2024", "Mountains"]


def test_sibling_names_number_as_last_resort(monkeypatch):
    _no_qualifier_hits(monkeypatch)
    group = [
        {"members": [0], "centroid": np.ones(4, dtype=np.float32)},
        {"members": [1], "centroid": np.ones(4, dtype=np.float32)},
    ]
    names = smart_albums._sibling_names("Mountains", group, ["p0", "p1"], {})
    assert names == ["Mountains", "Mountains II"]


def test_build_clusters_groups_same_label_siblings(monkeypatch):
    # Two orthogonal bundles -> two clusters; a single label row equally
    # similar to both centroids -> the same base label for both.
    e1 = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    e2 = np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32)
    size = smart_albums.MIN_CLUSTER_SIZE
    ids = [f"a{i}" for i in range(size)] + [f"b{i}" for i in range(size)]
    vecs = np.stack([e1] * size + [e2] * size)
    label = ((e1 + e2) / np.linalg.norm(e1 + e2)).reshape(1, -1)
    monkeypatch.setattr(smart_albums, "_get_label_matrix", lambda: label)
    _no_qualifier_hits(monkeypatch)

    meta = {f"a{i}": (2023, "Italy") for i in range(size)}
    meta.update({f"b{i}": (2024, "Austria") for i in range(size)})
    clusters = smart_albums._build_clusters(ids, vecs, meta)

    base = smart_albums._LABELS[0][0]  # argmax over the single label row
    assert [c.group for c in clusters] == [base, base]
    assert {c.name for c in clusters} == {f"{base} · Italy", f"{base} · Austria"}
    for cluster in clusters:
        assert len(cluster.image_ids) == size
        assert cluster.cover_image_id in cluster.image_ids
