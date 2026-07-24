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
        assert result == {"images_restored": 2, "albums_restored": 1}
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
    assert edited.tags == ["edit", "travel"]

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
    assert result == {"images_restored": 1, "albums_restored": 1}

    restored = db.get(Image, "img-old")
    assert restored.rating == 2
    assert restored.edit_adjustments is None
    assert restored.tags == []
    assert restored.deleted_at is None
    assert db.get(Album, "album-old").immich_sync is False
