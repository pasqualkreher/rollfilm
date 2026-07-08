import json
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    FileType,
    Image,
    ImportSession,
    ImportSessionStatus,
    ImportStagedFile,
)
from app.services.exif import read_exif
from app.services.filesystem import library_relative_path
from app.services.hashing import hamming_distance, perceptual_hash, sha256_file
from app.services.pairing import pair_siblings
from app.services.raw import classify_file_type, extract_preview
from app.workers.queue import enqueue_post_import


class UploadedFile(Protocol):
    """Structural type matching FastAPI's UploadFile - kept narrow so this
    module doesn't need to import Starlette directly."""

    filename: str | None
    file: BinaryIO

STAGING_THUMBNAIL_PX = 512


def _same_shot_stem(name_a: str, name_b: str) -> bool:
    return Path(name_a).stem.lower() == Path(name_b).stem.lower()


def compute_staged_pairs(staged_files: list[ImportStagedFile]) -> dict[str, str]:
    """Read-only preview of the RAW+JPEG pairing pair_siblings() will do at
    commit time, so the review screen can offer the same combined/JPEG/RAW
    view toggle as the library before anything is actually imported."""
    by_stem: dict[str, list[ImportStagedFile]] = defaultdict(list)
    for f in staged_files:
        by_stem[Path(f.original_filename).stem.lower()].append(f)

    pairs: dict[str, str] = {}
    for group in by_stem.values():
        raws = [f for f in group if f.file_type == FileType.raw]
        jpegs = [f for f in group if f.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            pairs[raws[0].id] = jpegs[0].id
            pairs[jpegs[0].id] = raws[0].id
    return pairs


def _find_near_duplicate_image(db: Session, owner_id: int, phash: str | None, filename: str) -> Image | None:
    if not phash:
        return None
    candidates = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.perceptual_hash.isnot(None))
        .all()
    )
    for candidate in candidates:
        # A RAW+JPEG pair from the same shot has (near-)identical pixels but is
        # a sibling to be paired (see pairing.py), not a duplicate to flag -
        # same basename, different extension, is that sibling relationship.
        if _same_shot_stem(filename, candidate.original_filename):
            continue
        if hamming_distance(phash, candidate.perceptual_hash) <= settings.duplicate_phash_hamming_threshold:
            return candidate
    return None


def _find_near_duplicate_staged_file(
    already_staged: list[ImportStagedFile], phash: str | None, filename: str
) -> ImportStagedFile | None:
    if not phash:
        return None
    for candidate in already_staged:
        if _same_shot_stem(filename, candidate.original_filename):
            continue
        if hamming_distance(phash, candidate.perceptual_hash) <= settings.duplicate_phash_hamming_threshold:
            return candidate
    return None


def _stage_one_file(
    db: Session,
    session: ImportSession,
    thumb_dir: Path,
    owner_id: int,
    already_staged: list[ImportStagedFile],
    staged_path: Path,
    original_filename: str,
    file_type: str,
) -> None:
    sha256 = sha256_file(staged_path)
    preview = extract_preview(staged_path)
    phash = perceptual_hash(preview)
    exif = read_exif(staged_path)

    thumb = preview.copy()
    thumb.thumbnail((STAGING_THUMBNAIL_PX, STAGING_THUMBNAIL_PX))

    staged_file = ImportStagedFile(
        import_session_id=session.id,
        staged_path=str(staged_path.relative_to(settings.import_staging_root)),
        original_filename=original_filename,
        file_type=FileType(file_type),
        sha256=sha256,
        perceptual_hash=phash,
        exif_json=exif.to_json(),
    )
    db.add(staged_file)
    db.flush()

    thumb.save(thumb_dir / f"{staged_file.id}.jpg", "JPEG", quality=80)

    # Check the already-committed library first, then files already staged
    # earlier in this same batch (e.g. an SD card with two copies of a shot) -
    # both are "duplicates" from the user's point of view, just against
    # different things.
    exact_image_match = (
        db.query(Image).filter(Image.owner_id == owner_id, Image.file_hash == sha256).first()
    )
    if exact_image_match:
        staged_file.duplicate_of_image_id = exact_image_match.id
        # Byte-identical to a photo already in the library - don't import it
        # again by default (the API also rejects re-selecting it - see
        # update_staged_file in api/routes/import_.py).
        staged_file.selected = False
    else:
        exact_staged_match = next((s for s in already_staged if s.sha256 == sha256), None)
        if exact_staged_match:
            staged_file.duplicate_of_staged_file_id = exact_staged_match.id
            staged_file.selected = False
        else:
            near_image_match = _find_near_duplicate_image(db, owner_id, phash, original_filename)
            if near_image_match:
                staged_file.duplicate_of_image_id = near_image_match.id
                staged_file.is_near_duplicate = True
            else:
                near_staged_match = _find_near_duplicate_staged_file(already_staged, phash, original_filename)
                if near_staged_match:
                    staged_file.duplicate_of_staged_file_id = near_staged_match.id
                    staged_file.is_near_duplicate = True

    already_staged.append(staged_file)


def stage_uploaded_files(
    db: Session, owner_id: int, uploads: list[UploadedFile], source_label: str
) -> ImportSession:
    """Handles photos picked via the browser's native folder dialog and
    uploaded over HTTP - the backend never needs filesystem access to
    wherever the user's SD card/folder actually is."""
    session = ImportSession(owner_id=owner_id, source_path=source_label or "Uploaded folder")
    db.add(session)
    db.flush()

    session_dir = settings.import_staging_root / session.id
    thumb_dir = session_dir / ".thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    already_staged: list[ImportStagedFile] = []

    for upload in uploads:
        original_filename = Path(upload.filename or "").name
        if not original_filename or original_filename.startswith("."):
            continue
        file_type = classify_file_type(Path(original_filename))
        if file_type is None:
            continue

        staged_path = session_dir / original_filename
        counter = 1
        while staged_path.exists():
            staged_path = session_dir / f"{Path(original_filename).stem}_{counter}{Path(original_filename).suffix}"
            counter += 1

        with staged_path.open("wb") as out:
            shutil.copyfileobj(upload.file, out)

        _stage_one_file(
            db, session, thumb_dir, owner_id, already_staged, staged_path, original_filename, file_type
        )

    db.commit()
    db.refresh(session)
    return session


def commit_import_session(db: Session, session: ImportSession, owner_id: int) -> list[Image]:
    selected_files = [
        f
        for f in session.staged_files
        if f.selected and not ((f.duplicate_of_image_id or f.duplicate_of_staged_file_id) and not f.is_near_duplicate)
    ]
    new_images: list[Image] = []

    for staged in selected_files:
        exif_dict = json.loads(staged.exif_json) if staged.exif_json else {}
        staged_full_path = settings.import_staging_root / staged.staged_path

        taken_at = (
            datetime.fromisoformat(exif_dict["taken_at"]) if exif_dict.get("taken_at") else None
        )
        if taken_at is None:
            taken_at = datetime.fromtimestamp(staged_full_path.stat().st_mtime, tz=timezone.utc)

        relative_dest = library_relative_path(taken_at, staged.original_filename, settings.library_root)
        dest_path = settings.library_root / relative_dest
        shutil.move(str(staged_full_path), str(dest_path))

        image = Image(
            owner_id=owner_id,
            file_path=relative_dest,
            original_filename=staged.original_filename,
            file_hash=staged.sha256,
            perceptual_hash=staged.perceptual_hash,
            file_type=staged.file_type,
            raw_format=(
                Path(staged.original_filename).suffix.lstrip(".").upper()
                if staged.file_type == FileType.raw
                else None
            ),
            width=exif_dict.get("width"),
            height=exif_dict.get("height"),
            file_size=dest_path.stat().st_size,
            taken_at=taken_at,
            camera_make=exif_dict.get("camera_make"),
            camera_model=exif_dict.get("camera_model"),
            iso=exif_dict.get("iso"),
            aperture=exif_dict.get("aperture"),
            shutter_speed=exif_dict.get("shutter_speed"),
            focal_length=exif_dict.get("focal_length"),
            gps_lat=exif_dict.get("gps_lat"),
            gps_lon=exif_dict.get("gps_lon"),
            rating=staged.rating,
            color_label=staged.color_label,
        )
        db.add(image)
        db.flush()
        new_images.append(image)

    pair_siblings(new_images)
    session.status = ImportSessionStatus.committed
    db.commit()

    for image in new_images:
        db.refresh(image)
        enqueue_post_import(image.id, settings.library_root / image.file_path)

    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    return new_images


def discard_import_session(db: Session, session: ImportSession) -> None:
    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    session.status = ImportSessionStatus.discarded
    db.commit()
