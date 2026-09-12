"""GET /images/{id}/file-path: where a photo lives on disk, for the desktop
app's "Show in Finder / Explorer". A virtual copy owns no file of its own, so
it answers with its source's; a photo whose file has gone says so instead of
pretending."""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.images import get_image_file_path
from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services.filesystem import VIRTUAL_PATH_MARKER


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
    return root


def _row(db: Session, id: str, file_path: str, name: str = "DSCF0001.JPG") -> Image:
    image = Image(
        id=id,
        owner_id=1,
        file_path=file_path,
        original_filename=name,
        file_hash=id,
        file_type=FileType.jpeg,
        file_size=1,
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    db.add(image)
    db.commit()
    return image


def test_managed_photo_resolves_under_the_library(db, library):
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True)
    (day / "DSCF0001.JPG").write_bytes(b"jpeg")
    _row(db, "a", "2026/2026-07-01/DSCF0001.JPG")

    out = get_image_file_path("a", db=db, current_user=_User())

    assert out == {"path": str(day / "DSCF0001.JPG"), "exists": True}


def test_virtual_copy_answers_with_its_sources_file(db, library):
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True)
    (day / "DSCF0001.JPG").write_bytes(b"jpeg")
    _row(db, "a", "2026/2026-07-01/DSCF0001.JPG")
    _row(db, "vc", f"2026/2026-07-01/DSCF0001.JPG{VIRTUAL_PATH_MARKER}vc")

    out = get_image_file_path("vc", db=db, current_user=_User())

    assert out["path"] == str(day / "DSCF0001.JPG")
    assert out["exists"] is True


def test_missing_file_is_reported_not_hidden(db, library):
    _row(db, "gone", "2026/2026-07-01/GONE.JPG")

    out = get_image_file_path("gone", db=db, current_user=_User())

    assert out["path"] == str(library / "2026" / "2026-07-01" / "GONE.JPG")
    assert out["exists"] is False
