import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import Album, AlbumImage, ColorLabel, FileType, Image, ImportSession, ImportStagedFile
from app.services.exif import read_exif
from app.services.raw import classify_file_type
from app.services.thumbnails import derivative_dir, regenerate_for_image
from app.workers.queue import enqueue_post_import


class UploadedFile(Protocol):
    filename: str | None
    file: BinaryIO


def sync_db_with_library(db: Session, owner_id: int) -> dict:
    """The filesystem is the source of truth: any DB row whose file no
    longer exists under LIBRARY_ROOT (e.g. deleted/moved outside the app)
    gets removed, along with its cached thumbnails. Files found in the
    library that aren't tracked in the DB are only reported, not
    auto-imported - re-adding them is what the Import flow is for."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    removed = 0
    for image in images:
        if not (settings.library_root / image.file_path).exists():
            shutil.rmtree(derivative_dir(image.id), ignore_errors=True)
            db.delete(image)
            removed += 1
    db.commit()

    tracked = {
        str((settings.library_root / img.file_path).resolve())
        for img in db.query(Image).filter(Image.owner_id == owner_id).all()
    }
    untracked = sum(
        1
        for path in settings.library_root.rglob("*")
        if path.is_file() and classify_file_type(path) is not None and str(path.resolve()) not in tracked
    )
    return {"removed_missing_files": removed, "untracked_files_found": untracked}


def rebuild_all_thumbnails(db: Session, owner_id: int) -> dict:
    """Regenerates every cached thumbnail/preview from the original library
    files - e.g. after a rendering fix that only affects newly-generated
    derivatives (existing cached ones need to be rebuilt to pick it up)."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    rebuilt = 0
    for image in images:
        full_path = settings.library_root / image.file_path
        if full_path.exists():
            regenerate_for_image(image)
            # Backfill orientation-correct dimensions for photos imported before
            # width/height accounted for the EXIF orientation tag, so the grid
            # can show each one at its true portrait/landscape shape.
            exif = read_exif(full_path)
            if exif.width and exif.height:
                image.width = exif.width
                image.height = exif.height
            rebuilt += 1
    db.commit()
    return {"rebuilt": rebuilt}


def wipe_library(db: Session, owner_id: int) -> None:
    session_ids = [s.id for s in db.query(ImportSession).filter(ImportSession.owner_id == owner_id).all()]
    if session_ids:
        db.query(ImportStagedFile).filter(
            ImportStagedFile.import_session_id.in_(session_ids)
        ).delete(synchronize_session=False)
        db.query(ImportSession).filter(ImportSession.owner_id == owner_id).delete(synchronize_session=False)

    album_ids = [a.id for a in db.query(Album).filter(Album.owner_id == owner_id).all()]
    if album_ids:
        db.query(AlbumImage).filter(AlbumImage.album_id.in_(album_ids)).delete(synchronize_session=False)
        db.query(Album).filter(Album.owner_id == owner_id).delete(synchronize_session=False)

    db.query(Image).filter(Image.owner_id == owner_id).delete(synchronize_session=False)
    db.commit()

    for root in (settings.library_root, settings.thumbnail_cache_root, settings.import_staging_root):
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)


def _image_to_dict(image: Image) -> dict:
    return {
        "id": image.id,
        "file_path": image.file_path,
        "original_filename": image.original_filename,
        "file_hash": image.file_hash,
        "perceptual_hash": image.perceptual_hash,
        "file_type": image.file_type.value,
        "raw_format": image.raw_format,
        "width": image.width,
        "height": image.height,
        "file_size": image.file_size,
        "taken_at": image.taken_at.isoformat() if image.taken_at else None,
        "imported_at": image.imported_at.isoformat(),
        "camera_make": image.camera_make,
        "camera_model": image.camera_model,
        "iso": image.iso,
        "aperture": image.aperture,
        "shutter_speed": image.shutter_speed,
        "focal_length": image.focal_length,
        "gps_lat": image.gps_lat,
        "gps_lon": image.gps_lon,
        "rating": image.rating,
        "color_label": image.color_label.value,
        "paired_image_id": image.paired_image_id,
        "edit_rotation": image.edit_rotation,
        "edit_crop_x": image.edit_crop_x,
        "edit_crop_y": image.edit_crop_y,
        "edit_crop_width": image.edit_crop_width,
        "edit_crop_height": image.edit_crop_height,
    }


def build_backup_zip(db: Session, owner_id: int) -> Path:
    """A portable backup: the actual library files plus a JSON manifest of
    all metadata (ratings, albums, edits, ...). Deliberately not a raw copy
    of the sqlite file - swapping that out from under a live connection pool
    on restore would be fragile; restoring by re-inserting rows is safer."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    albums = db.query(Album).filter(Album.owner_id == owner_id).all()
    album_images = db.query(AlbumImage).join(Album).filter(Album.owner_id == owner_id).all()

    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "images": [_image_to_dict(i) for i in images],
        "albums": [
            {
                "id": a.id,
                "name": a.name,
                "description": a.description,
                "created_at": a.created_at.isoformat(),
            }
            for a in albums
        ],
        "album_images": [
            {"album_id": ai.album_id, "image_id": ai.image_id, "position": ai.position} for ai in album_images
        ],
    }

    fd, tmp_path_str = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    tmp_path = Path(tmp_path_str)
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        for image in images:
            full_path = settings.library_root / image.file_path
            if full_path.exists():
                zf.write(full_path, arcname=f"library/{image.file_path}")
    return tmp_path


def restore_from_backup(db: Session, owner_id: int, upload: UploadedFile) -> dict:
    """Replaces everything currently in the library/DB with the contents of
    a previously exported backup - a destructive operation, gated the same
    way as wipe_library() (see the /maintenance/restore route)."""
    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        tmp_zip = tmp_dir / "backup.zip"
        with tmp_zip.open("wb") as out:
            shutil.copyfileobj(upload.file, out)

        with zipfile.ZipFile(tmp_zip) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            zf.extractall(tmp_dir)

        wipe_library(db, owner_id)

        for image_data in manifest["images"]:
            src = tmp_dir / "library" / image_data["file_path"]
            dest = settings.library_root / image_data["file_path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if src.exists():
                shutil.copy2(src, dest)

        for image_data in manifest["images"]:
            db.add(
                Image(
                    id=image_data["id"],
                    owner_id=owner_id,
                    file_path=image_data["file_path"],
                    original_filename=image_data["original_filename"],
                    file_hash=image_data["file_hash"],
                    perceptual_hash=image_data["perceptual_hash"],
                    file_type=FileType(image_data["file_type"]),
                    raw_format=image_data["raw_format"],
                    width=image_data["width"],
                    height=image_data["height"],
                    file_size=image_data["file_size"],
                    taken_at=datetime.fromisoformat(image_data["taken_at"]) if image_data["taken_at"] else None,
                    imported_at=datetime.fromisoformat(image_data["imported_at"]),
                    camera_make=image_data["camera_make"],
                    camera_model=image_data["camera_model"],
                    iso=image_data["iso"],
                    aperture=image_data["aperture"],
                    shutter_speed=image_data["shutter_speed"],
                    focal_length=image_data["focal_length"],
                    gps_lat=image_data["gps_lat"],
                    gps_lon=image_data["gps_lon"],
                    rating=image_data["rating"],
                    color_label=ColorLabel(image_data["color_label"]),
                    edit_rotation=image_data["edit_rotation"],
                    edit_crop_x=image_data["edit_crop_x"],
                    edit_crop_y=image_data["edit_crop_y"],
                    edit_crop_width=image_data["edit_crop_width"],
                    edit_crop_height=image_data["edit_crop_height"],
                )
            )
        db.flush()
        for image_data in manifest["images"]:
            if image_data["paired_image_id"]:
                db.get(Image, image_data["id"]).paired_image_id = image_data["paired_image_id"]

        for album_data in manifest["albums"]:
            db.add(
                Album(
                    id=album_data["id"],
                    owner_id=owner_id,
                    name=album_data["name"],
                    description=album_data["description"],
                    created_at=datetime.fromisoformat(album_data["created_at"]),
                )
            )
        db.flush()
        for ai in manifest["album_images"]:
            db.add(AlbumImage(album_id=ai["album_id"], image_id=ai["image_id"], position=ai["position"]))

        db.commit()

        restored_images = db.query(Image).filter(Image.owner_id == owner_id).all()
        for image in restored_images:
            full_path = settings.library_root / image.file_path
            if full_path.exists():
                enqueue_post_import(image.id, full_path)

        return {"images_restored": len(manifest["images"]), "albums_restored": len(manifest["albums"])}
