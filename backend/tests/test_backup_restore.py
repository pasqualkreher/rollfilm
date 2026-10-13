"""Backup/restore round-trip: everything a user can lose (develop edits, tags,
albums, Immich flags, trash state) must survive build_backup_zip → restore."""

import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.base import Base
from app.db.models import Album, AlbumImage, ColorLabel, FileType, Image, ImageTag, Tag, User
from app.services import maintenance


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, username="local"))
    session.commit()
    yield session
    session.close()


class _Upload:
    def __init__(self, path: Path):
        self.filename = path.name
        self.file = path.open("rb")


DEVELOP_JSON = json.dumps({"exposure": 1.5, "temperature": 180, "masks": []})
BAKED_JSON = json.dumps({"contrast": 20})


def _seed_library(db: Session) -> tuple[Image, Image, Album]:
    edited = Image(
        id="img-edited",
        file_path="2026/2026-07-01/edited.jpg",
        original_filename="edited.jpg",
        file_hash="hash-edited",
        file_type=FileType.jpeg,
        file_size=3,
        rating=4,
        color_label=ColorLabel.blue,
        edit_rotation=90,
        edit_straighten=1.5,
        edit_distortion=-20,
        edit_adjustments=DEVELOP_JSON,
        edit_rev=7,
        applied_adjustments=BAKED_JSON,
        immich_sync=True,
        immich_asset_id="immich-uuid-1",
    )
    trashed = Image(
        id="img-trashed",
        file_path="2026/2026-07-02/trashed.jpg",
        original_filename="trashed.jpg",
        file_hash="hash-trashed",
        file_type=FileType.jpeg,
        file_size=3,
        deleted_at=datetime(2026, 7, 10, tzinfo=timezone.utc),
    )
    db.add_all([edited, trashed])

    tag_travel = Tag(id="tag-travel", owner_id=1, name="travel")
    tag_edit = Tag(id="tag-edit", owner_id=1, name="edit")
    db.add_all([tag_travel, tag_edit])
    db.add(ImageTag(image_id=edited.id, tag_id=tag_travel.id))
    db.add(ImageTag(image_id=edited.id, tag_id=tag_edit.id))

    album = Album(id="album-1", owner_id=1, name="Trip", description="desc", immich_sync=True)
    db.add(album)
    db.add(AlbumImage(album_id=album.id, image_id=edited.id, position=0))
    db.commit()

    for image in (edited, trashed):
        full_path = settings.library_root / image.file_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"jpg")
    return edited, trashed, album


def test_backup_restore_round_trip(db: Session, monkeypatch):
    # Post-import derivative/embedding generation needs real image files and
    # the CLIP model; irrelevant to what this test asserts.
    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda *a, **k: None)

    _seed_library(db)
    zip_path = maintenance.build_backup_zip(db, owner_id=1)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            names = zf.namelist()
        assert "library/2026/2026-07-01/edited.jpg" in names
        assert "library/2026/2026-07-02/trashed.jpg" in names

        by_id = {i["id"]: i for i in manifest["images"]}
        assert by_id["img-edited"]["edit_adjustments"] == DEVELOP_JSON
        assert by_id["img-edited"]["tags"] == ["edit", "travel"]
        assert manifest["albums"][0]["immich_sync"] is True

        result = maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))
        assert (result["images_restored"], result["albums_restored"]) == (2, 1)
    finally:
        zip_path.unlink(missing_ok=True)

    edited = db.get(Image, "img-edited")
    assert edited.edit_adjustments == DEVELOP_JSON
    assert edited.applied_adjustments == BAKED_JSON
    assert edited.edit_rev == 7
    assert edited.edit_rotation == 90
    assert edited.edit_straighten == 1.5
    assert edited.edit_distortion == -20
    assert edited.rating == 4
    assert edited.color_label == ColorLabel.blue
    assert edited.immich_sync is True
    assert edited.immich_asset_id == "immich-uuid-1"
    # The album it was restored into hands it the membership tags too.
    assert edited.tags == ["album", "album: Trip", "edit", "travel"]

    trashed = db.get(Image, "img-trashed")
    assert trashed.deleted_at is not None

    album = db.get(Album, "album-1")
    assert album.immich_sync is True
    assert [link.image_id for link in album.images] == ["img-edited"]

    assert (settings.library_root / "2026/2026-07-01/edited.jpg").read_bytes() == b"jpg"


def test_wipe_library_clears_tags(db: Session):
    _seed_library(db)
    maintenance.wipe_library(db, owner_id=1)
    assert db.query(Tag).count() == 0
    assert db.query(ImageTag).count() == 0


def test_restore_accepts_v1_manifest_without_new_fields(db: Session, monkeypatch, tmp_path):
    """Backups made before the manifest carried edits/tags must still restore."""
    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda *a, **k: None)

    v1_image = {
        "id": "img-old",
        "file_path": "2025/2025-01-01/old.jpg",
        "original_filename": "old.jpg",
        "file_hash": "hash-old",
        "perceptual_hash": None,
        "file_type": "jpeg",
        "raw_format": None,
        "width": None,
        "height": None,
        "file_size": 3,
        "taken_at": None,
        "imported_at": datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat(),
        "camera_make": None,
        "camera_model": None,
        "iso": None,
        "aperture": None,
        "shutter_speed": None,
        "focal_length": None,
        "gps_lat": None,
        "gps_lon": None,
        "rating": 2,
        "color_label": "none",
        "paired_image_id": None,
        "edit_rotation": 0,
        "edit_crop_x": None,
        "edit_crop_y": None,
        "edit_crop_width": None,
        "edit_crop_height": None,
    }
    manifest = {
        "created_at": datetime(2025, 1, 2, tzinfo=timezone.utc).isoformat(),
        "images": [v1_image],
        "albums": [
            {
                "id": "album-old",
                "name": "Old",
                "description": None,
                "created_at": datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat(),
            }
        ],
        "album_images": [{"album_id": "album-old", "image_id": "img-old", "position": 0}],
    }
    zip_path = tmp_path / "old-backup.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("library/2025/2025-01-01/old.jpg", b"jpg")

    result = maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))
    assert (result["images_restored"], result["albums_restored"]) == (1, 1)

    restored = db.get(Image, "img-old")
    assert restored.rating == 2
    assert restored.edit_adjustments is None
    assert restored.tags == ["album", "album: Old"]
    assert restored.deleted_at is None
    assert db.get(Album, "album-old").immich_sync is False


# --- Version 3 manifests and the staged restore ------------------------------

from app.db.models import (  # noqa: E402
    AppSetting,
    Canvas,
    CanvasImage,
    CanvasLayout,
    LayoutItem,
    LayoutVersion,
    SourceRoot,
)


@pytest.fixture()
def roots(tmp_path, monkeypatch):
    """A library of its own per test, laid out like the desktop app: the data
    folder inside the library folder."""
    library = tmp_path / "library"
    data = library / ".photomanager"
    monkeypatch.setattr(settings, "library_root", library)
    monkeypatch.setattr(settings, "pm_data_dir", data)
    monkeypatch.setattr(settings, "thumbnail_cache_root", data / "thumbnails")
    monkeypatch.setattr(settings, "import_staging_root", data / "staging")
    monkeypatch.setattr(settings, "staged_thumbs_root", tmp_path / "staged-thumbs")
    for folder in (library, data, data / "thumbnails", data / "staging", tmp_path / "staged-thumbs"):
        folder.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda *a, **k: None)
    return library


def _photo(db: Session, id: str, rel: str, content: bytes = b"jpg") -> Image:
    image = Image(
        id=id,
        file_path=rel,
        original_filename=Path(rel).name,
        file_hash=f"hash-{id}",
        file_type=FileType.jpeg,
        file_size=len(content),
    )
    db.add(image)
    db.commit()
    full = settings.library_root / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(content)
    return image


def _manifest_zip(path: Path, manifest: dict, files: dict[str, bytes] | None = None) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        for name, content in (files or {}).items():
            zf.writestr(name, content)
    return path


def _minimal_image(id: str, rel: str) -> dict:
    return {
        "id": id, "file_path": rel, "original_filename": Path(rel).name, "file_hash": "h",
        "perceptual_hash": None, "file_type": "jpeg", "raw_format": None, "width": None,
        "height": None, "file_size": 3, "taken_at": None,
        "imported_at": datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat(),
        "camera_make": None, "camera_model": None, "iso": None, "aperture": None,
        "shutter_speed": None, "focal_length": None, "gps_lat": None, "gps_lon": None,
        "rating": 0, "color_label": "none", "paired_image_id": None, "edit_rotation": 0,
        "edit_crop_x": None, "edit_crop_y": None, "edit_crop_width": None, "edit_crop_height": None,
    }


def test_v3_round_trip_carries_tags_canvases_source_roots_and_settings(db: Session, roots):
    photo = _photo(db, "p1", "2026/2026-07-01/a.jpg")
    # A hierarchy lives in the tag's name; a "kept" tag has no photo at all.
    rome = Tag(id="t-rome", owner_id=1, name="Travel/Italy/Rome")
    vocab = Tag(id="t-vocab", owner_id=1, name="Vocabulary", kept=True)
    db.add_all([rome, vocab, ImageTag(image_id=photo.id, tag_id=rome.id)])
    db.add(Album(id="al", owner_id=1, name="Nested", tag_filter=json.dumps(["Travel/Italy/Rome"])))
    nas = SourceRoot(id="sr", owner_id=1, name="NAS", path="/Volumes/NAS/photos", auto_scan=False)
    db.add(nas)
    db.flush()
    external = Image(
        id="p-ext", file_path="/Volumes/NAS/photos/x.jpg", original_filename="x.jpg",
        file_hash="hx", file_type=FileType.jpeg, file_size=1, source_root_id="sr", rating=5,
    )
    db.add(external)
    canvas = Canvas(id="cv", owner_id=1, name="Zine")
    db.add(canvas)
    db.add(CanvasImage(canvas_id="cv", image_id=photo.id))
    layout = CanvasLayout(id="lay", canvas_id="cv", owner_id=1, page_width_mm=210.0, page_height_mm=297.0)
    db.add(layout)
    db.add(LayoutItem(id="it", layout_id="lay", image_id=photo.id, x_mm=10.0, y_mm=20.0, text=None))
    db.add(LayoutItem(id="cap", layout_id="lay", kind="text", text="Rome, July"))
    db.add(LayoutVersion(id="v1", layout_id="lay", name="Tuesday", doc='{"items": []}'))
    db.add_all([
        AppSetting(key="trash_retention_days", value="30"),
        AppSetting(key="immich_base_url", value="https://immich.local"),
        AppSetting(key="immich_api_key", value="secret-key"),
    ])
    db.commit()

    zip_path = maintenance.build_backup_zip(db, owner_id=1)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            compression = {info.filename: info.compress_type for info in zf.infolist()}
        assert manifest["version"] == maintenance.BACKUP_MANIFEST_VERSION
        # Photos are stored as they are, only the manifest is deflated.
        assert compression["library/2026/2026-07-01/a.jpg"] == zipfile.ZIP_STORED
        assert compression["manifest.json"] == zipfile.ZIP_DEFLATED
        # The in-place photo travels as metadata only, with its root.
        assert "library//Volumes/NAS/photos/x.jpg" not in compression
        assert [r["id"] for r in manifest["source_roots"]] == ["sr"]
        assert {i["id"] for i in manifest["images"]} == {"p1", "p-ext"}
        # The key never leaves the machine; the manifest says so.
        assert manifest["settings"] == {"trash_retention_days": "30", "immich_base_url": "https://immich.local"}
        assert "immich_api_key" in manifest["settings_excluded"]
        assert {t["name"] for t in manifest["tags"]} == {"Travel/Italy/Rome", "Vocabulary"}
        assert len(manifest["layout_items"]) == 2 and len(manifest["layout_versions"]) == 1

        # Meanwhile this machine changed: another key, another retention, and
        # a photo of its own that the restore replaces.
        db.get(AppSetting, "immich_api_key").value = "other-key"
        db.get(AppSetting, "trash_retention_days").value = "7"
        db.commit()
        _photo(db, "p-here", "2026/2026-08-01/today.jpg", b"today")

        result = maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))
    finally:
        zip_path.unlink(missing_ok=True)

    assert result["images_restored"] == 2 and result["canvases_restored"] == 1
    assert db.get(Image, "p-here") is None
    assert db.get(Image, "p-ext").source_root_id == "sr" and db.get(Image, "p-ext").rating == 5
    assert db.get(SourceRoot, "sr").auto_scan is False
    assert db.get(Tag, "t-vocab").kept is True
    # Its own tag, plus the membership tags the canvas hands it again.
    assert db.get(Image, "p1").tags == ["Travel/Italy/Rome", "canvas", "canvas: Zine"]
    assert db.get(Album, "al").tag_filter_list == ["Travel/Italy/Rome"]
    assert db.get(Canvas, "cv").name == "Zine"
    assert [ci.image_id for ci in db.get(Canvas, "cv").images] == ["p1"]
    restored_layout = db.get(CanvasLayout, "lay")
    assert restored_layout.page_height_mm == 297.0
    assert sorted((i.kind, i.text) for i in restored_layout.items) == [("photo", None), ("text", "Rome, July")]
    assert db.get(LayoutVersion, "v1").doc == '{"items": []}'
    # Settings from the backup, the key of this machine.
    assert db.get(AppSetting, "trash_retention_days").value == "30"
    assert db.get(AppSetting, "immich_api_key").value == "other-key"
    # The restored file is in place; the one that was here went aside, not away.
    assert (roots / "2026/2026-07-01/a.jpg").read_bytes() == b"jpg"
    assert not (roots / "2026/2026-08-01/today.jpg").exists()
    replaced = Path(result["replaced_folder"])
    assert replaced.is_relative_to(settings.pm_data_dir)
    assert (replaced / "2026/2026-08-01/today.jpg").read_bytes() == b"today"
    # Nothing of the staging is left behind.
    assert not any((settings.pm_data_dir / "restore-staging").iterdir()) if (
        settings.pm_data_dir / "restore-staging"
    ).exists() else True


@pytest.mark.parametrize(
    "bad_path",
    ["../outside.jpg", "/etc/passwd", "2026/../../outside.jpg", "..", "a\\..\\b.jpg"],
)
def test_a_manifest_path_that_escapes_the_library_is_refused(db: Session, roots, tmp_path, bad_path):
    _photo(db, "keep", "2026/2026-07-01/keep.jpg", b"keep")
    manifest = {"version": 2, "images": [_minimal_image("evil", bad_path)], "albums": [], "album_images": []}
    zip_path = _manifest_zip(tmp_path / "evil.zip", manifest, {"library/x.jpg": b"x"})

    with pytest.raises(maintenance.RestoreError, match="not changed"):
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))

    assert db.get(Image, "keep") is not None
    assert (roots / "2026/2026-07-01/keep.jpg").read_bytes() == b"keep"
    assert not (tmp_path / "outside.jpg").exists()
    assert not list((settings.pm_data_dir / "restore-staging").glob("*"))


def test_a_zip_member_that_escapes_the_library_is_refused(db: Session, roots, tmp_path):
    _photo(db, "keep", "2026/2026-07-01/keep.jpg", b"keep")
    manifest = {"version": 2, "images": [], "albums": [], "album_images": []}
    zip_path = _manifest_zip(tmp_path / "evil.zip", manifest, {"library/../escaped.jpg": b"x"})

    with pytest.raises(maintenance.RestoreError, match="outside the library"):
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))

    assert db.get(Image, "keep") is not None
    assert not (settings.pm_data_dir / "escaped.jpg").exists()
    assert not (roots / "escaped.jpg").exists()


def test_a_backup_from_a_newer_app_is_refused(db: Session, roots, tmp_path):
    _photo(db, "keep", "2026/2026-07-01/keep.jpg")
    manifest = {"version": maintenance.BACKUP_MANIFEST_VERSION + 1, "images": [], "albums": []}
    zip_path = _manifest_zip(tmp_path / "newer.zip", manifest)
    with pytest.raises(maintenance.RestoreError, match="newer"):
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))
    assert db.get(Image, "keep") is not None


def test_not_a_zip_is_refused_without_touching_anything(db: Session, roots, tmp_path):
    _photo(db, "keep", "2026/2026-07-01/keep.jpg")
    not_zip = tmp_path / "photo.jpg"
    not_zip.write_bytes(b"\xff\xd8\xff not a zip")
    with pytest.raises(maintenance.RestoreError, match="not a zip"):
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(not_zip))
    assert db.get(Image, "keep") is not None


def test_a_failure_while_writing_the_catalog_leaves_the_library_untouched(
    db: Session, roots, tmp_path, monkeypatch
):
    old = _photo(db, "keep", "2026/2026-07-01/keep.jpg", b"keep")
    db.add(Tag(id="t", owner_id=1, name="mine"))
    db.add(ImageTag(image_id=old.id, tag_id="t"))
    db.commit()

    manifest = {
        "version": 2,
        "images": [_minimal_image("new", "2026/2026-07-02/new.jpg")],
        "albums": [],
        "album_images": [],
    }
    zip_path = _manifest_zip(tmp_path / "b.zip", manifest, {"library/2026/2026-07-02/new.jpg": b"new"})

    # The last step inside the transaction blows up.
    def _boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(maintenance, "sync_membership_tags", _boom)
    with pytest.raises(maintenance.RestoreError, match="disk on fire.*not changed"):
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))

    # Rows: the old ones, none of the new.
    assert db.get(Image, "new") is None
    assert db.get(Image, "keep").tags == ["mine"]
    assert db.query(Tag).count() == 1
    # Files: the old one in place, the new one nowhere in the library, no
    # staging and no "replaced" folder left behind.
    assert (roots / "2026/2026-07-01/keep.jpg").read_bytes() == b"keep"
    assert not (roots / "2026/2026-07-02").exists()
    assert not list(settings.pm_data_dir.glob("restore-replaced-*"))
    assert not list((settings.pm_data_dir / "restore-staging").glob("*"))


def test_a_v2_manifest_without_the_new_sections_still_restores(db: Session, roots, tmp_path):
    """The manifest shape of 0.1.9x: images with tag names, albums, album_images
    and nothing else."""
    image = _minimal_image("old", "2025/2025-01-01/old.jpg")
    image["tags"] = ["travel", "Travel/Italy"]
    manifest = {
        "version": 2,
        "created_at": "2025-01-02T00:00:00+00:00",
        "images": [image],
        "albums": [{"id": "a", "name": "A", "description": None, "created_at": "2025-01-01T00:00:00+00:00",
                    "immich_sync": True}],
        "album_images": [{"album_id": "a", "image_id": "old", "position": 3}],
    }
    zip_path = _manifest_zip(tmp_path / "v2.zip", manifest, {"library/2025/2025-01-01/old.jpg": b"old"})

    result = maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))

    assert (result["images_restored"], result["albums_restored"], result["canvases_restored"]) == (1, 1, 0)
    assert result["replaced_folder"] is None  # the library was empty, nothing went aside
    restored = db.get(Image, "old")
    assert restored.tags == ["Travel/Italy", "album", "album: A", "travel"]
    assert db.get(Album, "a").immich_sync is True
    assert (roots / "2025/2025-01-01/old.jpg").read_bytes() == b"old"


def test_wipe_library_clears_canvases_and_source_roots(db: Session, roots):
    photo = _photo(db, "p", "2026/2026-07-01/a.jpg")
    db.add(SourceRoot(id="sr", owner_id=1, name="NAS", path="/nas"))
    db.add(Canvas(id="cv", owner_id=1, name="Zine"))
    db.flush()
    db.add(CanvasImage(canvas_id="cv", image_id=photo.id))
    db.add(CanvasLayout(id="lay", canvas_id="cv", owner_id=1))
    db.flush()
    db.add(LayoutItem(id="it", layout_id="lay", image_id=photo.id))
    db.add(LayoutVersion(id="v", layout_id="lay", doc="{}"))
    db.commit()

    maintenance.wipe_library(db, owner_id=1)

    for model in (Image, Canvas, CanvasImage, CanvasLayout, LayoutItem, LayoutVersion, SourceRoot):
        assert db.query(model).count() == 0, model.__name__
    assert not (roots / "2026").exists()
    # The data folder inside the library survives the wipe.
    assert settings.pm_data_dir.is_dir()


def test_snapshots_and_presets_travel_with_a_backup(db: Session, monkeypatch):
    """A photo's named snapshots and the library's develop presets are in the
    backup and come back with the restore."""
    from app.db.models import DevelopPreset, EditSnapshot

    monkeypatch.setattr(maintenance, "enqueue_post_import", lambda *a, **k: None)
    _seed_library(db)
    db.add(EditSnapshot(id="snap-1", image_id="img-edited", name="Warm", edits='{"rotation": 0}'))
    db.add(DevelopPreset(id="pre-1", owner_id=1, name="Film", sections='["film"]', adjustments='{"film_sim": "provia"}'))
    db.commit()

    zip_path = maintenance.build_backup_zip(db, owner_id=1)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        assert [s["id"] for s in manifest["edit_snapshots"]] == ["snap-1"]
        assert [p["name"] for p in manifest["develop_presets"]] == ["Film"]
        maintenance.restore_from_backup(db, owner_id=1, upload=_Upload(zip_path))
    finally:
        zip_path.unlink(missing_ok=True)

    snap = db.get(EditSnapshot, "snap-1")
    assert snap is not None and snap.name == "Warm" and snap.image_id == "img-edited"
    preset = db.get(DevelopPreset, "pre-1")
    assert preset is not None and preset.adjustments == '{"film_sim": "provia"}'
