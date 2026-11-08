"""Editing a photo's metadata by hand (services/metadata_edit.py).

The edit lands in the library's columns and is remembered as hand-made; a
RAW+JPEG partner gets it too; a bad value changes nothing. The edited fields
- and only those - are written into the sidecar and into exports, over what
the file says, and a sidecar written that way is read back on import. The
original file is never touched.
"""

import os
import shutil
from datetime import datetime, timedelta, timezone

import pytest
from PIL import Image as PILImage

from app.db.models import FileType, Image
from app.services import exif as exif_service
from app.services import metadata_edit

needs_exiftool = pytest.mark.skipif(
    not (os.environ.get("EXIFTOOL_PATH") or shutil.which("exiftool")),
    reason="exiftool not installed",
)


def _image(id_: str, **kw) -> Image:
    base = dict(
        id=id_,
        owner_id=1,
        file_path=f"2026/{id_}.JPG",
        original_filename=f"{id_}.JPG",
        file_hash=f"h-{id_}",
        file_type=FileType.jpeg,
        file_size=1,
        taken_at=datetime(2026, 7, 1, 12, 0, 0),
        camera_make="FUJIFILM",
        camera_model="X-T5",
        iso=200,
        meta_edited=None,
    )
    base.update(kw)
    return Image(**base)


@pytest.fixture(autouse=True)
def _offline_country(monkeypatch):
    monkeypatch.setattr(metadata_edit.geocode, "country_for", lambda lat, lon: "Chile")


def test_edit_sets_fields_marks_them_and_reaches_the_partner():
    jpg, raw = _image("a"), _image("b", file_type=FileType.raw)
    changed = metadata_edit.apply_edit(
        [jpg],
        {
            "taken_at": "2024-05-01T14:30",
            "gps": {"lat": -33.45, "lon": -70.66},
            "creator": "  Ana  ",
            "copyright": "© Ana",
            "camera_make": "Leica",
            "iso": "ISO 400",
            "aperture": "f/2,8",
            "shutter_speed": "1/250",
            "focal_length": "35 mm",
            "description": "the market",
        },
        None,
        lambda image: raw if image is jpg else None,
    )
    assert {i.id for i in changed} == {"a", "b"}
    for image in (jpg, raw):
        assert image.taken_at == datetime(2024, 5, 1, 14, 30)
        assert (image.gps_lat, image.gps_lon, image.gps_country) == (-33.45, -70.66, "Chile")
        assert image.creator == "Ana"
        assert image.camera_make == "Leica"
        assert image.iso == 400
        assert image.aperture == 2.8
        assert image.shutter_speed == "0.004"
        assert image.focal_length == 35.0
        assert image.description == "the market"
    # The note is not a file value: not marked, not restored.
    assert "description" not in metadata_edit.edited_fields(jpg)
    assert metadata_edit.edited_fields(jpg) == {
        "taken_at", "gps", "creator", "copyright", "camera_make", "iso", "aperture", "shutter_speed", "focal_length",
    }


def test_empty_clears_and_untouched_fields_stay():
    image = _image("a", gps_lat=1.0, gps_lon=2.0, gps_country="X", lens_model="35mm")
    metadata_edit.apply_edit([image], {"gps": None, "camera_model": ""}, None, lambda i: None)
    assert image.gps_lat is None and image.gps_country is None
    assert image.camera_model is None
    assert image.lens_model == "35mm"
    assert image.camera_make == "FUJIFILM"


def test_shift_moves_each_photo_once_and_keeps_its_zone():
    zoned = _image("a", taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=timezone(timedelta(hours=2))))
    plain = _image("b")
    # The partner is also in the selection: it must not move twice.
    metadata_edit.apply_edit([zoned, plain], {}, -3600, lambda i: plain if i is zoned else zoned)
    assert zoned.taken_at == datetime(2026, 7, 1, 11, 0, tzinfo=timezone(timedelta(hours=2)))
    assert plain.taken_at == datetime(2026, 7, 1, 11, 0)
    assert "taken_at" in metadata_edit.edited_fields(plain)


def test_typed_time_keeps_the_stored_zone():
    zone = timezone(timedelta(hours=-5))
    image = _image("a", taken_at=datetime(2026, 7, 1, 12, 0, tzinfo=zone))
    metadata_edit.apply_edit([image], {"taken_at": "2026-07-02T08:15:30"}, None, lambda i: None)
    assert image.taken_at == datetime(2026, 7, 2, 8, 15, 30, tzinfo=zone)


@pytest.mark.parametrize(
    "fields",
    [
        {"iso": "abc"},
        {"aperture": "0"},
        {"shutter_speed": "fast"},
        {"gps": {"lat": 95, "lon": 0}},
        {"taken_at": "yesterday"},
        {"nonsense": "x"},
    ],
)
def test_a_bad_value_changes_nothing(fields):
    image = _image("a")
    with pytest.raises(metadata_edit.MetadataError):
        metadata_edit.apply_edit([image], {"creator": "Ana", **fields}, None, lambda i: None)
    assert image.creator is None
    assert image.meta_edited is None


def test_summary_reports_shared_and_mixed():
    a, b = _image("a", creator="Ana"), _image("b", creator="Ben")
    out = metadata_edit.summary([a, b])
    assert out["count"] == 2
    assert out["values"]["camera_make"] == "FUJIFILM"
    assert out["values"]["creator"] is None
    assert "creator" in out["mixed"]
    assert out["values"]["taken_at"] == "2026-07-01T12:00:00"
    assert out["edited"] is False


def test_only_edited_fields_reach_the_tags():
    image = _image("a", gps_lat=-33.5, gps_lon=-70.25, gps_country="Chile", meta_edited="gps,creator")
    image.creator = "Ana"
    values = metadata_edit.edited_values(image)
    assert set(values) == {"gps", "creator"}
    side = exif_service.edited_tag_args(values, sidecar=True)
    assert "-XMP-dc:Creator=Ana" in side
    assert "-XMP-exif:GPSLatitude=-33.5" in side
    assert not any(a.startswith(("-EXIF:", "-IPTC:", "-GPS:")) for a in side)
    export = exif_service.edited_tag_args(values, sidecar=False)
    assert "-EXIF:Artist=Ana" in export
    assert "-GPS:GPSLatitudeRef=S" in export and "-GPS:GPSLongitude=70.25" in export
    # An export without the place leaves an edited place out too.
    stripped = exif_service.edited_tag_args(values, sidecar=False, strip_location=True)
    assert not any("GPS" in a for a in stripped)


@needs_exiftool
def test_export_carries_the_edit_and_the_sidecar_reads_back(tmp_path):
    src = tmp_path / "IMG_1.jpg"
    PILImage.new("RGB", (8, 8)).save(src)
    helper = exif_service.new_helper()
    try:
        helper.execute(
            "-overwrite_original", "-EXIF:Artist=Old", "-EXIF:DateTimeOriginal=2020:01:01 10:00:00",
            "-GPS:GPSLatitude=10", "-GPS:GPSLatitudeRef=N", "-GPS:GPSLongitude=20",
            "-GPS:GPSLongitudeRef=E", "-GPS:GPSAltitude=100", str(src),
        )
        before = src.read_bytes()
        image = _image("a", taken_at=datetime(2020, 1, 1, 10, 0))
        metadata_edit.apply_edit(
            [image],
            {"taken_at": "2021-02-03T04:05:06", "gps": {"lat": -33.5, "lon": -70.25}, "creator": "Ana"},
            None,
            lambda i: None,
        )
        edited = metadata_edit.edited_values(image)

        dst = tmp_path / "export.jpg"
        PILImage.new("RGB", (8, 8)).save(dst)
        exif_service.write_export_metadata(
            dst, src, library=exif_service.LibraryMetadata(edited=edited, description="note"), helper=helper
        )
        tags = helper.get_metadata(str(dst))[0]
        assert tags["EXIF:Artist"] == "Ana"
        assert tags["EXIF:DateTimeOriginal"] == "2021:02:03 04:05:06"
        assert tags["Composite:GPSLatitude"] == -33.5
        assert tags["Composite:GPSLongitude"] == -70.25
        assert "EXIF:GPSAltitude" not in tags
        assert tags["XMP:Description"] == "note"
        # The original is untouched.
        assert src.read_bytes() == before

        # The sidecar beside the original, as sidecar.write_sidecar fills it.
        side = tmp_path / "IMG_1.xmp"
        side.write_text(
            '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n',
            encoding="utf-8",
        )
        helper.execute("-overwrite_original", *exif_service.edited_tag_args(edited, sidecar=True), str(side))
        read = exif_service.read_exif(src, helper=helper)
        assert read.taken_at == datetime(2021, 2, 3, 4, 5, 6)
        assert (read.gps_lat, read.gps_lon) == (-33.5, -70.25)
        assert read.creator == "Ana"

        # Restore from file: the sidecar loses the values, the file speaks.
        helper.execute(
            "-overwrite_original",
            *exif_service.edited_tag_args({k: None for k in edited}, sidecar=True),
            str(side),
        )
        read = exif_service.read_exif(src, helper=helper)
        assert read.taken_at == datetime(2020, 1, 1, 10, 0)
        assert (read.gps_lat, read.gps_lon) == (10, 20)
        assert read.creator == "Old"
    finally:
        helper.terminate()


# ---- The routes, on a real database and a real file ------------------------

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app import schemas  # noqa: E402
from app.api.routes import images as images_route  # noqa: E402
from app.config import settings  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.models import User  # noqa: E402


@pytest.fixture()
def lib(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(User(id=1, username="local"))
    db.commit()
    monkeypatch.setattr(settings, "library_root", tmp_path)
    touched: list[list[str]] = []
    monkeypatch.setattr(images_route.sidecar_service, "touch", lambda db, images: touched.append([i.id for i in images]))
    yield db, tmp_path, touched
    db.close()


class _User:
    id = 1


@needs_exiftool
def test_routes_edit_summary_and_restore(lib):
    db, root, touched = lib
    (root / "2026").mkdir()
    PILImage.new("RGB", (8, 8)).save(root / "2026" / "a.JPG")
    helper = exif_service.new_helper()
    try:
        helper.execute("-overwrite_original", "-EXIF:Artist=Old", "-EXIF:DateTimeOriginal=2026:07:01 12:00:00",
                       str(root / "2026" / "a.JPG"))
    finally:
        helper.terminate()
    a = _image("a", file_path="2026/a.JPG")
    b = _image("b", file_path="2026/b.JPG", file_type=FileType.raw)
    db.add_all([a, b])
    db.flush()
    a.paired_image_id, b.paired_image_id = "b", "a"
    db.commit()

    # One photo from before the columns: the file's author is read in.
    out = images_route.metadata_summary(schemas.MetadataIds(image_ids=["a"]), db, _User())
    assert out["values"]["creator"] == "Old"
    assert out["edited"] is False

    images_route.edit_metadata(
        schemas.MetadataEdit(image_ids=["a"], fields={"creator": "Ana", "gps": {"lat": 48.1, "lon": 11.6}}),
        db, _User(),
    )
    db.expire_all()
    for row in (db.get(Image, "a"), db.get(Image, "b")):
        assert row.creator == "Ana" and row.gps_lat == 48.1
    assert sorted(touched[-1]) == ["a", "b"]

    with pytest.raises(images_route.HTTPException):
        images_route.edit_metadata(schemas.MetadataEdit(image_ids=["a"], fields={"iso": "x"}), db, _User())

    out = images_route.revert_metadata(schemas.MetadataIds(image_ids=["a"]), db, _User())
    # b's file isn't there (an unplugged drive): it keeps the edit.
    assert out["unreadable"] == 1
    db.expire_all()
    a = db.get(Image, "a")
    assert a.creator == "Old" and a.gps_lat is None and a.meta_edited is None
    assert db.get(Image, "b").creator == "Ana"


def test_place_search_names_the_region():
    hits = images_route.search_places(q="springfield", current_user=_User())
    assert len(hits) > 1
    assert all(h.lat and h.lon for h in hits)
    assert any(h.region and h.region in h.label for h in hits)
    assert images_route.search_places(q="x", current_user=_User()) == []


def test_suggestions_come_from_the_library_most_used_first(lib):
    db, _, _ = lib
    rows = [
        _image("a", creator="Ana", gps_lat=48.137, gps_lon=11.575, taken_at=datetime(2026, 7, 1, 10, 0)),
        _image("b", creator="Ana", gps_lat=48.138, gps_lon=11.576, taken_at=datetime(2026, 7, 1, 11, 0)),
        _image("c", creator="Ben", gps_lat=41.9, gps_lon=12.5, taken_at=datetime(2026, 8, 1, 10, 0)),
        _image("d", creator="Old", deleted_at=datetime(2026, 1, 1)),
        _image("e", taken_at=datetime(2026, 7, 1, 12, 0)),
    ]
    db.add_all(rows)
    db.commit()
    out = images_route.metadata_suggestions(
        start="2026-07-01T12:00:00", end="2026-07-01T12:00:00", exclude="e", db=db, current_user=_User()
    )
    assert out["values"]["creator"] == ["Ana", "Ben"]
    assert out["values"]["camera_make"] == ["FUJIFILM"]
    assert out["places"][0]["count"] == 2 and "Munich" in out["places"][0]["label"]
    # Near in time: only the Munich shots of that morning, not Rome a month later.
    assert [p["count"] for p in out["near"]] == [2]
    assert "Munich" in out["near"][0]["label"]


def test_summary_reports_the_time_range():
    a = _image("a", taken_at=datetime(2026, 7, 1, 9, 0))
    b = _image("b", taken_at=datetime(2026, 7, 2, 18, 30))
    assert metadata_edit.summary([a, b])["taken_range"] == ["2026-07-01T09:00:00", "2026-07-02T18:30:00"]
