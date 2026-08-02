"""Emptying the Trash has to stay cheap per photo.

With the database on the same external drive as the photos, work that scales
badly per photo is what turned "delete forever" into a wait: the album and tag
collections were lazily loaded one photo at a time, and every single deletion
re-scanned the day folder it came from - a folder still holding hundreds of
files. Both are pinned here, because both are invisible in a small test library
and only bite on a real one.
"""

from collections import Counter

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import Album, AlbumImage, FileType, Image, ImageTag, Tag, User
from app.services import thumbnails
from app.services.trash import hard_delete_images


@pytest.fixture()
def library(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "library_root", tmp_path / "library")
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    (tmp_path / "library").mkdir()
    (tmp_path / "thumbs").mkdir()
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(User(id=1, username="local"))
    db.commit()
    return db, engine


def _fill(db, count: int) -> list[Image]:
    """`count` photos, all from the same day, each in an album and tagged."""
    tag = Tag(owner_id=1, name="holiday")
    album = Album(owner_id=1, name="Trip")
    db.add_all([tag, album])
    db.commit()
    images = []
    for i in range(count):
        relative = f"2026/2026-07-14/p{i}.jpg"
        path = settings.library_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
        image = Image(
            owner_id=1,
            file_path=relative,
            original_filename=f"p{i}.jpg",
            file_hash=f"hash-{i}",
            file_type=FileType.jpeg,
            file_size=1,
        )
        db.add(image)
        db.flush()
        db.add_all(
            [ImageTag(image_id=image.id, tag_id=tag.id), AlbumImage(album_id=album.id, image_id=image.id)]
        )
        images.append(image)
    db.commit()
    return images


def test_deleting_does_not_cost_a_query_per_album_and_tag(library):
    """The cascade needs both collections loaded; loading them per photo was
    three statements per photo. Two queries for the whole batch instead."""
    db, engine = library
    images = _fill(db, 50)

    seen: list[str] = []
    event.listen(engine, "before_cursor_execute", lambda *a: seen.append(a[2].split()[0]))
    hard_delete_images(db, images, delete_files=True)
    db.commit()

    kinds = Counter(seen)
    # Deliberately generous: this is a ceiling that catches "per photo" work
    # coming back, not a measurement of the current number.
    assert len(seen) < len(images) * 2, f"{len(seen)} statements for {len(images)} photos: {kinds}"
    assert db.query(Image).count() == 0
    assert db.query(ImageTag).count() == 0
    assert db.query(AlbumImage).count() == 0


def test_the_day_folder_is_scanned_once_not_once_per_photo(library, monkeypatch):
    db, _ = library
    images = _fill(db, 50)

    scans = {"count": 0}
    real_iterdir = type(settings.library_root).iterdir

    def counting_iterdir(self):
        scans["count"] += 1
        return real_iterdir(self)

    monkeypatch.setattr(type(settings.library_root), "iterdir", counting_iterdir)
    hard_delete_images(db, images, delete_files=True)
    db.commit()

    # One pass up the tree at the end (day folder, then year), not one per photo.
    assert scans["count"] <= 4, f"scanned directories {scans['count']} times for 50 photos"
    assert not (settings.library_root / "2026").exists()


def test_photos_without_derivatives_do_not_get_a_folder_conjured(library):
    """Deleting used to call derivative_dir(), which creates the folder before
    removing it - so a photo that never had derivatives still cost two metadata
    writes on the library drive."""
    db, _ = library
    images = _fill(db, 3)
    ids = [i.id for i in images]

    hard_delete_images(db, images, delete_files=True)
    db.commit()

    for image_id in ids:
        assert not thumbnails.derivative_path(image_id).exists()
