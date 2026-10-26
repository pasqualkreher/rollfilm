"""/images/{id}/export with format=jpeg: the canvas export's smaller photos.

The layout export can ask for a photo capped to the size its print needs and
encoded as JPEG (with the sRGB profile, like a saved copy). Without parameters
the route stays what it was: original bytes, or a lossless PNG for an edit.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import io
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.responses import FileResponse
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import get_export
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User


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


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    cache = tmp_path / "thumbs"
    cache.mkdir()
    monkeypatch.setattr(settings, "thumbnail_cache_root", cache)
    return root


def _add(db: Session, library: Path, name: str, content: bytes) -> Image:
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True, exist_ok=True)
    (day / name).write_bytes(content)
    from app.services.hashing import sha256_file

    image = Image(
        id=name,
        owner_id=1,
        file_path=str((day / name).relative_to(library)),
        original_filename=name,
        file_hash=sha256_file(day / name),
        file_type=FileType.jpeg,
        file_size=len(content),
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def _jpeg(size=(1600, 1000)) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", size, "teal").save(buf, "JPEG", quality=70)
    return buf.getvalue()


def _crop(db: Session, image: Image) -> None:
    image.edit_crop_x, image.edit_crop_y = 0.0, 0.0
    image.edit_crop_width, image.edit_crop_height = 0.5, 1.0
    db.commit()


def test_jpeg_with_max_size_is_capped_and_tagged_srgb(db, library):
    image = _add(db, library, "plain.jpg", _jpeg())
    response = get_export(image.id, db, _User(), format="jpeg", quality=80, max_size=800)
    assert not isinstance(response, FileResponse)
    assert response.media_type == "image/jpeg"
    out = PILImage.open(io.BytesIO(response.body))
    assert out.format == "JPEG"
    assert max(out.size) <= 800
    assert out.info.get("icc_profile")


def test_edited_photo_as_jpeg_is_capped(db, library):
    image = _add(db, library, "edited.jpg", _jpeg())
    _crop(db, image)
    response = get_export(image.id, db, _User(), format="jpeg", quality=92, max_size=600)
    assert response.media_type == "image/jpeg"
    out = PILImage.open(io.BytesIO(response.body))
    assert max(out.size) <= 600
    assert out.info.get("icc_profile")


def test_unedited_jpeg_that_already_fits_goes_out_as_itself(db, library):
    content = _jpeg()
    image = _add(db, library, "fits.jpg", content)
    response = get_export(image.id, db, _User(), format="jpeg", quality=92, max_size=4000)
    assert isinstance(response, FileResponse)
    assert Path(response.path).read_bytes() == content


def test_default_is_unchanged(db, library):
    content = _jpeg()
    image = _add(db, library, "default.jpg", content)
    response = get_export(image.id, db, _User())
    assert isinstance(response, FileResponse)
    assert Path(response.path).read_bytes() == content

    edited = _add(db, library, "default-edited.jpg", _jpeg())
    _crop(db, edited)
    response = get_export(edited.id, db, _User())
    assert response.media_type == "image/png"
    assert PILImage.open(io.BytesIO(response.body)).format == "PNG"
