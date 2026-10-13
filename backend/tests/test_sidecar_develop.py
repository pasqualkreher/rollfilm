"""The edit in the XMP sidecar: written under Rollfilm's own namespace when
sidecars are on, read back when the photo enters a library again - onto a
photo with no edit of its own only, and only onto the kind of file it was
made on (a pair's sidecar carries the RAW's edit)."""

import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import pytest
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import FileType, Image, ImportSession, ImportSessionSource, ImportStagedFile, User
from app.services import develop, file_metadata, sidecar, thumbnails

needs_exiftool = pytest.mark.skipif(
    not (os.environ.get("EXIFTOOL_PATH") or shutil.which("exiftool")),
    reason="needs the exiftool binary",
)


@pytest.fixture()
def db(monkeypatch) -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    session = factory()
    session.add(User(id=1, username="local"))
    session.commit()
    monkeypatch.setattr(sidecar, "SessionLocal", factory)
    yield session
    session.close()


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    return root


@pytest.fixture(autouse=True, scope="module")
def _end_the_namespace_helper():
    yield
    sidecar.close_develop_helper()


@pytest.fixture()
def deferred(monkeypatch) -> list[str]:
    seen: list[str] = []
    monkeypatch.setattr(thumbnails, "defer_derivatives", seen.append)
    return seen


def _image(db: Session, library: Path, name: str, *, hash: str | None = None, **fields) -> Image:
    path = library / "2026" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        PILImage.new("RGB", (8, 8), "gray").save(path, "JPEG")
    image = Image(
        owner_id=1, file_path=str(path.relative_to(library)), original_filename=name,
        file_hash=hash or f"sha-{name}", file_size=path.stat().st_size,
        file_type=FileType.raw if name.lower().endswith(".raf") else FileType.jpeg,
        taken_at=datetime(2026, 7, 1), **fields,
    )
    db.add(image)
    db.commit()
    return image


def _edited(**adjustments) -> dict:
    return dict(edit_rotation=90, edit_crop_x=0.1, edit_crop_y=0.2, edit_crop_width=0.5, edit_crop_height=0.6,
                edit_adjustments=develop.dumps(adjustments))


@needs_exiftool
def test_the_edit_goes_into_the_sidecar_and_comes_back(db, library, deferred):
    src = _image(db, library, "DSCF0001.JPG", **_edited(exposure=1.25, film_sim="velvia", process="7"))
    path = sidecar.write_sidecar(db, src)
    assert path is not None and "rollfilm:Develop" in path.read_text()
    # Other programs see a plain XMP tag beside the library's own.
    out = subprocess.run(["exiftool", "-config", str(sidecar._DEVELOP_CONFIG), "-s3", "-XMP-rollfilm:Develop",
                          str(path)], check=True, capture_output=True, text=True).stdout
    assert '"exposure":1.25' in out

    stored = file_metadata.read_sidecar_develop(path)
    assert stored["file"] == "DSCF0001.JPG"
    assert stored["rotation"] == 90 and stored["crop"]["width"] == 0.5

    # The same photo enters another library with no edit of its own.
    db.delete(src)
    db.commit()
    fresh = _image(db, library, "DSCF0001.JPG")
    assert file_metadata.apply_sidecar_develop(db, 1, fresh) is True
    db.commit()
    adj = develop.loads(fresh.edit_adjustments)
    assert adj["exposure"] == 1.25 and adj["film_sim"] == "velvia" and adj["process"] == "7"
    assert (fresh.edit_rotation, fresh.edit_crop_x, fresh.edit_crop_height) == (90, 0.1, 0.6)
    assert "edit" in fresh.tags
    assert deferred == [fresh.id]  # its pictures are rendered again with the edit


@needs_exiftool
def test_a_photo_with_its_own_edit_keeps_it(db, library, deferred):
    src = _image(db, library, "a.jpg", **_edited(exposure=2.0))
    sidecar.write_sidecar(db, src)
    src.edit_adjustments = develop.dumps({"contrast": 30})
    src.edit_rotation, src.edit_crop_x, src.edit_crop_width = 0, None, None
    db.commit()
    assert file_metadata.apply_sidecar_develop(db, 1, src) is False
    assert develop.loads(src.edit_adjustments)["contrast"] == 30 and deferred == []


@needs_exiftool
def test_a_pairs_sidecar_carries_the_raws_edit_and_the_jpeg_leaves_it(db, library, deferred):
    raw = _image(db, library, "DSCF0002.RAF", edit_adjustments=develop.dumps({"exposure": 1.0}))
    jpg = _image(db, library, "DSCF0002.JPG", edit_adjustments=develop.dumps({"exposure": -1.0}))
    jpg.paired_image_id, raw.paired_image_id = raw.id, jpg.id
    db.commit()
    db.refresh(jpg)
    path = sidecar.write_sidecar(db, jpg)  # either half writes the shared file
    assert file_metadata.read_sidecar_develop(path)["file"] == "DSCF0002.RAF"
    assert file_metadata.read_sidecar_develop(path)["adjustments"]["exposure"] == 1.0

    for row in (raw, jpg):
        row.edit_adjustments = None
    db.commit()
    assert file_metadata.apply_sidecar_develop(db, 1, jpg) is False
    assert file_metadata.apply_sidecar_develop(db, 1, raw) is True


@needs_exiftool
def test_a_reset_takes_the_edit_out_of_the_sidecar(db, library, deferred):
    img = _image(db, library, "b.jpg", rating=2, edit_adjustments=develop.dumps({"exposure": 1.0}))
    path = sidecar.write_sidecar(db, img)
    assert file_metadata.read_sidecar_develop(path) is not None
    img.edit_adjustments = None
    db.commit()
    sidecar.write_sidecar(db, img)
    assert file_metadata.read_sidecar_develop(path) is None
    assert "Rating" in path.read_text()  # the rest of the sidecar is still written


def test_an_unedited_photo_writes_the_sidecar_as_before(db, library, monkeypatch):
    img = _image(db, library, "c.jpg", rating=1)
    calls = []

    class _Helper:
        def execute(self, *args):
            calls.append(args)

    monkeypatch.setattr(sidecar, "_develop_tool", lambda: pytest.fail("no namespace needed"))
    sidecar.write_sidecar(db, img, helper=_Helper())
    assert calls and not any("rollfilm" in a for a in calls[0])


def test_an_import_finds_the_sidecar_beside_the_file_it_was_copied_from(db, library, deferred, tmp_path):
    """The library copy arrives without its sidecar; the import's source
    folder still has it."""
    card = tmp_path / "card"
    card.mkdir()
    (card / "DSCF0003.JPG").write_bytes(b"x")
    (card / "DSCF0003.xmp").write_text(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:rollfilm="https://rollfilm.app/ns/1.0/" '
        'rollfilm:Develop="{&quot;adjustments&quot;:{&quot;contrast&quot;:25},&quot;flip_h&quot;:true}"/>'
        "</rdf:RDF></x:xmpmeta>"
    )
    session = ImportSession(id="s", owner_id=1, source_path=str(card))
    db.add(session)
    db.flush()
    source = ImportSessionSource(id="src", import_session_id="s", label="card", root=str(card))
    db.add(source)
    db.flush()
    db.add(ImportStagedFile(import_session_id="s", staged_path="s/DSCF0003.JPG", original_filename="DSCF0003.JPG",
                            file_type=FileType.jpeg, source_id="src", source_relpath="DSCF0003.JPG",
                            sha256="sha-3"))
    db.commit()
    image = _image(db, library, "DSCF0003.JPG", hash="sha-3")
    file_metadata.apply_file_metadata(db, 1, image, {})
    assert develop.loads(image.edit_adjustments)["contrast"] == 25 and image.edit_flip_h
