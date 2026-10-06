"""What another program said about a photo comes in with it, and goes out
again.

A library that moves here from Lightroom, Bridge, darktable or digiKam
arrives with its stars, colour labels, keywords (tree and all) and captions:
read from the XMP/IPTC blocks in the file or from an .xmp sidecar beside it,
the sidecar winning. A tag is its full path ("Travel/Italy/Rome"); filtering
by "Travel" finds Rome, renaming "Travel" renames Rome, and the keyword list
round-trips through the text format those programs share. Switched on, the
library keeps an .xmp sidecar beside each managed original with the same
fields, so the way back out is just as open.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import schemas
from app.api.routes import images as images_route
from app.api.routes import tags as tags_route
from app.config import settings
from app.db.base import Base
from app.db.models import ColorLabel, FileType, Image, ImageTag, ImportStagedFile, Tag, User
from app.services import exif as exif_service
from app.services import file_metadata, sidecar
from app.services import tags as tags_service
from app.services.settings_store import IMPORT_READ_FILE_METADATA, SIDECAR_WRITE, set_setting

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
    # The sidecar pass opens its own session, as it does on its timer thread.
    monkeypatch.setattr(sidecar, "SessionLocal", factory)
    yield session
    session.close()


@pytest.fixture()
def library(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(settings, "library_root", root)
    return root


def _jpeg(path: Path, *tags: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", (8, 8), "gray").save(path, "JPEG")
    if tags:
        subprocess.run(["exiftool", "-overwrite_original", *tags, str(path)], check=True, capture_output=True)
    return path


def _xmp(path: Path, *tags: str) -> Path:
    subprocess.run(["exiftool", "-o", str(path), *tags], check=True, capture_output=True)
    return path


def _read(path: Path) -> dict:
    import json

    out = subprocess.run(["exiftool", "-G", "-j", "-struct", str(path)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout)[0]


def _image(db: Session, library: Path, name: str, **fields) -> Image:
    path = library / "2026" / name
    _jpeg(path)
    image = Image(
        owner_id=1,
        file_path=str(path.relative_to(library)),
        original_filename=name,
        file_hash=f"sha-{name}",
        file_type=FileType.raw if name.lower().endswith(".raf") else FileType.jpeg,
        file_size=path.stat().st_size,
        **fields,
    )
    db.add(image)
    db.commit()
    return image


# --- reading ------------------------------------------------------------------


@needs_exiftool
def test_the_files_own_stars_label_keywords_and_caption_are_read(tmp_path):
    path = _jpeg(
        tmp_path / "IMG_0001.jpg",
        "-XMP:Rating=4",
        "-XMP:Label=Blue",
        "-XMP-dc:Subject=Rome",
        "-XMP-dc:Subject=beach",
        "-XMP-lr:HierarchicalSubject=Travel|Italy|Rome",
        "-XMP-dc:Title=The title",
        "-XMP-dc:Description=The caption",
        "-IPTC:Keywords=beach",
    )
    data = exif_service.read_exif(path)
    assert (data.rating, data.label) == (4, "blue")
    # Rome is the leaf of the path, not a second tag; beach is flat and once.
    assert data.keywords == ("Travel/Italy/Rome", "beach")
    assert (data.title, data.caption) == ("The title", "The caption")


@needs_exiftool
def test_a_sidecar_beside_the_file_wins(tmp_path):
    path = _jpeg(tmp_path / "IMG_0001.jpg", "-XMP:Rating=4", "-XMP-dc:Subject=old")
    _xmp(
        tmp_path / "IMG_0001.xmp",
        "-XMP:Rating=2",
        "-XMP-digiKam:ColorLabel=4",
        "-XMP-digiKam:TagsList=People/Family",
        "-XMP-dc:Subject=Family",
    )
    data = exif_service.read_exif(path)
    assert (data.rating, data.label) == (2, "green")
    # The sidecar's keyword list replaces the file's, it doesn't add to it:
    # the program that wrote the sidecar removed "old" on purpose.
    assert data.keywords == ("People/Family",)


@needs_exiftool
def test_the_other_sidecar_name_is_found_too(tmp_path):
    path = _jpeg(tmp_path / "IMG_0001.jpg")
    _xmp(tmp_path / "IMG_0001.jpg.xmp", "-XMP:Rating=5")
    assert exif_service.read_exif(path).rating == 5


@needs_exiftool
@pytest.mark.parametrize(
    "tags, label",
    [
        (("-XMP:Label=Purple",), "magenta"),
        (("-XMP:Label=Gelb",), "yellow"),
        (("-XMP:Label=Important",), None),  # a word that is no colour
        (("-XMP-digiKam:ColorLabel=0", "-XMP:Label=Red"), None),  # digiKam says none, explicitly
        (("-XMP:Rating=-1",), None),  # rejected reads as unrated
    ],
)
def test_labels_and_ratings_of_the_big_writers(tmp_path, tags, label):
    data = exif_service.read_exif(_jpeg(tmp_path / "a.jpg", *tags))
    assert data.label == label
    if "-XMP:Rating=-1" in tags:
        assert data.rating == 0


# --- taking it over -----------------------------------------------------------


def test_file_stars_prefill_a_staged_row_but_never_replace_the_users(db):
    staged = ImportStagedFile(
        import_session_id="s", staged_path="s/a.jpg", original_filename="a.jpg", file_type=FileType.jpeg
    )
    file_metadata.prefill_from_file(staged, '{"rating": 3, "label": "blue"}')
    assert (staged.rating, staged.color_label) == (3, ColorLabel.blue)
    staged.rating, staged.color_label = 5, ColorLabel.red
    file_metadata.prefill_from_file(staged, '{"rating": 3, "label": "blue"}')
    assert (staged.rating, staged.color_label) == (5, ColorLabel.red)
    # A colour the library doesn't have, or no JSON at all, changes nothing.
    staged.color_label = ColorLabel.none
    file_metadata.prefill_from_file(staged, '{"label": "chartreuse"}')
    file_metadata.prefill_from_file(staged, None)
    assert staged.color_label == ColorLabel.none


def test_keywords_become_tags_paths_and_all_and_the_caption_the_note(db, library):
    image = _image(db, library, "a.jpg")
    file_metadata.apply_file_metadata(
        db, 1, image, {"keywords": ["Travel/Italy/Rome", "beach", "edit"], "caption": "On the beach"}
    )
    db.commit()
    assert image.tags == ["Travel/Italy/Rome", "beach"]  # "edit" is the app's own
    assert image.description == "On the beach"
    # A note the user wrote stays; tags only add.
    image.description = "mine"
    file_metadata.apply_file_metadata(db, 1, image, {"keywords": ["beach", "sea"], "title": "T"})
    db.commit()
    db.refresh(image)
    assert image.description == "mine"
    assert image.tags == ["Travel/Italy/Rome", "beach", "sea"]


def test_a_pair_shares_what_either_file_said_raw_first(db, library):
    raw = _image(db, library, "DSCF0001.RAF", rating=0, color_label=ColorLabel.none)
    jpeg = _image(db, library, "DSCF0001.JPG", rating=2, color_label=ColorLabel.blue, description="jpg note")
    raw.paired_image_id, jpeg.paired_image_id = jpeg.id, raw.id
    tags_service.add_tag_to_image(db, 1, raw, "Travel")
    tags_service.add_tag_to_image(db, 1, jpeg, "beach")
    raw.rating = 4
    db.flush()
    file_metadata.share_pair_metadata(db, 1, [raw, jpeg])
    db.commit()
    for half in (raw, jpeg):
        db.refresh(half)
        assert (half.rating, half.color_label, half.description) == (4, ColorLabel.blue, "jpg note")
        assert half.tags == ["Travel", "beach"]


# --- the tree in the name -------------------------------------------------------


def test_filtering_by_a_parent_finds_everything_under_it(db, library):
    rome = _image(db, library, "rome.jpg")
    paris = _image(db, library, "paris.jpg")
    other = _image(db, library, "other.jpg")
    tags_service.add_tag_to_image(db, 1, rome, "Travel/Italy/Rome")
    tags_service.add_tag_to_image(db, 1, paris, "Travel/France")
    tags_service.add_tag_to_image(db, 1, other, "Traveller")  # a prefix, not a parent
    db.commit()

    def ids(*tags):
        return {
            img.id
            for img in images_route._filtered_images_query(
                db, _User(), "combined", None, None, None, None, None, None, None, None, None, None, None, list(tags)
            )
        }

    assert ids("Travel") == {rome.id, paris.id}
    assert ids("Travel/Italy") == {rome.id}
    assert ids("Travel", "Travel/France") == {paris.id}
    assert ids("Traveller") == {other.id}


def test_renaming_a_parent_renames_the_whole_branch(db, library):
    rome = _image(db, library, "rome.jpg")
    tags_service.add_tag_to_image(db, 1, rome, "Travel/Italy/Rome")
    tags_service.add_tag_to_image(db, 1, rome, "Travel/Italy")
    tags_service.add_tag_to_image(db, 1, rome, "Travelling")
    db.commit()
    renamed = tags_service.rename_tag(db, 1, "Travel/Italy", "Trips/Italia")
    db.commit()
    assert sorted(renamed) == [("Travel/Italy", "Trips/Italia"), ("Travel/Italy/Rome", "Trips/Italia/Rome")]
    db.refresh(rome)
    assert rome.tags == ["Travelling", "Trips/Italia", "Trips/Italia/Rome"]
    with pytest.raises(ValueError):
        tags_service.rename_tag(db, 1, "Trips", "Trips/Italia/Deeper")
    with pytest.raises(LookupError):
        tags_service.rename_tag(db, 1, "Nope", "Yes")


def test_a_rename_refuses_to_land_on_another_tag(db, library):
    img = _image(db, library, "a.jpg")
    tags_service.add_tag_to_image(db, 1, img, "A")
    tags_service.add_tag_to_image(db, 1, img, "B")
    db.commit()
    with pytest.raises(tags_service.TagConflict):
        tags_service.rename_tag(db, 1, "A", "B")


def test_deleting_with_children_takes_the_branch_without_leaves_them(db, library):
    img = _image(db, library, "a.jpg")
    for name in ("Travel", "Travel/Italy", "Travel/Italy/Rome", "Travelling"):
        tags_service.add_tag_to_image(db, 1, img, name)
    db.commit()
    assert tags_service.delete_tag(db, 1, "Travel", with_children=False) == ["Travel"]
    db.commit()
    db.refresh(img)
    assert img.tags == ["Travel/Italy", "Travel/Italy/Rome", "Travelling"]
    assert sorted(tags_service.delete_tag(db, 1, "Travel", with_children=True)) == [
        "Travel/Italy",
        "Travel/Italy/Rome",
    ]
    db.commit()
    db.refresh(img)
    assert img.tags == ["Travelling"]


def test_tag_names_are_normalised_paths(db, library):
    img = _image(db, library, "a.jpg")
    tags_service.add_tag_to_image(db, 1, img, " Travel / Italy ")
    tags_service.add_tag_to_image(db, 1, img, "Travel/Italy")
    db.commit()
    assert img.tags == ["Travel/Italy"]
    assert tags_service.normalize("album: a/b") == "album: a/b"  # the app's own stay flat


# --- keyword lists ------------------------------------------------------------


def test_the_keyword_list_round_trips():
    text = "Travel\n\tItaly\n\t\tRome\n\t\t{Roma}\n\tFrance\nbeach\nPeople/Family\n"
    paths = tags_service.parse_keyword_list(text)
    assert paths == ["Travel", "Travel/Italy", "Travel/Italy/Rome", "Travel/France", "beach", "People", "People/Family"]
    exported = tags_service.export_keyword_list(paths)
    assert exported == "beach\nPeople\n\tFamily\nTravel\n\tFrance\n\tItaly\n\t\tRome\n"
    assert tags_service.parse_keyword_list(exported) == [
        "beach", "People", "People/Family", "Travel", "Travel/France", "Travel/Italy", "Travel/Italy/Rome",
    ]


def test_an_imported_list_is_kept_without_photos_and_offered(db, library):
    created, existing = tags_service.import_keyword_list(db, 1, "Travel\n\tItaly\nedit\n")
    db.commit()
    assert (created, existing) == (2, 0)
    # Pruning leaves kept tags alone; they are offered in the list.
    from app.services.tag_cleanup import prune_unused_tags

    assert prune_unused_tags(db, 1) == []
    assert tags_route.list_tags(db, _User()) == ["Travel", "Travel/Italy"]
    usage = tags_route.tag_usage(db, _User())
    assert [(u.name, u.count, u.kept) for u in usage] == [("Travel", 0, True), ("Travel/Italy", 0, True)]
    # Importing again finds them (a path names its parents too).
    assert tags_service.import_keyword_list(db, 1, "Travel/Italy\n") == (0, 2)
    # A tag that photos carry and the list names is kept from then on.
    img = _image(db, library, "a.jpg")
    tags_service.add_tag_to_image(db, 1, img, "beach")
    db.commit()
    tags_service.import_keyword_list(db, 1, "beach\n")
    db.commit()
    assert db.query(Tag).filter(Tag.name == "beach").one().kept is True


# --- the way out: sidecars --------------------------------------------------------


@needs_exiftool
def test_a_sidecar_is_written_beside_the_original_and_kept_up_to_date(db, library):
    img = _image(db, library, "DSCF0001.JPG", rating=3, color_label=ColorLabel.magenta, description="A note")
    tags_service.add_tag_to_image(db, 1, img, "Travel/Italy/Rome")
    tags_service.add_tag_to_image(db, 1, img, "beach")
    tags_service.add_tag_to_image(db, 1, img, "edit")  # the app's own: never written
    db.commit()

    # Off: nothing is written, however often a photo changes.
    sidecar.touch(db, [img])
    assert sidecar.flush_now() == 0
    assert not (library / "2026" / "DSCF0001.xmp").exists()

    set_setting(db, SIDECAR_WRITE, "1")
    db.commit()
    sidecar.touch(db, [img])
    assert sidecar.flush_now() == 1
    data = _read(library / "2026" / "DSCF0001.xmp")
    assert data["XMP:Rating"] == 3
    assert (data["XMP:Label"], data["XMP:ColorLabel"]) == ("Purple", 6)
    assert sorted(data["XMP:Subject"]) == ["Rome", "beach"]
    assert sorted(data["XMP:HierarchicalSubject"]) == ["Travel|Italy|Rome", "beach"]
    assert sorted(data["XMP:TagsList"]) == ["Travel/Italy/Rome", "beach"]
    assert data["XMP:Description"] == "A note"

    # A change rewrites it whole: the dropped tag and the cleared note go.
    img.rating, img.color_label, img.description = 0, ColorLabel.none, None
    db.query(ImageTag).filter(ImageTag.image_id == img.id).delete()
    tags_service.add_tag_to_image(db, 1, img, "only")
    db.commit()
    sidecar.touch(db, [img])
    sidecar.flush_now()
    data = _read(library / "2026" / "DSCF0001.xmp")
    assert "XMP:Rating" not in data and "XMP:Label" not in data and "XMP:Description" not in data
    assert data["XMP:Subject"] == ["only"]


@needs_exiftool
def test_what_a_sidecar_says_reads_back_the_same(db, library):
    img = _image(db, library, "a.jpg", rating=2, color_label=ColorLabel.green)
    tags_service.add_tag_to_image(db, 1, img, "People/Family")
    set_setting(db, SIDECAR_WRITE, "1")
    db.commit()
    sidecar.write_sidecar(db, img)
    data = exif_service.read_exif(library / "2026" / "a.jpg")
    assert (data.rating, data.label, data.keywords) == (2, "green", ("People/Family",))


@needs_exiftool
def test_external_photos_and_virtual_copies_get_no_sidecar(db, library, tmp_path):
    external = tmp_path / "nas" / "x.jpg"
    _jpeg(external)
    img = Image(
        id="ext", owner_id=1, file_path=str(external), source_root_id="root", original_filename="x.jpg",
        file_hash="h", file_type=FileType.jpeg, file_size=1, rating=4,
    )
    assert sidecar.sidecar_for(img) is None
    assert sidecar.write_sidecar(db, img) is None
    assert not (tmp_path / "nas" / "x.xmp").exists()
    base = _image(db, library, "b.jpg")
    copy = _image(db, library, "b.jpg#copy", virtual_of_image_id=base.id)
    assert sidecar.sidecar_for(copy) is None


@needs_exiftool
def test_a_renamed_original_takes_its_sidecar_along_and_a_deleted_one_removes_it(db, library):
    img = _image(db, library, "old.jpg", rating=1)
    set_setting(db, SIDECAR_WRITE, "1")
    db.commit()
    sidecar.write_sidecar(db, img)
    assert (library / "2026" / "old.xmp").exists()
    source, target = library / "2026" / "old.jpg", library / "2026" / "new.jpg"
    source.rename(target)
    assert sidecar.move_sidecar(source, target) == (library / "2026" / "new.xmp", library / "2026" / "old.xmp")
    assert (library / "2026" / "new.xmp").exists() and not (library / "2026" / "old.xmp").exists()
    img.file_path = "2026/new.jpg"
    db.commit()
    sidecar.remove_sidecar(db, img, going_too={img.id})
    assert not (library / "2026" / "new.xmp").exists()


@needs_exiftool
def test_a_pair_shares_one_sidecar_that_stays_while_one_half_stays(db, library):
    raw = _image(db, library, "DSCF0002.RAF", rating=5)
    jpeg = _image(db, library, "DSCF0002.JPG", rating=5)
    raw.paired_image_id, jpeg.paired_image_id = jpeg.id, raw.id
    set_setting(db, SIDECAR_WRITE, "1")
    db.commit()
    assert sidecar.sidecar_for(raw) == sidecar.sidecar_for(jpeg)
    sidecar.touch(db, [raw, jpeg])
    assert sidecar.flush_now() == 1  # one file for the pair
    # The JPEG goes, the RAW stays: the sidecar is still the RAW's.
    sidecar.remove_sidecar(db, jpeg, going_too={jpeg.id})
    assert (library / "2026" / "DSCF0002.xmp").exists()
    sidecar.remove_sidecar(db, raw, going_too={raw.id, jpeg.id})
    assert not (library / "2026" / "DSCF0002.xmp").exists()


def test_the_import_switch_is_on_until_turned_off(db):
    from app.api.routes.settings import get_import_settings, update_import_settings

    assert get_import_settings(db, _User()).read_file_metadata is True
    out = update_import_settings(schemas.ImportSettingsUpdate(read_file_metadata=False), db, _User())
    assert out.read_file_metadata is False
    assert get_import_settings(db, _User()).read_file_metadata is False
    set_setting(db, IMPORT_READ_FILE_METADATA, "1")
    db.commit()
    assert get_import_settings(db, _User()).read_file_metadata is True


# --- through the import -----------------------------------------------------------


@pytest.fixture()
def import_dirs(tmp_path, monkeypatch):
    from app.services import import_pipeline

    monkeypatch.setattr(settings, "import_staging_root", tmp_path / "staging")
    monkeypatch.setattr(settings, "library_root", tmp_path / "library")
    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path / "thumbs")
    (tmp_path / "library").mkdir()
    monkeypatch.setattr(import_pipeline, "enqueue_post_import", lambda *a, **k: None)
    monkeypatch.setattr(import_pipeline, "get_immich_config", lambda db: None)
    monkeypatch.setattr(import_pipeline.geocode, "annotate_images", lambda images: None)
    return tmp_path


def _staged_with(db: Session, name: str, exif: dict, session=None, **fields) -> ImportStagedFile:
    import json

    from app.db.models import ImportSession

    if session is None:
        session = ImportSession(owner_id=1, source_path="DCIM")
        db.add(session)
        db.commit()
    staged_dir = settings.import_staging_root / session.id
    staged_dir.mkdir(parents=True, exist_ok=True)
    (staged_dir / name).write_bytes(name.encode())
    row = ImportStagedFile(
        import_session_id=session.id,
        staged_path=f"{session.id}/{name}",
        original_filename=name,
        file_type=FileType.raw if name.lower().endswith(".raf") else FileType.jpeg,
        sha256=f"sha-{name}",
        processed=True,
        selected=True,
        exif_json=json.dumps({"taken_at": "2026-07-01T12:00:00+00:00", **exif}),
        **fields,
    )
    db.add(row)
    db.commit()
    return row


def test_an_import_brings_keywords_and_caption_along_and_a_pair_shares_them(db, import_dirs):
    from app.services import import_pipeline

    raw = _staged_with(
        db,
        "DSCF0001.RAF",
        {"keywords": ["Travel/Italy/Rome"], "caption": "Rome at dusk"},
        rating=4,
        color_label=ColorLabel.blue,
    )
    _staged_with(db, "DSCF0001.JPG", {"keywords": ["beach"]}, session=raw.import_session)
    images = import_pipeline.commit_import_session(db, raw.import_session, 1)
    assert len(images) == 2
    for image in images:
        db.refresh(image)
        assert image.tags == ["Travel/Italy/Rome", "beach"]
        assert (image.rating, image.color_label, image.description) == (4, ColorLabel.blue, "Rome at dusk")


def test_the_switch_off_leaves_the_files_word_out(db, import_dirs):
    from app.services import import_pipeline

    set_setting(db, IMPORT_READ_FILE_METADATA, "0")
    db.commit()
    staged = _staged_with(db, "a.jpg", {"keywords": ["beach"], "caption": "x"})
    (image,) = import_pipeline.commit_import_session(db, staged.import_session, 1)
    db.refresh(image)
    assert image.tags == [] and image.description is None
