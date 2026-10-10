"""A copy of a photo is found where the photo is found.

A physical copy (save-copy) and a virtual copy both take the source's user
tags, stars, label and note along, and the physical one the lens and the
country too; the app's own tags ("edit", "album: ...") stay with the source,
as does album membership. The copy's sidecar is written like after any tag
change.
"""

from datetime import datetime

import pytest
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_route
from app.config import settings
from app.db.base import Base
from app.db.models import Album, AlbumImage, ColorLabel, FileType, Image, User
from app.services import save_copy
from app.services import tags as tags_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


@pytest.fixture()
def stubs(tmp_path, monkeypatch):
    """No pixels: the render, the hash and the derivatives are not the point."""
    monkeypatch.setattr(settings, "library_root", tmp_path / "library")
    (tmp_path / "library").mkdir()
    monkeypatch.setattr(save_copy, "render_copy_frame", lambda *a, **k: PILImage.new("RGB", (8, 6), "red"))
    monkeypatch.setattr(save_copy.exif_service, "write_export_metadata", lambda *a, **k: None)
    monkeypatch.setattr(images_route.exif_service, "new_helper", lambda: _Helper())
    monkeypatch.setattr(save_copy.thumbnails, "regenerate_for_image", lambda *a, **k: None)
    monkeypatch.setattr(images_route.thumbnails, "regenerate_for_image", lambda *a, **k: None)
    monkeypatch.setattr(images_route, "schedule_embedding_backfill", lambda: None)
    touched: list[list[str]] = []
    monkeypatch.setattr(save_copy.sidecar_service, "touch", lambda db, images: touched.append([i.id for i in images]))
    return touched


class _Helper:
    def terminate(self):
        pass


def _source(db: Session) -> Image:
    src = Image(
        id="src",
        owner_id=1,
        file_path="2026/2026-07-01/DSCF0001.RAF",
        original_filename="DSCF0001.RAF",
        file_hash="hash-src",
        file_type=FileType.raw,
        file_size=3,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
        lens_model="XF 35mm F1.4",
        gps_country="DE",
        rating=4,
        color_label=ColorLabel.red,
        description="the lake at dusk",
        edit_adjustments='{"exposure": 0.5}',
        edit_rev=2,
    )
    db.add(src)
    db.flush()
    for name in ("Travel/Norway", "family", "edit", "album: Summer"):
        tags_service.add_tag_to_image(db, 1, src, name)
    album = Album(id="alb", owner_id=1, name="Summer")
    db.add(album)
    db.flush()
    db.add(AlbumImage(album_id="alb", image_id="src"))
    db.commit()
    return src


def _albums_of(db: Session, image_id: str) -> list[str]:
    return [a.album_id for a in db.query(AlbumImage).filter_by(image_id=image_id)]


def test_a_saved_copy_takes_the_sources_tags_and_fields_along(db, stubs):
    src = _source(db)
    user = db.get(User, 1)

    copy = images_route.save_copy("src", schemas.ImageEdits(adjustments={"contrast": 10}), db=db, current_user=user)

    assert sorted(copy.tags) == ["Travel/Norway", "edit copy", "family"]
    assert copy.rating == 4 and copy.color_label == ColorLabel.red and copy.description == "the lake at dusk"
    assert copy.lens_model == "XF 35mm F1.4" and copy.gps_country == "DE"
    assert _albums_of(db, copy.id) == [] and _albums_of(db, "src") == ["alb"]
    assert stubs == [[copy.id]]
    # The source is left as it was.
    assert sorted(src.tags) == ["Travel/Norway", "album: Summer", "edit", "family"]


def test_a_virtual_copy_takes_the_templates_tags_along(db, stubs):
    _source(db)
    user = db.get(User, 1)

    copy = images_route.create_virtual_copy("src", db=db, current_user=user)

    assert sorted(copy.tags) == ["Travel/Norway", "edit", "family", "virtual copy"]
    assert copy.rating == 4 and copy.description == "the lake at dusk"
    assert _albums_of(db, copy.id) == []
    # No file of its own, so no sidecar to write.
    assert stubs == []


def test_a_copy_of_a_copy_carries_the_tags_on(db, stubs):
    _source(db)
    user = db.get(User, 1)
    first = images_route.create_virtual_copy("src", db=db, current_user=user)
    tags_service.add_tag_to_image(db, 1, first, "pick")
    db.commit()

    second = images_route.create_virtual_copy(first.id, db=db, current_user=user)

    # Tags come from the template (the copy chosen), the file from its ground.
    assert sorted(second.tags) == ["Travel/Norway", "edit", "family", "pick", "virtual copy"]
    assert second.virtual_of_image_id == "src"
