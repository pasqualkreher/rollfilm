import json
import logging
import os
import queue
import shutil
import tempfile
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    Album,
    AlbumImage,
    ColorLabel,
    FileType,
    Image,
    ImageTag,
    ImportSession,
    ImportStagedFile,
    Tag,
)
from app.services.exif import capture_date_from_filename, new_helper, read_exif
from app.services.filesystem import VIRTUAL_PATH_MARKER, resolve_image_path
from app.services.hashing import sha256_file
from app.services.raw import classify_file_type, raw_dimensions
from app.services.thumbnails import derivative_dir, editor_recently_active, regenerate_for_image
from app.services.trash import hard_delete_images
from app.workers.queue import enqueue_post_import


logger = logging.getLogger(__name__)


class UploadedFile(Protocol):
    filename: str | None
    file: BinaryIO


def start_background_sync() -> None:
    """Run the same reconciliation as Settings' "Sync database to library" once
    on every app start, in the background: by the time the backend launches the
    desktop shell has confirmed (or asked the user to re-select) the library
    folder, so the DB is brought in line with whatever changed on disk while
    the app was closed. Backgrounded because hashing and thumbnail regeneration
    can take a while and /health must come up fast."""

    def _run() -> None:
        # Never reconcile against a missing/unreadable library root - with the
        # folder gone, every managed file "is missing" and the whole catalog
        # would be wiped. The desktop shell prevents this, but a bare backend
        # run (Docker, dev) has no such gate.
        if not settings.library_root.is_dir():
            logger.warning("Startup library sync skipped: library root %s not found", settings.library_root)
            return
        from app.auth import LOCAL_USER_ID
        from app.db.session import SessionLocal

        db = SessionLocal()
        try:
            result = sync_db_with_library(db, LOCAL_USER_ID)
            logger.info("Startup library sync: %s", result)
            # Re-pair pass: link any still-unpaired RAW+JPEG siblings (halves
            # imported in different sessions, or libraries from before the
            # metadata-aware pairing). Idempotent and cheap once caught up.
            from app.services.pairing import pair_library, unpair_conflicting

            # Break the pairs the metadata contradicts FIRST, so a half freed
            # here can find its real partner in the same pass. Not one-shot
            # behind a settings flag like the repairs below: a pair can also go
            # wrong later, when a capture time arrives that wasn't there when
            # the two were linked, and this is what catches that.
            broken = unpair_conflicting(db, LOCAL_USER_ID)
            if broken:
                db.commit()
                logger.info(
                    "Startup un-pair: broke %d RAW+JPEG pair(s) the metadata contradicts", broken
                )
            paired = pair_library(db, LOCAL_USER_ID)
            if paired:
                db.commit()
                logger.info("Startup re-pair: linked %d RAW+JPEG pair(s)", paired)
            # One-shot fix for RAW rows whose width/height were recorded from
            # the embedded preview JPEG's EXIF (see exif.read_exif) - re-read
            # the true sensor-output size from each RAW header. Guarded by a
            # settings flag so the per-file header reads don't repeat forever.
            from app.services.settings_store import get_setting, set_setting

            if get_setting(db, "raw_dimensions_repaired_v1") != "1":
                fixed, skipped = repair_raw_dimensions(db, LOCAL_USER_ID)
                # Unreachable files (unmounted source root) keep the repair
                # pending, so they get their turn on a later start.
                if skipped == 0:
                    set_setting(db, "raw_dimensions_repaired_v1", "1")
                logger.info(
                    "Startup RAW dimension repair: %d corrected, %d unreachable", fixed, skipped
                )
            # One-shot backfill of the lens name for photos imported before the
            # lens was read from EXIF at all - same flag pattern as above so the
            # per-file exiftool reads don't repeat on every start.
            if get_setting(db, "lens_model_backfilled_v1") != "1":
                filled, skipped = backfill_lens_metadata(db, LOCAL_USER_ID)
                if skipped == 0:
                    set_setting(db, "lens_model_backfilled_v1", "1")
                logger.info(
                    "Startup lens backfill: %d filled, %d unreachable", filled, skipped
                )
        except Exception:
            logger.exception("Startup library sync failed")
        finally:
            db.close()

    threading.Thread(target=_run, name="startup-library-sync", daemon=True).start()


def repair_raw_dimensions(db: Session, owner_id: int) -> tuple[int, int]:
    """Correct the stored width/height of every RAW photo from its file header
    (LibRaw active area - what a native render actually outputs). Historic
    imports recorded the embedded preview JPEG's EXIF size instead, which
    undersells the RAW everywhere the dimensions are shown or used. Returns
    (corrected, unreachable) counts; unreachable files (e.g. an unmounted
    source root) are left for a later run."""
    fixed = 0
    skipped = 0
    raws = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.file_type == FileType.raw)
        .all()
    )
    for image in raws:
        path = resolve_image_path(image)
        if not path.exists():
            skipped += 1
            continue
        dims = raw_dimensions(path)
        if dims is None:
            # Unreadable header (corrupt file): counts as done - a retry on
            # the next start would fail the same way.
            continue
        if (image.width, image.height) != dims:
            image.width, image.height = dims
            fixed += 1
    if fixed:
        db.commit()
    return fixed, skipped


def backfill_lens_metadata(db: Session, owner_id: int) -> tuple[int, int]:
    """Read the lens name from EXIF for every photo that doesn't have one yet
    (imported before the lens_model column existed). Returns (filled,
    unreachable); unreachable files (e.g. an unmounted source root) leave the
    backfill pending so they get their turn on a later start. EXIF reads run on
    a small exiftool-helper pool, the same pattern as repair_capture_dates."""
    images = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.lens_model.is_(None))
        .all()
    )
    tasks = [(img, resolve_image_path(img)) for img in images]
    reachable = [(img, path) for img, path in tasks if path.exists()]
    skipped = len(tasks) - len(reachable)
    if not reachable:
        return 0, skipped

    workers = min(8, max(2, (os.cpu_count() or 4)))
    helpers = [new_helper() for _ in range(workers)]
    helper_pool: queue.Queue = queue.Queue()
    for h in helpers:
        helper_pool.put(h)

    def read_lens(task: tuple[Image, Path]) -> tuple[Image, str | None]:
        img, path = task
        helper = helper_pool.get()
        try:
            return img, read_exif(path, helper=helper).lens_model
        except Exception:
            logger.exception("lens-backfill: EXIF read failed for %s", path)
            return img, None
        finally:
            helper_pool.put(helper)

    filled = 0
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for img, lens in executor.map(read_lens, reachable):
                if lens:
                    img.lens_model = lens
                    filled += 1
    finally:
        for h in helpers:
            try:
                h.terminate()
            except Exception:
                pass
    db.commit()
    return filled, skipped


def _follow_renamed_files(
    missing: list[Image], untracked_paths: list[Path]
) -> tuple[list[Image], list[Path]]:
    """Re-attach rows whose file vanished to an untracked file with the same
    bytes - i.e. follow the photos the user renamed or moved in Finder.

    A file's identity is its content, so the match is on the content hash the
    row already stores. Hashing is the expensive part (a RAW is tens of
    megabytes), so only files whose byte count matches some vanished row's are
    ever opened - which on a normal sync, where nothing is missing, is none.

    Returns the rows that were re-pointed (caller commits) and the untracked
    files left over.
    """
    if not missing or not untracked_paths:
        return [], untracked_paths

    wanted_sizes = {image.file_size for image in missing}
    candidates: list[Path] = []
    for path in untracked_paths:
        try:
            if path.stat().st_size in wanted_sizes:
                candidates.append(path)
        except OSError:
            continue
    if not candidates:
        return [], untracked_paths

    # Several rows can share a hash (a photo imported twice), so each hash keeps
    # a queue: the first untracked file claims the first row, and so on.
    by_hash: dict[str, list[Image]] = {}
    for image in missing:
        by_hash.setdefault(image.file_hash, []).append(image)

    relocated: list[Image] = []
    claimed: set[Path] = set()
    for path in candidates:
        try:
            digest = sha256_file(path)
        except OSError:
            logger.exception("Could not hash %s while looking for renamed files", path)
            continue
        group = by_hash.get(digest)
        if not group:
            continue
        image = group.pop(0)
        image.file_path = str(path.relative_to(settings.library_root))
        image.original_filename = path.name
        relocated.append(image)
        claimed.add(path)

    return relocated, [path for path in untracked_paths if path not in claimed]


def sync_db_with_library(db: Session, owner_id: int) -> dict:
    """The filesystem is the source of truth: reconcile the database *and* the
    thumbnail cache with what is actually in the library.

    - A row whose file is gone from its old path, while an untracked file with
      the SAME BYTES sits in the library, is that photo renamed or moved in
      Finder: the row follows the file instead of being deleted. Identity is
      content, not name (same rule as an external source's scan, see
      services/sources._run_scan), so the photo keeps its id and with it every
      rating, tag, album and edit.
    - DB rows whose managed file no longer exists under LIBRARY_ROOT (deleted/
      moved outside the app) and that no such file matches are removed. Done
      FK-safe via hard_delete_images: RAW+JPEG pairs point at each other (and
      staged import files can point at images), so plain row deletes could
      violate those constraints and abort the whole sync half-way, leaving
      ghost entries behind.
    - Cached thumbnail folders that belong to no image anymore are deleted.
    - Photos whose thumbnail/preview is missing get it regenerated in the
      background (only when their original is currently reachable).
    - Files found in the library folder that aren't tracked in the DB are only
      reported, not auto-imported - re-adding them is what the Import flow is
      for.

    Only the managed library folder is treated as source-of-truth for row
    removal. External (source-root) photos are governed by their own scan
    lifecycle and must NOT be pruned just because e.g. the NAS is momentarily
    unmounted - that would wipe the whole index."""
    # Hard refusal, not just a startup-path guard: with the library root gone
    # (external drive asleep/unplugged), every managed file "is missing" and
    # this reconcile would wipe the whole catalog. The Settings button can be
    # clicked at exactly that moment, so the check belongs here.
    if not settings.library_root.is_dir():
        raise RuntimeError(
            f"Library folder not found at {settings.library_root} - reconnect the drive "
            "before syncing the database to the library."
        )
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    # Virtual copies ("canvas edits") own no file: their synthetic path never
    # exists on disk, so the missing-file scan must never see them - their
    # fate is tied to their source's row, not to a path of their own (a
    # source that is hard-deleted below takes its copies with it inside
    # hard_delete_images).
    missing = [
        image
        for image in images
        if image.source_root_id is None
        and image.virtual_of_image_id is None
        and not (settings.library_root / image.file_path).exists()
    ]

    tracked = {
        str((settings.library_root / img.file_path).resolve())
        for img in images
        if img.source_root_id is None and img.virtual_of_image_id is None
    }
    # The database, thumbnails and staging live in a ".photomanager" subfolder
    # of the library; skip it so its JPG thumbnails aren't counted as untracked
    # photos.
    untracked_paths = [
        path
        for path in settings.library_root.rglob("*")
        if path.is_file()
        and ".photomanager" not in path.relative_to(settings.library_root).parts
        and classify_file_type(path) is not None
        and str(path.resolve()) not in tracked
    ]

    relocated, untracked_paths = _follow_renamed_files(missing, untracked_paths)
    if relocated:
        # A moved photo's virtual copies borrow its path: keep their synthetic
        # paths ("<source path>#vc-<id>") pointing at the new location.
        for image in relocated:
            for copy in db.query(Image).filter(Image.virtual_of_image_id == image.id):
                marker = copy.file_path.find(VIRTUAL_PATH_MARKER)
                suffix = copy.file_path[marker:] if marker >= 0 else ""
                copy.file_path = f"{image.file_path}{suffix}"
        db.commit()
        logger.info("Library sync: followed %d renamed/moved file(s)", len(relocated))
    relocated_ids = {image.id for image in relocated}
    missing = [image for image in missing if image.id not in relocated_ids]

    hard_delete_images(db, missing, delete_files=False)
    db.commit()

    kept = db.query(Image).filter(Image.owner_id == owner_id).all()
    untracked = len(untracked_paths)

    # Thumbnail cache holds one folder per image id - drop any that no image
    # row (of any owner; ids are globally unique) points at anymore, e.g. left
    # behind by older deletes that never cleaned up.
    valid_ids = {row[0] for row in db.query(Image.id).all()}
    orphan_thumbnails_removed = 0
    if settings.thumbnail_cache_root.is_dir():
        for entry in settings.thumbnail_cache_root.iterdir():
            if entry.is_dir() and entry.name not in valid_ids:
                shutil.rmtree(entry, ignore_errors=True)
                orphan_thumbnails_removed += 1

    # ...and the reverse direction: queue regeneration for photos whose
    # derivatives are missing, off the request path on the post-import pool.
    thumbnails_queued = 0
    for image in kept:
        cache = derivative_dir(image.id)
        if (cache / "thumbnail.jpg").exists() and (cache / "preview.jpg").exists():
            continue
        original = resolve_image_path(image)
        try:
            reachable = original.exists()
        except OSError:
            reachable = False  # hung/broken network mount
        if reachable:
            enqueue_post_import(image.id, original)
            thumbnails_queued += 1

    return {
        "removed_missing_files": len(missing),
        "renamed_files_followed": len(relocated),
        "untracked_files_found": untracked,
        "orphan_thumbnails_removed": orphan_thumbnails_removed,
        "thumbnails_queued": thumbnails_queued,
    }


# Live progress of the (single, blocking) rebuild-all run, polled by the
# Settings page so the user sees "N of M photos" instead of a blind spinner.
_rebuild_progress_lock = threading.Lock()
_rebuild_progress = {"active": False, "total": 0, "done": 0}

# How long the editor must have been quiet before a rebuild worker picks up
# its next photo. The rebuild is hours of patience; a person mid-drag is not.
# Checked per item, so a slider move pauses the run within one photo's work.
_REBUILD_EDITOR_IDLE_S = 5.0


def get_rebuild_progress() -> dict:
    with _rebuild_progress_lock:
        return dict(_rebuild_progress)


def _set_rebuild_progress(**fields) -> None:
    with _rebuild_progress_lock:
        _rebuild_progress.update(fields)


def rebuild_all_thumbnails(db: Session, owner_id: int) -> dict:
    """Regenerates every cached thumbnail/preview from the original library
    files - e.g. after a rendering fix that only affects newly-generated
    derivatives (existing cached ones need to be rebuilt to pick it up).

    Parallelised on a small thread pool: the heavy work (LibRaw demosaic,
    cv2/numpy passes, JPEG encode) releases the GIL, so a handful of workers
    scales nearly linearly. The pool stays deliberately small - each in-flight
    RAW holds a half-size linear float frame plus pipeline copies (several
    hundred MB at the peak), so more workers would trade speed for memory
    pressure. EXIF reads reuse a pool of exiftool helpers (same pattern as
    repair_capture_dates) instead of spawning one process per photo. A photo
    whose file is damaged is logged and skipped rather than aborting the whole
    run; DB writes and the commit stay on the calling thread."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    tasks = [(img, resolve_image_path(img)) for img in images]
    tasks = [(img, path) for img, path in tasks if path.exists()]

    workers = max(2, min(4, (os.cpu_count() or 4) - 2))
    helpers = [new_helper() for _ in range(workers)]
    helper_pool: queue.Queue = queue.Queue()
    for h in helpers:
        helper_pool.put(h)

    def build(task: tuple[Image, Path]):
        img, path = task
        # Yield to a live editing session (the same pattern as the embedding
        # backfill yielding to imports): every worker holds its next photo
        # back while the editor renders, so scrub frames keep their CPU and
        # the two working sets never share an 8GB machine at the same time.
        while editor_recently_active(_REBUILD_EDITOR_IDLE_S):
            time.sleep(0.5)
        try:
            regenerate_for_image(img)
        except Exception:
            logger.exception("rebuild-thumbnails: regeneration failed for %s", path)
            return img, None, False
        helper = helper_pool.get()
        try:
            # Backfill orientation-correct dimensions for photos imported before
            # width/height accounted for the EXIF orientation tag, so the grid
            # can show each one at its true portrait/landscape shape.
            exif = read_exif(path, helper=helper)
        except Exception:
            exif = None
        finally:
            helper_pool.put(helper)
        return img, exif, True

    rebuilt = 0
    _set_rebuild_progress(active=True, total=len(tasks), done=0)
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(build, t) for t in tasks]
            done = 0
            for future in as_completed(futures):
                img, exif, ok = future.result()
                done += 1
                _set_rebuild_progress(done=done)
                if not ok:
                    continue
                if exif is not None and exif.width and exif.height:
                    img.width = exif.width
                    img.height = exif.height
                rebuilt += 1
    finally:
        _set_rebuild_progress(active=False)
        for h in helpers:
            try:
                h.terminate()
            except Exception:
                pass
    db.commit()
    return {"rebuilt": rebuilt}


def _same_moment(a: datetime | None, b: datetime | None) -> bool:
    if a is None or b is None:
        return a is b
    # Stored values can be naive (EXIF) or aware (old mtime fallback wrote
    # UTC-aware) - strip tzinfo for a tolerant compare; sub-second EXIF noise
    # shouldn't count as a difference either.
    if a.tzinfo is not None:
        a = a.replace(tzinfo=None)
    if b.tzinfo is not None:
        b = b.replace(tzinfo=None)
    return abs((a - b).total_seconds()) < 1


def repair_capture_dates(db: Session, owner_id: int) -> dict:
    """Re-read every photo's EXIF capture date from its original file and fix
    rows where the stored taken_at differs. Heals photos imported before the
    EXIF reader understood CreateDate/XMP fallbacks and non-standard date
    formats (e.g. '2026-06-07 12:04:42' with dashes, as some editing apps
    write) - those got the import moment as their date and sorted to the top
    of the library instead of onto their capture day. Photos whose files carry
    no readable capture date keep their current value.

    EXIF reads run on a small worker pool (one exiftool process each, the same
    pattern as import staging); only the row updates happen serially."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    tasks = [(img, resolve_image_path(img)) for img in images]
    tasks = [(img, path) for img, path in tasks if path.exists()]

    workers = min(8, max(2, (os.cpu_count() or 4)))
    helpers = [new_helper() for _ in range(workers)]
    helper_pool: queue.Queue = queue.Queue()
    for h in helpers:
        helper_pool.put(h)

    def read_date(task: tuple[Image, Path]) -> tuple[Image, datetime | None]:
        img, path = task
        helper = helper_pool.get()
        try:
            taken_at = read_exif(path, helper=helper).taken_at
        except Exception:
            logger.exception("repair-dates: EXIF read failed for %s", path)
            taken_at = None
        finally:
            helper_pool.put(helper)
        # Metadata carries no date at all (WhatsApp strips EXIF): a date
        # embedded in the filename still beats the stored import moment.
        return img, taken_at or capture_date_from_filename(img.original_filename)

    fixed = 0
    with_date = 0
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for img, taken_at in executor.map(read_date, tasks):
                if taken_at is None:
                    continue
                with_date += 1
                if not _same_moment(img.taken_at, taken_at):
                    img.taken_at = taken_at
                    fixed += 1
    finally:
        for h in helpers:
            try:
                h.terminate()
            except Exception:
                pass
    db.commit()
    logger.info(
        "repair-dates: %d photos checked, %d had a readable capture date, %d corrected",
        len(tasks), with_date, fixed,
    )
    return {"checked": len(tasks), "fixed": fixed}


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

    # Bulk query.delete() bypasses ORM cascades, so the tag links (and the tags
    # themselves) must be cleared explicitly or they'd survive as orphans.
    tag_ids = [t.id for t in db.query(Tag).filter(Tag.owner_id == owner_id).all()]
    if tag_ids:
        db.query(ImageTag).filter(ImageTag.tag_id.in_(tag_ids)).delete(synchronize_session=False)
        db.query(Tag).filter(Tag.owner_id == owner_id).delete(synchronize_session=False)

    db.query(Image).filter(Image.owner_id == owner_id).delete(synchronize_session=False)
    db.commit()

    # The library's data folder (".photomanager": database, thumbnails,
    # staging) lives INSIDE the library folder, so the library must not be
    # rmtree'd wholesale - that would unlink the live SQLite file out from
    # under the open connection pool, and everything restored afterwards would
    # silently vanish with the unlinked inode. Clear the library's photo
    # contents but keep the data folder; thumbnails and staging are then
    # cleared explicitly via their own configured roots.
    if settings.library_root.is_dir():
        for child in settings.library_root.iterdir():
            if child.name == ".photomanager":
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink(missing_ok=True)
                except OSError:
                    pass
    settings.library_root.mkdir(parents=True, exist_ok=True)

    for root in (
        settings.thumbnail_cache_root,
        settings.import_staging_root,
        settings.staged_thumbs_root,
    ):
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)


def image_to_dict(image: Image, tags: list[str]) -> dict:
    # The legacy v1 edit_* slider columns are intentionally not exported: the
    # render pipeline no longer reads them, so the manifest carries only the
    # state that actually shapes pixels (geometry + edit_adjustments).
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
        "deleted_at": image.deleted_at.isoformat() if image.deleted_at else None,
        "camera_make": image.camera_make,
        "camera_model": image.camera_model,
        "lens_model": image.lens_model,
        "iso": image.iso,
        "aperture": image.aperture,
        "shutter_speed": image.shutter_speed,
        "focal_length": image.focal_length,
        "gps_lat": image.gps_lat,
        "gps_lon": image.gps_lon,
        "gps_country": image.gps_country,
        "rating": image.rating,
        "color_label": image.color_label.value,
        "description": image.description,
        "paired_image_id": image.paired_image_id,
        "edit_rotation": image.edit_rotation,
        "edit_crop_x": image.edit_crop_x,
        "edit_crop_y": image.edit_crop_y,
        "edit_crop_width": image.edit_crop_width,
        "edit_crop_height": image.edit_crop_height,
        "edit_flip_h": image.edit_flip_h,
        "edit_flip_v": image.edit_flip_v,
        "edit_straighten": image.edit_straighten,
        "edit_persp_h": image.edit_persp_h,
        "edit_persp_v": image.edit_persp_v,
        "edit_distortion": image.edit_distortion,
        "edit_adjustments": image.edit_adjustments,
        "edit_rev": image.edit_rev,
        "applied_adjustments": image.applied_adjustments,
        "immich_sync": image.immich_sync,
        "immich_asset_id": image.immich_asset_id,
        "virtual_of_image_id": image.virtual_of_image_id,
        "tags": tags,
    }


def image_row_from_dict(data: dict, owner_id: int, *, keep_id: bool = True) -> Image:
    """Rebuild an Image row from an image_to_dict() record.

    Shared by the backup restore, which puts a library back exactly as it was
    and therefore keeps the original ids, and by the library merge, which folds
    a second library into a populated one and needs fresh ids so a photo
    merged twice can't collide with itself (services/library_merge.py).

    .get() throughout: manifests written by older versions simply lack the keys
    added since, and a restore of one of those must still work."""
    fields = dict(
        owner_id=owner_id,
        file_path=data["file_path"],
        original_filename=data["original_filename"],
        file_hash=data["file_hash"],
        perceptual_hash=data["perceptual_hash"],
        file_type=FileType(data["file_type"]),
        raw_format=data["raw_format"],
        width=data["width"],
        height=data["height"],
        file_size=data["file_size"],
        taken_at=datetime.fromisoformat(data["taken_at"]) if data["taken_at"] else None,
        imported_at=datetime.fromisoformat(data["imported_at"]),
        deleted_at=(
            datetime.fromisoformat(data["deleted_at"]) if data.get("deleted_at") else None
        ),
        camera_make=data["camera_make"],
        camera_model=data["camera_model"],
        lens_model=data.get("lens_model"),
        iso=data["iso"],
        aperture=data["aperture"],
        shutter_speed=data["shutter_speed"],
        focal_length=data["focal_length"],
        gps_lat=data["gps_lat"],
        gps_lon=data["gps_lon"],
        gps_country=data.get("gps_country"),
        rating=data["rating"],
        color_label=ColorLabel(data["color_label"]),
        description=data.get("description"),
        edit_rotation=data["edit_rotation"],
        edit_crop_x=data["edit_crop_x"],
        edit_crop_y=data["edit_crop_y"],
        edit_crop_width=data["edit_crop_width"],
        edit_crop_height=data["edit_crop_height"],
        edit_flip_h=data.get("edit_flip_h", False),
        edit_flip_v=data.get("edit_flip_v", False),
        edit_straighten=data.get("edit_straighten", 0.0),
        edit_persp_h=data.get("edit_persp_h", 0),
        edit_persp_v=data.get("edit_persp_v", 0),
        edit_distortion=data.get("edit_distortion", 0),
        edit_adjustments=data.get("edit_adjustments"),
        edit_rev=data.get("edit_rev", 0),
        applied_adjustments=data.get("applied_adjustments"),
        immich_sync=data.get("immich_sync", False),
        immich_asset_id=data.get("immich_asset_id"),
        virtual_of_image_id=data.get("virtual_of_image_id"),
    )
    if keep_id:
        fields["id"] = data["id"]
    return Image(**fields)


def build_backup_zip(db: Session, owner_id: int) -> Path:
    """A portable backup: the actual library files plus a JSON manifest of
    all metadata (ratings, albums, edits, ...). Deliberately not a raw copy
    of the sqlite file - swapping that out from under a live connection pool
    on restore would be fragile; restoring by re-inserting rows is safer."""
    # Backups cover the managed library only. External source-root photos live
    # on their own storage (a NAS etc.) and can be re-indexed by re-adding the
    # source, so their originals aren't bundled into the backup zip.
    images = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.source_root_id.is_(None))
        .all()
    )
    albums = db.query(Album).filter(Album.owner_id == owner_id).all()
    # Exclude album memberships that point at external photos (which aren't in
    # the backup) so a restore never tries to re-link a missing image.
    album_images = (
        db.query(AlbumImage)
        .join(Album)
        .join(Image, Image.id == AlbumImage.image_id)
        .filter(Album.owner_id == owner_id, Image.source_root_id.is_(None))
        .all()
    )
    # One query for all tag links instead of lazy-loading per image.
    tags_by_image: dict[str, list[str]] = {}
    tag_rows = (
        db.query(ImageTag.image_id, Tag.name)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .join(Image, Image.id == ImageTag.image_id)
        .filter(Image.owner_id == owner_id, Image.source_root_id.is_(None))
        .all()
    )
    for image_id, tag_name in tag_rows:
        tags_by_image.setdefault(image_id, []).append(tag_name)

    manifest = {
        "version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "images": [image_to_dict(i, sorted(tags_by_image.get(i.id, []))) for i in images],
        "albums": [
            {
                "id": a.id,
                "name": a.name,
                "description": a.description,
                "created_at": a.created_at.isoformat(),
                "immich_sync": a.immich_sync,
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
            db.add(image_row_from_dict(image_data, owner_id))
        db.flush()

        tag_by_name: dict[str, Tag] = {}
        for image_data in manifest["images"]:
            for tag_name in image_data.get("tags", []):
                tag = tag_by_name.get(tag_name)
                if tag is None:
                    tag = Tag(owner_id=owner_id, name=tag_name)
                    db.add(tag)
                    db.flush()  # assigns the UUID id the link below needs
                    tag_by_name[tag_name] = tag
                db.add(ImageTag(image_id=image_data["id"], tag_id=tag.id))
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
                    immich_sync=album_data.get("immich_sync", False),
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
