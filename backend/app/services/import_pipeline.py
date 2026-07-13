import json
import logging
import os
import queue
import shutil
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    ColorLabel,
    FileType,
    Image,
    ImportSession,
    ImportSessionStatus,
    ImportStagedFile,
)
from app.services.exif import ExifData, new_helper, read_exif, to_float, to_int
from app.services.filesystem import library_relative_path
from app.services.hashing import hamming_int, perceptual_hash, phash_to_int, sha256_file
from app.services.pairing import pair_siblings
from app.services.raw import classify_file_type, extract_preview
from app.services.settings_store import get_immich_config
from app.services.thumbnails import THUMBNAIL_MAX_PX, THUMBNAIL_SCALE
from app.workers.queue import enqueue_immich_upload, enqueue_post_import

from PIL import Image as PILImage


class UploadedFile(Protocol):
    """Structural type matching FastAPI's UploadFile - kept narrow so this
    module doesn't need to import Starlette directly."""

    filename: str | None
    file: BinaryIO


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


logger = logging.getLogger(__name__)

# Cap on the concurrent staging workers (and thus exiftool processes). Staging
# is CPU/IO bound and each file is independent, so this scales close to linearly
# with cores; capped so a huge import doesn't spawn an unreasonable number of
# exiftool subprocesses.
_STAGE_WORKERS = min(8, (os.cpu_count() or 4))


@dataclass
class _Analyzed:
    """The result of the heavy, per-file staging work (hashing, preview, phash,
    exif, thumbnail) - computed in parallel, then turned into DB rows serially.
    Carries a pre-generated id so its thumbnail can be written before the row
    exists in the database."""

    id: str
    staged_rel_path: str
    original_filename: str
    file_type: str
    sha256: str
    perceptual_hash: str | None
    exif_json: str


def _analyze_file(
    staged_path: Path,
    original_filename: str,
    file_type: str,
    staged_id: str,
    thumb_dir: Path,
    helper,
) -> _Analyzed:
    """Pure computation, safe to run on a worker thread (no DB access). sha256
    always succeeds (it just reads bytes); preview/phash/thumbnail/exif are each
    guarded so a single corrupt file can't abort a large import - it's still
    staged (its bytes are known) just without a preview/hash."""
    sha256 = sha256_file(staged_path)
    perceptual = None
    exif = ExifData()

    try:
        preview = extract_preview(staged_path)
        perceptual = perceptual_hash(preview)
        # Match the library's grid thumbnail exactly (0.25 of the original,
        # capped, LANCZOS) so the import review shows the same quality.
        thumb = preview.copy()
        tw = min(THUMBNAIL_MAX_PX, max(1, round(thumb.width * THUMBNAIL_SCALE)))
        th = min(THUMBNAIL_MAX_PX, max(1, round(thumb.height * THUMBNAIL_SCALE)))
        thumb.thumbnail((tw, th), PILImage.LANCZOS)
        thumb.save(thumb_dir / f"{staged_id}.jpg", "JPEG", quality=88)
    except Exception:
        logger.exception("Preview/thumbnail failed for %s (staged without one)", original_filename)

    try:
        exif = read_exif(staged_path, helper=helper)
    except Exception:
        logger.exception("EXIF read failed for %s", original_filename)

    return _Analyzed(
        id=staged_id,
        staged_rel_path=str(staged_path.relative_to(settings.import_staging_root)),
        original_filename=original_filename,
        file_type=file_type,
        sha256=sha256,
        perceptual_hash=perceptual,
        exif_json=exif.to_json(),
    )


def _analyze_parallel(tasks: list[tuple[Path, str, str, str]], thumb_dir: Path) -> list[_Analyzed]:
    """Run _analyze_file across a thread pool. Each worker gets its own exiftool
    process (a shared -stay_open helper can't be used from multiple threads).
    Results come back in task order so batch-dedup and pairing stay stable."""
    if not tasks:
        return []
    workers = min(_STAGE_WORKERS, len(tasks))
    helpers = [new_helper() for _ in range(workers)]
    pool: queue.Queue = queue.Queue()
    for h in helpers:
        pool.put(h)

    def run(task: tuple[Path, str, str, str]) -> _Analyzed:
        staged_path, original_filename, file_type, staged_id = task
        helper = pool.get()
        try:
            return _analyze_file(staged_path, original_filename, file_type, staged_id, thumb_dir, helper)
        finally:
            pool.put(helper)

    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            return list(executor.map(run, tasks))
    finally:
        for h in helpers:
            try:
                h.terminate()
            except Exception:
                pass


def _persist_analyzed(
    db: Session, session: ImportSession, owner_id: int, analyzed: list[_Analyzed]
) -> None:
    """Turn analysis results into ImportStagedFile rows and flag duplicates.
    Runs serially (the SQLAlchemy session isn't thread-safe). All the dedup
    lookup data is loaded once up front instead of re-querying the whole image
    table per file, and hashes are compared as ints - that's what keeps a big
    import from degrading into O(files x library) database round-trips."""
    threshold = settings.duplicate_phash_hamming_threshold

    # Preload the library's dedup indexes once.
    image_by_hash: dict[str, object] = {}
    image_phashes: list[tuple[int, str, object]] = []  # (int phash, filename, row)
    for row in db.query(
        Image.id, Image.file_hash, Image.perceptual_hash, Image.original_filename, Image.source_root_id
    ).filter(Image.owner_id == owner_id):
        image_by_hash.setdefault(row.file_hash, row)
        if row.perceptual_hash:
            image_phashes.append((phash_to_int(row.perceptual_hash), row.original_filename, row))

    # Seed the in-batch indexes with anything already staged in this session (so
    # a later upload batch is still deduped against earlier ones).
    staged_by_hash: dict[str, ImportStagedFile] = {}
    staged_phashes: list[tuple[int, str, ImportStagedFile]] = []
    for existing in session.staged_files:
        staged_by_hash.setdefault(existing.sha256, existing)
        if existing.perceptual_hash:
            staged_phashes.append((phash_to_int(existing.perceptual_hash), existing.original_filename, existing))

    def _near(phash_int: int, filename: str, candidates) -> object | None:
        for other_int, other_name, ref in candidates:
            # A RAW+JPEG pair from the same shot has near-identical pixels but is
            # a sibling to be paired (see pairing.py), not a duplicate.
            if _same_shot_stem(filename, other_name):
                continue
            if hamming_int(phash_int, other_int) <= threshold:
                return ref
        return None

    for a in analyzed:
        staged_file = ImportStagedFile(
            id=a.id,
            import_session_id=session.id,
            staged_path=a.staged_rel_path,
            original_filename=a.original_filename,
            file_type=FileType(a.file_type),
            sha256=a.sha256,
            perceptual_hash=a.perceptual_hash,
            exif_json=a.exif_json,
        )

        # Exact library match first, then exact match earlier in this session,
        # then a perceptual near-duplicate against the library, then the session.
        exact_image = image_by_hash.get(a.sha256)
        if exact_image is not None:
            staged_file.duplicate_of_image_id = exact_image.id
            if exact_image.source_root_id is None:
                # Byte-identical to a managed-library photo - don't re-import by
                # default (the API also rejects re-selecting it).
                staged_file.selected = False
            # else: only copy is indexed in place from an external source root;
            # importing promotes it, so leave it selected.
        elif a.sha256 in staged_by_hash:
            staged_file.duplicate_of_staged_file_id = staged_by_hash[a.sha256].id
            staged_file.selected = False
        elif a.perceptual_hash:
            phash_int = phash_to_int(a.perceptual_hash)
            near_image = _near(phash_int, a.original_filename, image_phashes)
            if near_image is not None:
                staged_file.duplicate_of_image_id = near_image.id
                staged_file.is_near_duplicate = True
            else:
                near_staged = _near(phash_int, a.original_filename, staged_phashes)
                if near_staged is not None:
                    staged_file.duplicate_of_staged_file_id = near_staged.id
                    staged_file.is_near_duplicate = True

        db.add(staged_file)
        staged_by_hash.setdefault(a.sha256, staged_file)
        if a.perceptual_hash:
            staged_phashes.append((phash_to_int(a.perceptual_hash), a.original_filename, staged_file))


def stage_uploaded_files(
    db: Session, owner_id: int, uploads: list[UploadedFile], source_label: str
) -> ImportSession:
    """Handles photos picked via the browser's native folder dialog and
    uploaded over HTTP - the backend never needs filesystem access to
    wherever the user's SD card/folder actually is."""
    session = ImportSession(owner_id=owner_id, source_path=source_label or "Uploaded folder")
    db.add(session)
    db.flush()
    _stage_uploads_into(db, session, owner_id, uploads)
    db.commit()
    db.refresh(session)
    return session


def append_uploaded_files(
    db: Session, session: ImportSession, owner_id: int, uploads: list[UploadedFile]
) -> ImportSession:
    """Stage another batch of uploads into an existing staging session. The
    multipart parser caps a single request at 1000 files, so big imports are
    sent as several requests all appending to one session - duplicate checks
    and RAW+JPEG pairing still see the whole session, not just one batch."""
    _stage_uploads_into(db, session, owner_id, uploads)
    db.commit()
    db.refresh(session)
    return session


def _stage_uploads_into(
    db: Session, session: ImportSession, owner_id: int, uploads: list[UploadedFile]
) -> None:
    session_dir = settings.import_staging_root / session.id
    thumb_dir = session_dir / ".thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    # 1) Write each upload to the staging folder. Serial because it drains the
    #    per-request upload streams; cheap next to the analysis below.
    tasks: list[tuple[Path, str, str, str]] = []
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

        tasks.append((staged_path, original_filename, file_type, str(uuid.uuid4())))

    # 2) Hash/preview/phash/exif/thumbnail every file in parallel (the slow part,
    #    independent per file), then 3) write the rows + dedup serially.
    analyzed = _analyze_parallel(tasks, thumb_dir)
    _persist_analyzed(db, session, owner_id, analyzed)


def commit_import_session(
    db: Session, session: ImportSession, owner_id: int, upload_to_immich: bool = False
) -> list[Image]:
    def _exact_referenced_duplicate(f: ImportStagedFile) -> Image | None:
        """The scan-in-place (source root) image this staged file is a
        byte-identical copy of, if any. That's the one exact-duplicate case
        where importing is still allowed: a copy imported *into* the library
        is the source of truth, so committing promotes the referenced row to
        a managed one instead of creating a duplicate."""
        if not f.duplicate_of_image_id or f.is_near_duplicate:
            return None
        existing = db.get(Image, f.duplicate_of_image_id)
        if existing is not None and existing.source_root_id is not None:
            return existing
        return None

    def _is_exact_duplicate(f: ImportStagedFile) -> bool:
        return bool(
            (f.duplicate_of_image_id or f.duplicate_of_staged_file_id) and not f.is_near_duplicate
        )

    selected_files = [
        f
        for f in session.staged_files
        if f.selected and (not _is_exact_duplicate(f) or _exact_referenced_duplicate(f) is not None)
    ]
    new_images: list[Image] = []

    for staged in selected_files:
        # Re-checked per file (not just in the filter above) because an earlier
        # file in this same commit may have already promoted the shared
        # duplicate target - importing this one too would duplicate it.
        promoted = _exact_referenced_duplicate(staged)
        if _is_exact_duplicate(staged) and promoted is None:
            continue

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

        if promoted is not None:
            # Same bytes, previously only indexed in place from an external
            # folder. Point the existing row at the fresh library copy and drop
            # its source link - it keeps its id, so rating, tags, albums, edits
            # and RAW/JPEG pairing all survive. The external file stays where
            # it is, untouched.
            promoted.file_path = relative_dest
            promoted.source_root_id = None
            promoted.original_filename = staged.original_filename
            promoted.file_size = dest_path.stat().st_size
            # A previously deleted source-root photo lives on as a hidden
            # scan-exclusion row; importing the same bytes is the explicit way
            # to bring it back.
            promoted.deleted_at = None
            if staged.rating:
                promoted.rating = staged.rating
            if staged.color_label != ColorLabel.none:
                promoted.color_label = staged.color_label
            image = promoted
        else:
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
                # Coerced defensively: sessions staged before exif.py sanitised
                # numeric tags can still carry exiftool's 'undef' strings in
                # their stored exif_json.
                width=to_int(exif_dict.get("width")),
                height=to_int(exif_dict.get("height")),
                file_size=dest_path.stat().st_size,
                taken_at=taken_at,
                camera_make=exif_dict.get("camera_make"),
                camera_model=exif_dict.get("camera_model"),
                iso=to_int(exif_dict.get("iso")),
                aperture=to_float(exif_dict.get("aperture")),
                shutter_speed=exif_dict.get("shutter_speed"),
                focal_length=to_float(exif_dict.get("focal_length")),
                gps_lat=to_float(exif_dict.get("gps_lat")),
                gps_lon=to_float(exif_dict.get("gps_lon")),
                rating=staged.rating,
                color_label=staged.color_label,
            )
            db.add(image)
        db.flush()
        new_images.append(image)

    pair_siblings(new_images)
    session.status = ImportSessionStatus.committed
    db.commit()

    # Only attempt Immich uploads when the user asked for it *and* the
    # integration is configured; a missing/half-set config silently skips.
    immich = get_immich_config(db) if upload_to_immich else None

    for image in new_images:
        db.refresh(image)
        image_path = settings.library_root / image.file_path
        enqueue_post_import(image.id, image_path)

        # Per the import option: push only the JPEGs to Immich, never the RAWs.
        if immich and image.file_type == FileType.jpeg:
            enqueue_immich_upload(
                immich.base_url,
                immich.api_key,
                image_path,
                image.taken_at,
            )

    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    return new_images


def discard_import_session(db: Session, session: ImportSession) -> None:
    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    session.status = ImportSessionStatus.discarded
    db.commit()
