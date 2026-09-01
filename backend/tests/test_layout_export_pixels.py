"""The album layout exports (PDF / HTML) carry the photos without loss.

A photo that has no non-destructive edits - which is every flattened edited
copy too - goes out as the very bytes it was saved as. One that carries edits
is rendered from them at full resolution and encoded losslessly (PNG), never as
a second JPEG generation. Both come from /images/{id}/export.

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


def _add(db: Session, library: Path, name: str, content: bytes, file_type: FileType = FileType.jpeg) -> Image:
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
        file_type=file_type,
        file_size=len(content),
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def _jpeg(size=(640, 400)) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", size, "teal").save(buf, "JPEG", quality=70)
    return buf.getvalue()


def test_a_photo_without_edits_goes_out_as_its_own_bytes(db, library):
    content = _jpeg()
    image = _add(db, library, "plain.jpg", content)
    response = get_export(image.id, db, _User())
    assert isinstance(response, FileResponse)
    assert Path(response.path).read_bytes() == content


def test_a_png_without_edits_goes_out_as_its_own_bytes_too(db, library):
    buf = io.BytesIO()
    PILImage.new("RGB", (300, 200), "orange").save(buf, "PNG")
    image = _add(db, library, "plain.png", buf.getvalue(), FileType.png)
    response = get_export(image.id, db, _User())
    assert isinstance(response, FileResponse)
    assert Path(response.path).read_bytes() == buf.getvalue()


def test_an_edited_photo_is_rendered_losslessly_at_full_size(db, library):
    image = _add(db, library, "edited.jpg", _jpeg((640, 400)))
    # A crop is a non-destructive edit; the export must render it, and as PNG.
    image.edit_crop_x, image.edit_crop_y = 0.0, 0.0
    image.edit_crop_width, image.edit_crop_height = 0.5, 1.0
    db.commit()
    response = get_export(image.id, db, _User())
    assert not isinstance(response, FileResponse)
    assert response.media_type == "image/png"
    out = PILImage.open(io.BytesIO(response.body))
    assert out.format == "PNG"
    assert out.size == (320, 400)
