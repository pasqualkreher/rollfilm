"""The export job: where its files go, what they are called and what they say
about themselves.

An export is the one thing that leaves the app, so three promises are pinned
here. A folder export writes one file beside the other and never over a file
that is already there. A name template means the same for every photo of a
run. And a rendered file carries the camera's data and the library's stars
and tags - upright, at its own size - unless the export was asked to leave
the place, or everything, out.
"""

import io
import os
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_route
from app.config import settings
from app.db.base import Base
from app.db.models import ColorLabel, FileType, Image, ImageTag, Tag, User
from app.services import exif as exif_service
from app.services import raw as raw_service
from app.services import thumbnails

needs_exiftool = pytest.mark.skipif(
    not (os.environ.get("EXIFTOOL_PATH") or shutil.which("exiftool")),
    reason="needs the exiftool binary",
)


class _User:
    id = 1


@pytest.fixture()
def db(monkeypatch) -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    session = factory()
    session.add(User(id=1, username="local"))
    session.commit()
    # The job opens its own session, as it does on its worker thread.
    monkeypatch.setattr(images_route, "SessionLocal", factory)
    yield session
    session.close()


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    return root


@pytest.fixture()
def rendered(monkeypatch):
    """Stand-ins for the two renders: a small real JPEG / 16-bit TIFF, so the
    files the job writes are ones exiftool and a viewer can open."""

    def jpeg(image, quality, max_size=None, finish=None):
        buf = io.BytesIO()
        PILImage.new("RGB", (60, 40), (30, 90, 150)).save(
            buf, "JPEG", quality=quality, icc_profile=raw_service.srgb_icc_bytes()
        )
        return buf.getvalue()

    def tiff(image, max_size=None, finish=None):
        ok, buf = cv2.imencode(".tiff", np.full((40, 60, 3), 20000, np.uint16))
        assert ok
        return buf.tobytes()

    monkeypatch.setattr(thumbnails, "export_jpeg_bytes", jpeg)
    monkeypatch.setattr(thumbnails, "export_tiff_bytes", tiff)


def _add(db: Session, library: Path, name: str, *, id: str | None = None, **extra) -> Image:
    """A camera JPEG on disk - turned on its side, with a place - and its row."""
    day = library / "2026" / "2026-07-01"
    day.mkdir(parents=True, exist_ok=True)
    exif = PILImage.Exif()
    exif[271] = "FUJIFILM"
    exif[272] = "X-T5"
    exif[274] = 6  # rotated: the export's pixels are upright, its tag must say so
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2], gps[3], gps[4] = "N", (48.0, 8.0, 0.0), "E", (11.0, 34.0, 0.0)
    PILImage.new("RGB", (400, 300), (120, 80, 40)).save(day / name, "JPEG", exif=exif)
    image = Image(
        id=id or name,
        owner_id=1,
        file_path=str((day / name).relative_to(library)),
        original_filename=name,
        file_hash=id or name,
        file_type=FileType.jpeg,
        file_size=(day / name).stat().st_size,
        taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
        camera_model="X-T5",
        **extra,
    )
    db.add(image)
    db.commit()
    return image


def _tag(db: Session, image: Image, name: str) -> None:
    tag = db.query(Tag).filter(Tag.name == name).first() or Tag(owner_id=1, name=name)
    db.add(tag)
    db.flush()
    db.add(ImageTag(image_id=image.id, tag_id=tag.id))
    db.commit()


def _run(ids: list[str], **options) -> dict:
    """One export job, run to its end on this thread."""
    payload = schemas.ExportStartRequest(image_ids=ids, **options)
    job = {
        "done": 0, "total": len(ids), "state": "running", "path": None, "filename": None,
        "media": None, "error": None, "dest_dir": None, "written": 0, "reveal_path": None,
        "created": 0.0,
    }
    images_route._export_jobs["job"] = job
    try:
        images_route._run_export_job("job", 1, payload)
    finally:
        images_route._export_jobs.pop("job", None)
    return job


def _tags(path: Path) -> dict:
    helper = exif_service.new_helper()
    try:
        return helper.get_metadata([str(path)])[0]
    finally:
        helper.terminate()


# --- where the files go ------------------------------------------------------


def test_a_folder_export_writes_the_files_side_by_side(db, library, rendered, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a")
    _add(db, library, "DSCF0002.JPG", id="b")
    out = tmp_path / "out"
    out.mkdir()

    job = _run(["a", "b"], dest_dir=str(out))

    assert job["state"] == "ready" and job["written"] == 2 and job["path"] is None
    assert sorted(p.name for p in out.iterdir()) == ["DSCF0001.jpg", "DSCF0002.jpg"]
    assert job["dest_dir"] == str(out) and job["reveal_path"] == str(out / "DSCF0001.jpg")


def test_a_folder_export_never_writes_over_a_file(db, library, rendered, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a")
    out = tmp_path / "out"
    out.mkdir()
    (out / "DSCF0001.jpg").write_bytes(b"already here")

    _run(["a"], dest_dir=str(out))
    _run(["a"], dest_dir=str(out))

    assert (out / "DSCF0001.jpg").read_bytes() == b"already here"
    assert sorted(p.name for p in out.iterdir()) == ["DSCF0001.jpg", "DSCF0001_1.jpg", "DSCF0001_2.jpg"]


def test_a_pair_sharing_a_stem_gets_two_names(db, library, rendered, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a")
    _add(db, library, "DSCF0001.RAF", id="b")
    out = tmp_path / "out"
    out.mkdir()

    _run(["a", "b"], dest_dir=str(out))

    assert sorted(p.name for p in out.iterdir()) == ["DSCF0001.jpg", "DSCF0001_1.jpg"]


def test_originals_keep_their_bytes_and_extension(db, library, rendered, tmp_path):
    image = _add(db, library, "DSCF0001.JPG", id="a")
    out = tmp_path / "out"
    out.mkdir()

    _run(["a"], dest_dir=str(out), format="original", name_template="trip_{seq}")

    assert (out / "trip_001.JPG").read_bytes() == (library / image.file_path).read_bytes()


def test_a_photo_that_fails_to_render_is_skipped(db, library, rendered, tmp_path, monkeypatch):
    _add(db, library, "DSCF0001.JPG", id="a")
    _add(db, library, "DSCF0002.JPG", id="b")
    good = thumbnails.export_jpeg_bytes

    def flaky(image, quality, max_size=None, finish=None):
        if image.id == "a":
            raise RuntimeError("broken file")
        return good(image, quality, max_size)

    monkeypatch.setattr(thumbnails, "export_jpeg_bytes", flaky)
    out = tmp_path / "out"
    out.mkdir()

    job = _run(["a", "b"], dest_dir=str(out))

    assert job["state"] == "ready" and job["done"] == 2 and job["written"] == 1
    assert [p.name for p in out.iterdir()] == ["DSCF0002.jpg"]


def test_a_download_of_several_is_still_a_zip(db, library, rendered):
    _add(db, library, "DSCF0001.JPG", id="a")
    _add(db, library, "DSCF0002.JPG", id="b")

    job = _run(["a", "b"], name_template="{date}_{seq}")

    try:
        assert job["state"] == "ready" and job["filename"] == "export.zip"
        with zipfile.ZipFile(job["path"]) as archive:
            assert archive.namelist() == ["2026-07-01_001.jpg", "2026-07-01_002.jpg"]
            assert PILImage.open(io.BytesIO(archive.read("2026-07-01_001.jpg"))).size == (60, 40)
    finally:
        Path(job["path"]).unlink(missing_ok=True)


def test_one_download_is_named_by_the_template(db, library, rendered):
    _add(db, library, "DSCF0001.JPG", id="a")

    job = _run(["a"], name_template="{camera}_{name}", format="tiff")

    try:
        assert job["filename"] == "X-T5_DSCF0001.tif" and job["media"] == "image/tiff"
    finally:
        Path(job["path"]).unlink(missing_ok=True)


def test_start_refuses_a_bad_template_or_folder(db, library, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a")

    def start(**options):
        return images_route.export_start(
            payload=schemas.ExportStartRequest(image_ids=["a"], **options), db=db, current_user=_User()
        )

    with pytest.raises(HTTPException) as bad_template:
        start(name_template="{datum}")
    assert bad_template.value.status_code == 400
    with pytest.raises(HTTPException) as gone:
        start(dest_dir=str(tmp_path / "not there"))
    assert gone.value.status_code == 400


def test_the_name_preview_is_the_first_photos_real_name(db, library):
    _add(db, library, "DSCF0001.JPG", id="a")
    _add(db, library, "DSCF0002.JPG", id="b")

    def preview(**options):
        return images_route.export_name_preview(
            payload=schemas.ExportStartRequest(image_ids=["a", "b"], **options), db=db, current_user=_User()
        )

    assert preview().name == "DSCF0001.jpg"
    assert preview(name_template="{date}_{seq}", format="tiff").name == "2026-07-01_001.tif"
    assert preview(name_template="{name}", format="original").name == "DSCF0001.JPG"
    bad = preview(name_template="{datum}")
    assert bad.name is None and "{datum}" in bad.error


# --- what the files say about themselves --------------------------------------


@needs_exiftool
def test_an_export_carries_camera_data_stars_and_tags(db, library, rendered, tmp_path):
    image = _add(db, library, "DSCF0001.JPG", id="a", rating=4, color_label=ColorLabel.red)
    _tag(db, image, "beach")
    _tag(db, image, "edit")  # the app's own tag: stays in the library
    out = tmp_path / "out"
    out.mkdir()

    _run(["a"], dest_dir=str(out))

    tags = _tags(out / "DSCF0001.jpg")
    assert tags["EXIF:Make"] == "FUJIFILM" and tags["EXIF:Model"] == "X-T5"
    assert tags["Composite:GPSLatitude"] == pytest.approx(48.1333, abs=1e-3)
    # The pixels are upright and 60x40: the tags say that, not the source's.
    assert tags["EXIF:Orientation"] == 1
    assert (tags["EXIF:ExifImageWidth"], tags["EXIF:ExifImageHeight"]) == (60, 40)
    assert tags["XMP:Rating"] == 4 and tags["XMP:Label"] == "Red"
    assert tags["XMP:Subject"] == "beach" and tags["IPTC:Keywords"] == "beach"
    assert "ICC_Profile:ProfileDescription" in tags


@needs_exiftool
def test_no_location_drops_the_place_and_keeps_the_rest(db, library, rendered, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a", rating=3)
    out = tmp_path / "out"
    out.mkdir()

    _run(["a"], dest_dir=str(out), metadata="no_location")

    tags = _tags(out / "DSCF0001.jpg")
    assert tags["EXIF:Make"] == "FUJIFILM" and tags["XMP:Rating"] == 3
    assert not [key for key in tags if "GPS" in key]


@needs_exiftool
def test_none_leaves_only_the_colour_profile(db, library, rendered, tmp_path):
    image = _add(db, library, "DSCF0001.JPG", id="a", rating=5)
    _tag(db, image, "beach")
    out = tmp_path / "out"
    out.mkdir()

    _run(["a"], dest_dir=str(out), metadata="none")

    tags = _tags(out / "DSCF0001.jpg")
    assert not [key for key in tags if key.startswith(("EXIF:", "XMP:", "IPTC:"))]
    assert "ICC_Profile:ProfileDescription" in tags


@needs_exiftool
def test_a_tiff_gets_its_colour_profile_and_stays_16_bit(db, library, rendered, tmp_path):
    _add(db, library, "DSCF0001.JPG", id="a")
    out = tmp_path / "out"
    out.mkdir()

    _run(["a"], dest_dir=str(out), format="tiff", metadata="none")
    _run(["a"], dest_dir=str(out), format="tiff")

    bare, full = out / "DSCF0001.tif", out / "DSCF0001_1.tif"
    assert "ICC_Profile:ProfileDescription" in _tags(bare)
    assert _tags(full)["EXIF:Make"] == "FUJIFILM"
    for path in (bare, full):
        back = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        assert back.dtype == np.uint16 and back.shape == (40, 60, 3)
