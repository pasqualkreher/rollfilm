import enum
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
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session
from sqlalchemy.sql.sqltypes import DateTime as SADateTime
from sqlalchemy.sql.sqltypes import Enum as SAEnum

from app.config import settings
from app.db.models import (
    Album,
    AlbumImage,
    AppSetting,
    Canvas,
    CanvasImage,
    CanvasLayout,
    ColorLabel,
    DevelopPreset,
    EditSnapshot,
    FileType,
    Image,
    ImageTag,
    ImportSession,
    ImportSessionSource,
    ImportSessionStatus,
    ImportStagedFile,
    LayoutItem,
    LayoutVersion,
    SourceRoot,
    Tag,
)
from app.services.exif import capture_date_from_filename, new_helper, read_exif
from app.services.filesystem import VIRTUAL_PATH_MARKER, resolve_image_path
from app.services.hashing import sha256_file
from app.services.membership_tags import sync_membership_tags
from app.services.raw import classify_file_type, raw_dimensions
from app.services.settings_store import IMMICH_API_KEY, set_setting
from app.services import lens_profile
from app.services.thumbnails import (
    adjustments_from_image,
    editor_recently_active,
    regenerate_for_image,
)
from app.services.trash import catalog_cleanup_lock, hard_delete_images
from app.workers.queue import enqueue_post_import


logger = logging.getLogger(__name__)


class UploadedFile(Protocol):
    filename: str | None
    file: BinaryIO


def start_background_housekeeping() -> None:
    """The catalog's own upkeep once per app start, in the background: the
    thumbnails the last run still owed, the RAW+JPEG pairing, the one-shot
    repairs behind their settings flags. All of it works from the database
    and touches a photo file only where a repair needs one.

    Deliberately NOT the library sync (Settings' "Sync database to library"):
    reading the folder on every start was a visible wait on an external
    drive, and nothing it finds - a file moved or deleted in Finder - needs
    finding before the user asks for it. The sync is a button."""

    def _run() -> None:
        from app.auth import LOCAL_USER_ID
        from app.db.session import SessionLocal

        db = SessionLocal()
        try:
            # What the last run still owed a thumbnail (workers.queue's journal).
            from app.workers.queue import resume_derivative_journal

            resumed = resume_derivative_journal()
            if resumed:
                logger.info("Startup: %d unfinished thumbnail(s) queued again", resumed)
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
                    db.commit()  # set_setting only stages the row
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
                    db.commit()  # set_setting only stages the row
                logger.info(
                    "Startup lens backfill: %d filled, %d unreachable", filled, skipped
                )
            # One-shot re-render for the automatic lens profile correction: the
            # thumbnails of RAWs imported before it were rendered uncorrected.
            # Last on purpose - it's the long one.
            if get_setting(db, "lens_profile_derivatives_v1") != "1":
                rendered, skipped = regenerate_lens_profile_derivatives(db, LOCAL_USER_ID)
                if skipped == 0:
                    set_setting(db, "lens_profile_derivatives_v1", "1")
                    db.commit()  # set_setting only stages the row
                logger.info(
                    "Startup lens profile re-render: %d re-rendered, %d unreachable", rendered, skipped
                )
            # And again for the RAWs the correction reached later: every
            # other maker's camera data and the Lensfun fallback. RAFs were
            # covered by the first pass.
            if get_setting(db, "lens_profile_derivatives_v2") != "1":
                rendered, skipped = regenerate_lens_profile_derivatives(
                    db, LOCAL_USER_ID, skip_suffixes=(".raf",)
                )
                if skipped == 0:
                    set_setting(db, "lens_profile_derivatives_v2", "1")
                    db.commit()
                logger.info(
                    "Startup lens profile re-render (all makers): %d re-rendered, %d unreachable",
                    rendered, skipped,
                )
        except Exception:
            logger.exception("Startup housekeeping failed")
        finally:
            db.close()

    threading.Thread(target=_run, name="startup-housekeeping", daemon=True).start()


def regenerate_lens_profile_derivatives(
    db: Session, owner_id: int, skip_suffixes: tuple[str, ...] = ()
) -> tuple[int, int]:
    """Re-render the thumbnail/preview of every RAW photo whose file carries an
    embedded lens profile (services/lens_profile.py) and that has the correction
    on - derivatives rendered before the correction existed show the lens
    uncorrected. One photo at a time, yielding to a live editing session like
    rebuild_all_thumbnails. Returns (re-rendered, unreachable); a photo whose
    render fails is logged and counts as done."""
    rendered = 0
    skipped = 0
    raws = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.file_type == FileType.raw)
        .all()
    )
    for image in raws:
        path = resolve_image_path(image)
        if path.suffix.lower() in skip_suffixes:
            continue
        if not path.exists():
            skipped += 1
            continue
        if not lens_profile.is_active(path, adjustments_from_image(image)):
            continue
        while editor_recently_active(_REBUILD_EDITOR_IDLE_S):
            time.sleep(0.5)
        try:
            regenerate_for_image(image)
            rendered += 1
        except Exception:
            logger.exception("lens profile re-render failed for %s", path)
    return rendered, skipped


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


# A thumbnail folder no row points at is removed by the sync - unless it is
# this young: a photo whose derivatives are written before its row commits
# (the library merge, a copy being saved) has a folder before it has an id.
ORPHAN_THUMBNAIL_GRACE_S = 15 * 60


def sync_db_with_library(
    db: Session, owner_id: int, check_derivatives: bool = True, timing: dict | None = None
) -> dict:
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
      background (only when their original is currently reachable). Only
      with `check_derivatives`: it is one directory listing per photo in the
      cache folder, which only Settings' sync pays; the queue's journal
      (workers.queue.resume_derivative_journal) covers unfinished thumbnails
      at startup.

    `timing`, when given, receives the seconds each phase took - what the
    sync route logs, so a slow sync says where it was slow.
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
    if not _sync_active.acquire(blocking=False):
        raise AlreadyRunning("The library is already being synced.")
    _sync_cancel.clear()
    try:
        # Not beside a trash purge: see trash.catalog_cleanup_lock.
        with catalog_cleanup_lock:
            return _sync_db_with_library(db, owner_id, check_derivatives, timing)
    finally:
        _sync_active.release()


def _sync_db_with_library(
    db: Session, owner_id: int, check_derivatives: bool = True, timing: dict | None = None
) -> dict:
    # Nothing in here asks the library volume about one file at a time. The
    # sync used to stat every row's file, resolve every path (an lstat per
    # path component) and is_file() every walked file - some 95,000 lookups
    # for 12,500 photos. Warm they are microseconds; on an exFAT USB drive
    # whose cache a machine in swap keeps dropping, each is about a
    # millisecond, and the start took a minute and a half. Now the folder is
    # read once, directory by directory, and both directions - rows without a
    # file, files without a row - come out of that one listing.
    laps = timing if timing is not None else {}
    t_last = time.monotonic()

    def lap(key: str) -> None:
        nonlocal t_last
        now = time.monotonic()
        laps[key] = round(now - t_last, 2)
        t_last = now

    # The columns the reconcile needs, not the rows: a photo row carries its
    # edits and camera data too (2 KB each), and 12,500 ORM objects built
    # twice over were a noticeable share of the start on 8 GB.
    rows = db.query(
        Image.id, Image.owner_id, Image.file_path, Image.source_root_id,
        Image.virtual_of_image_id, Image.missing_since,
    ).all()
    lap("query")
    mine = [r for r in rows if r.owner_id == owner_id]
    # Virtual copies own no file: their synthetic path never exists on disk,
    # so the missing-file scan must never see them - their fate is tied to
    # their source's row, not to a path of their own (a source that is
    # hard-deleted later takes its copies with it inside hard_delete_images).
    # Photos from an external source root are governed by their own scan.
    root = settings.library_root.resolve()
    root_s = str(root)
    tracked: dict[str, str] = {}
    for r in mine:
        if r.source_root_id is None and r.virtual_of_image_id is None:
            tracked[os.path.normpath(os.path.join(root_s, r.file_path))] = r.id
    tracked_fold = {path.lower() for path in tracked}

    # The database, thumbnails and staging live in a ".photomanager" subfolder
    # of the library; skip it so its JPG thumbnails aren't counted as untracked
    # photos. "Import" holds the collection folders of open import sessions
    # (cards copied in, not yet reviewed) - not library photos either. Both
    # are left out of the walk, not filtered after it: walking the thumbnail
    # cache (tens of thousands of files) only to drop each one took 87 s of a
    # 2 s walk on a USB drive, on every start. The walk's own listing says
    # what is a file (no stat), and the type is read off the name.
    found: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root_s):
        # Stopped while still reading the folder: nothing has been changed.
        if _sync_cancel.is_set():
            return _sync_result(cancelled=True)
        if dirpath == root_s:
            dirnames[:] = [d for d in dirnames if d not in (".photomanager", "Import")]
        else:
            dirnames[:] = [d for d in dirnames if d != ".photomanager"]
        for name in filenames:
            if classify_file_type(Path(name)) is not None:
                found.add(os.path.normpath(os.path.join(dirpath, name)))
    # The library volume is case-insensitive as a rule (exFAT, APFS): a row
    # whose path differs from the file's name in case alone is not missing.
    found_fold = {path.lower() for path in found}
    missing_ids = [
        image_id for path, image_id in tracked.items()
        if path not in found and path.lower() not in found_fold
    ]
    untracked_paths = [
        Path(path) for path in sorted(found)
        if path not in tracked and path.lower() not in tracked_fold
    ]
    lap("walk")

    missing = _rows_by_id(db, missing_ids)
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
    lap("follow")

    # The last moment to stop before anything is marked. Renamed files were
    # followed above (their rows only gained a new path); nothing is deleted.
    if _sync_cancel.is_set():
        return _sync_result(cancelled=True, renamed_files_followed=len(relocated))

    # A file that is back - the drive mounted again, the folder put back - is
    # simply back: the row never left, so nothing has to be restored.
    now = datetime.now(timezone.utc)
    still_missing = {image.id for image in missing}
    marked_before = [r.id for r in mine if r.missing_since is not None]
    recover_ids = [image_id for image_id in marked_before if image_id not in still_missing]
    recovered = 0
    for image in _rows_by_id(db, recover_ids):
        image.missing_since = None
        recovered += 1
    for image in relocated:
        image.missing_since = None

    # Files not found are MARKED, never removed: the row keeps the photo's
    # stars, tags, albums and edits, the grid badges it, and Settings offers
    # to remove the entries once the user has decided the files are gone for
    # good. Too many at once is the one case where nothing is marked either:
    # a library that lost a twentieth of itself since the last look has not
    # lost it - its drive is asleep, its folder moved, its permissions wrong -
    # and marking a thousand photos would only be noise over the real cause.
    newly_missing = [image for image in missing if image.missing_since is None]
    managed_count = len(tracked)
    limit = max(MISSING_ABORT_MIN, int(managed_count * MISSING_ABORT_FRAC))
    if len(newly_missing) > limit:
        db.commit()
        _last_sync_abort["missing"] = len(newly_missing)
        _last_sync_abort["at"] = now.isoformat()
        logger.warning(
            "Library sync: %d of %d managed files not found - more than the %d the sync will mark on "
            "its own; nothing marked. Is the library drive mounted?",
            len(newly_missing), managed_count, limit,
        )
        return _sync_result(
            too_many_missing=len(newly_missing),
            renamed_files_followed=len(relocated),
            recovered_files=recovered,
            untracked_files_found=len(untracked_paths),
            missing_total=len(marked_before),
        )
    _last_sync_abort["missing"] = 0
    for image in newly_missing:
        image.missing_since = now
    db.commit()
    lap("mark")

    untracked = len(untracked_paths)

    # The thumbnail cache holds one folder per image id; one listing of it
    # serves both directions. Folders no image row (of any owner; ids are
    # globally unique) points at anymore - left behind by older deletes that
    # never cleaned up - are removed. And for every photo that is kept (only
    # with `check_derivatives`), its folder's listing says whether thumbnail
    # and preview are there: ONE readdir per photo, no stat, no mkdir. This
    # phase used to load every photo's full ORM row, create its cache folder
    # (a mkdir + stat per photo, and an empty folder for each photo that had
    # no derivatives) and stat two files in it - some 50,000 lookups for
    # 12,500 photos, 130 s on a cold USB drive. The listing's own entry type
    # (d_type) says what is a folder, so the orphan check costs no stat either.
    # The ids are read again here, not taken from the rows the reconcile
    # started with: an import, a merge or a saved copy that landed while the
    # folder walk ran (minutes on a cold USB drive) has its folder already and
    # must keep it. A folder younger than the grace is spared as well - a
    # merge writes the derivatives before it commits the row, and a folder
    # that is being written to is young by its mtime.
    valid_ids = {row_id for (row_id,) in db.query(Image.id).all()}
    sweep_grace_before = time.time() - ORPHAN_THUMBNAIL_GRACE_S
    newly_missing_ids = {image.id for image in newly_missing}
    recovered_ids = set(recover_ids)
    kept_ids = {
        r.id for r in mine
        if (r.missing_since is None or r.id in recovered_ids or r.id in relocated_ids)
        and r.id not in newly_missing_ids
    }
    have_derivatives: set[str] = set()
    orphan_thumbnails_removed = 0
    if settings.thumbnail_cache_root.is_dir():
        with os.scandir(settings.thumbnail_cache_root) as entries:
            for entry in entries:
                try:
                    if not entry.is_dir():
                        continue
                except OSError:
                    continue
                if entry.name not in valid_ids:
                    try:
                        if entry.stat().st_mtime > sweep_grace_before:
                            continue
                    except OSError:
                        continue
                    shutil.rmtree(entry.path, ignore_errors=True)
                    orphan_thumbnails_removed += 1
                    continue
                if check_derivatives and entry.name in kept_ids:
                    try:
                        names = os.listdir(entry.path)
                    except OSError:
                        continue
                    if "thumbnail.jpg" in names and "preview.jpg" in names:
                        have_derivatives.add(entry.name)
    lap("orphans")

    # ...and queue regeneration for the photos whose derivatives are missing
    # (no folder, or a folder without both files), off the request path on the
    # post-import pool - only while their original is reachable. Only these few
    # rows are loaded in full; the folder is created by the render, not here.
    thumbnails_queued = 0
    if check_derivatives:
        need_ids = sorted(kept_ids - have_derivatives)
        for image in _rows_by_id(db, need_ids):
            original = resolve_image_path(image)
            try:
                reachable = original.exists()
            except OSError:
                reachable = False  # hung/broken network mount
            if reachable:
                enqueue_post_import(image.id, original)
                thumbnails_queued += 1
        lap("derivatives")

    return _sync_result(
        missing_files=len(newly_missing),
        missing_total=len(missing),
        recovered_files=recovered,
        renamed_files_followed=len(relocated),
        untracked_files_found=untracked,
        orphan_thumbnails_removed=orphan_thumbnails_removed,
        thumbnails_queued=thumbnails_queued,
    )


def _rows_by_id(db: Session, image_ids: list[str]) -> list[Image]:
    """The photo rows for these ids, in chunks SQLite's variable limit allows."""
    out: list[Image] = []
    for i in range(0, len(image_ids), 500):
        chunk = image_ids[i:i + 500]
        out.extend(db.query(Image).filter(Image.id.in_(chunk)).all())
    return out


def _sync_result(**fields) -> dict:
    result = {
        # Kept at 0 for older clients: a sync removes nothing any more.
        "removed_missing_files": 0,
        "missing_files": 0,
        "missing_total": 0,
        "recovered_files": 0,
        "too_many_missing": 0,
        "renamed_files_followed": 0,
        "untracked_files_found": 0,
        "orphan_thumbnails_removed": 0,
        "thumbnails_queued": 0,
        "cancelled": False,
    }
    result.update(fields)
    return result


# More files vanished at once than the sync will mark by itself: above the
# larger of these two it stops and reports instead (see _sync_db_with_library).
MISSING_ABORT_MIN = 20
MISSING_ABORT_FRAC = 0.05
# What the last sync that stopped this way found, for the title bar's hint
# (routes/maintenance.missing_files). Reset by the next sync that goes through.
_last_sync_abort: dict = {"missing": 0, "at": None}


def missing_files_status(db: Session, owner_id: int) -> dict:
    count = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.missing_since.isnot(None), Image.deleted_at.is_(None))
        .count()
    )
    return {
        "count": count,
        "sync_aborted_missing": int(_last_sync_abort["missing"]),
        "sync_aborted_at": _last_sync_abort["at"],
    }


def remove_missing_images(db: Session, owner_id: int) -> int:
    """Remove the rows the sync has marked as missing - the user's call, once
    the files are known to be gone for good. The files are not on disk, so
    nothing is unlinked; Immich is not told either (hard_delete_images with
    delete_files=False), the same as the old sync's removal."""
    rows = (
        db.query(Image)
        .filter(Image.owner_id == owner_id, Image.missing_since.isnot(None))
        .all()
    )
    if rows:
        hard_delete_images(db, rows, delete_files=False)
        db.commit()
    return len(rows)


class AlreadyRunning(RuntimeError):
    """The same maintenance run was started while one is still going."""


# ---- Stopping a run ---------------------------------------------------------
# Each long maintenance run looks at its own flag between two photos (the
# same pattern as library_merge.request_merge_cancel): the cancel routes set
# it, the run clears it when it starts. A sync stops before it removes
# anything; a rebuild and a date repair keep what they have done. A restore
# cannot be stopped - it empties the library before it writes the backup back,
# so a stop half-way would leave nothing.
_sync_cancel = threading.Event()
_sync_active = threading.Lock()
_rebuild_cancel = threading.Event()
_repair_cancel = threading.Event()


def request_sync_cancel() -> None:
    _sync_cancel.set()


def request_rebuild_cancel() -> None:
    _rebuild_cancel.set()


def request_repair_cancel() -> None:
    _repair_cancel.set()


def sync_active() -> bool:
    if _sync_active.acquire(blocking=False):
        _sync_active.release()
        return False
    return True


# Live progress of the (single, blocking) rebuild-all run, polled by the
# Settings page so the user sees "N of M photos" instead of a blind spinner.
_rebuild_progress_lock = threading.Lock()
_rebuild_progress = {"active": False, "total": 0, "done": 0}

# The same for the capture-date repair.
_repair_progress_lock = threading.Lock()
_repair_progress = {"active": False, "total": 0, "done": 0}


def get_repair_progress() -> dict:
    with _repair_progress_lock:
        return dict(_repair_progress)


def _set_repair_progress(**fields) -> None:
    with _repair_progress_lock:
        _repair_progress.update(fields)

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
    run; DB writes and the commit stay on the calling thread.

    Stopped (request_rebuild_cancel) between two photos: the workers finish
    the photo they are on, the rest keep their old thumbnails."""
    if get_rebuild_progress()["active"]:
        raise AlreadyRunning("The thumbnails are already being rebuilt.")
    _rebuild_cancel.clear()
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
        # Stopped: a photo not started is left as it is.
        if _rebuild_cancel.is_set():
            return img, None, False
        # Yield to a live editing session (the same pattern as the embedding
        # backfill yielding to imports): every worker holds its next photo
        # back while the editor renders, so scrub frames keep their CPU and
        # the two working sets never share an 8GB machine at the same time.
        while editor_recently_active(_REBUILD_EDITOR_IDLE_S) and not _rebuild_cancel.is_set():
            time.sleep(0.5)
        if _rebuild_cancel.is_set():
            return img, None, False
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
    cancelled = False
    _set_rebuild_progress(active=True, total=len(tasks), done=0)
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(build, t) for t in tasks]
            done = 0
            for future in as_completed(futures):
                if _rebuild_cancel.is_set():
                    # The photos in the workers' hands finish (the pool waits
                    # for them on the way out); the queued ones never start.
                    cancelled = True
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
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
    return {"rebuilt": rebuilt, "cancelled": cancelled}


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
    pattern as import staging); only the row updates happen serially.

    Stopped (request_repair_cancel): the dates corrected so far are kept."""
    if get_repair_progress()["active"]:
        raise AlreadyRunning("The capture dates are already being repaired.")
    _repair_cancel.clear()
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
        # Stopped: the rest of the queue flies through without reading.
        if _repair_cancel.is_set():
            return img, None
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
    checked = 0
    cancelled = False
    _set_repair_progress(active=True, total=len(tasks), done=0)
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for img, taken_at in executor.map(read_date, tasks):
                if _repair_cancel.is_set():
                    cancelled = True
                    break
                checked += 1
                _set_repair_progress(done=checked)
                if taken_at is None:
                    continue
                with_date += 1
                if not _same_moment(img.taken_at, taken_at):
                    img.taken_at = taken_at
                    fixed += 1
    finally:
        _set_repair_progress(active=False)
        for h in helpers:
            try:
                h.terminate()
            except Exception:
                pass
    db.commit()
    logger.info(
        "repair-dates: %d photos checked, %d had a readable capture date, %d corrected%s",
        checked, with_date, fixed, " (stopped early)" if cancelled else "",
    )
    return {"checked": checked, "fixed": fixed, "cancelled": cancelled}


def _wipe_catalog_rows(db: Session, owner_id: int) -> None:
    """Delete everything the catalog holds for this user, in an order the
    foreign keys allow, without committing: wipe_library() commits it on its
    own, the restore runs it inside the one transaction that also writes the
    backup's rows back, so a restore that fails half-way rolls back to the
    library as it was. Settings stay - the Immich key, the trash retention,
    the editor preferences are the machine's, not the library's."""
    session_ids = [s.id for s in db.query(ImportSession).filter(ImportSession.owner_id == owner_id).all()]
    if session_ids:
        db.query(ImportStagedFile).filter(
            ImportStagedFile.import_session_id.in_(session_ids)
        ).delete(synchronize_session=False)
        # The folders those sessions copied from - staged rows point at them,
        # so they go after the files and before the sessions.
        db.query(ImportSessionSource).filter(
            ImportSessionSource.import_session_id.in_(session_ids)
        ).delete(synchronize_session=False)
        # The photos point at their rolls; they go below, so unlink them first.
        db.query(Image).filter(Image.owner_id == owner_id).update(
            {Image.import_session_id: None}, synchronize_session=False
        )
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

    # Canvases: frames and versions hang off a layout, a layout and the
    # membership off a canvas; frames and memberships also point at images,
    # so all of it goes before the images do.
    canvas_ids = [c.id for c in db.query(Canvas).filter(Canvas.owner_id == owner_id).all()]
    if canvas_ids:
        layout_ids = [
            l.id for l in db.query(CanvasLayout).filter(CanvasLayout.canvas_id.in_(canvas_ids)).all()
        ]
        if layout_ids:
            db.query(LayoutItem).filter(LayoutItem.layout_id.in_(layout_ids)).delete(synchronize_session=False)
            db.query(LayoutVersion).filter(LayoutVersion.layout_id.in_(layout_ids)).delete(
                synchronize_session=False
            )
            db.query(CanvasLayout).filter(CanvasLayout.id.in_(layout_ids)).delete(synchronize_session=False)
        db.query(CanvasImage).filter(CanvasImage.canvas_id.in_(canvas_ids)).delete(synchronize_session=False)
        db.query(Canvas).filter(Canvas.owner_id == owner_id).delete(synchronize_session=False)

    # A photo's named snapshots go with it (bulk deletes skip the ORM cascade),
    # and the presets are the library's too: a restore brings its own back.
    image_ids = [row[0] for row in db.query(Image.id).filter(Image.owner_id == owner_id).all()]
    for start in range(0, len(image_ids), 500):
        db.query(EditSnapshot).filter(EditSnapshot.image_id.in_(image_ids[start : start + 500])).delete(
            synchronize_session=False
        )
    db.query(DevelopPreset).filter(DevelopPreset.owner_id == owner_id).delete(synchronize_session=False)
    db.query(Image).filter(Image.owner_id == owner_id).delete(synchronize_session=False)
    # The folders indexed in place go with their photos: a wiped library has no
    # photos to list under them, and a restore brings its own roots back.
    db.query(SourceRoot).filter(SourceRoot.owner_id == owner_id).delete(synchronize_session=False)


def _is_data_dir(child: Path) -> bool:
    """Whether a child of the library folder is the app's own data folder:
    ".photomanager" in the desktop app, or wherever pm_data_dir points when it
    was put inside the library by hand."""
    if child.name == ".photomanager":
        return True
    try:
        return child.resolve() == settings.pm_data_dir.resolve()
    except OSError:
        return False


def _clear_derived_folders() -> None:
    """Thumbnails and import staging: all of it is rebuilt from the originals
    (the post-import jobs a wipe or restore queues), so it goes wholesale."""
    for root in (
        settings.thumbnail_cache_root,
        settings.import_staging_root,
        settings.staged_thumbs_root,
    ):
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)


def wipe_library(db: Session, owner_id: int) -> None:
    _wipe_catalog_rows(db, owner_id)
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
            if _is_data_dir(child):
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink(missing_ok=True)
                except OSError:
                    pass
    settings.library_root.mkdir(parents=True, exist_ok=True)
    _clear_derived_folders()


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
        "import_session_id": image.import_session_id,
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
        # Set for a photo indexed in place from a source root: its file_path is
        # then the absolute path on that storage and the backup carries no file.
        "source_root_id": image.source_root_id,
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
        import_session_id=data.get("import_session_id"),
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
        # Set on the row by the caller once every photo is in (the restore's
        # link pass); a merge, with its fresh ids, pairs anew.
        paired_image_id=data.get("paired_image_id"),
        source_root_id=data.get("source_root_id"),
    )
    if keep_id:
        fields["id"] = data["id"]
    return Image(**fields)


# --- Backup and restore -------------------------------------------------------
# A backup is a zip: the managed originals under "library/<file_path>" and one
# manifest.json with everything the catalog knows. Not a copy of the SQLite
# file - swapping that out from under a live connection pool on restore would
# be fragile; re-inserting rows is safer, and a JSON manifest stays readable by
# whatever comes after this version of the app.

# Bumped whenever the manifest gains a section. A restore reads every version
# up to this one (a section an older backup lacks is simply skipped) and
# refuses anything newer, which it could only half understand.
BACKUP_MANIFEST_VERSION = 4
# Settings that never leave the machine in a backup: the manifest is plain
# text in a zip the user may hand around or put on a shared drive, and the
# Immich key in it would open the Immich server to whoever holds the file.
BACKUP_SECRET_SETTINGS = (IMMICH_API_KEY,)


class RestoreError(RuntimeError):
    """The backup could not be restored. Raised before anything of the live
    library was touched, and the message says so - it is written for the user."""


def _row_to_dict(row) -> dict:
    """Every mapped column of a row as JSON-ready values: datetimes as ISO
    strings, enums as their value. The generic shape the canvas tables, the
    albums and the source roots travel in - a column added later is in the
    next backup without anyone remembering this file."""
    out = {}
    for attr in sa_inspect(type(row)).column_attrs:
        value = getattr(row, attr.key)
        if isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, enum.Enum):
            value = value.value
        out[attr.key] = value
    return out


def _row_from_dict(model, data: dict, **overrides):
    """The reverse of _row_to_dict. Keys the manifest lacks are left to the
    column defaults and keys the model no longer has are dropped, so a backup
    from an older version still restores; `overrides` pin what a restore must
    decide itself (the owner)."""
    fields = {}
    for attr in sa_inspect(model).column_attrs:
        if attr.key not in data:
            continue
        value = data[attr.key]
        column_type = attr.columns[0].type
        if value is not None:
            if isinstance(column_type, SADateTime):
                value = datetime.fromisoformat(value)
            elif isinstance(column_type, SAEnum) and column_type.enum_class is not None:
                value = column_type.enum_class(value)
        fields[attr.key] = value
    fields.update(overrides)
    return model(**fields)


def _has_backup_file(image: Image) -> bool:
    """Whether a photo's bytes belong in the zip: a managed original does, a
    photo indexed in place (its file lives on the NAS, re-indexed by adding
    the source root again) and a virtual copy (it owns no file) do not."""
    return image.source_root_id is None and VIRTUAL_PATH_MARKER not in image.file_path


def _safe_library_path(file_path) -> str | None:
    """A manifest path a restore may write under the library folder: a plain
    relative path with no '..', no empty part and no other separator. Anything
    else is refused - a manifest is data from a file somebody else may have
    written, and "../../.ssh/authorized_keys" in it must not become a write
    outside the library. Returns the path as given, or None."""
    if not isinstance(file_path, str) or not file_path or "\0" in file_path or "\\" in file_path:
        return None
    pure = PurePosixPath(file_path)
    if pure.is_absolute() or file_path.startswith("/"):
        return None
    parts = pure.parts
    if not parts or any(part in ("..", ".", "") for part in parts):
        return None
    try:
        root = settings.library_root.resolve()
        if not (root / file_path).resolve().is_relative_to(root):
            return None
    except OSError:
        return None
    return file_path


def build_backup_zip(db: Session, owner_id: int) -> Path:
    """Write the backup zip into a temporary file and return its path (the
    route streams it out and deletes it). Photos are stored, not deflated:
    JPEGs and RAWs are already compressed and deflating them only burns CPU
    for nothing; the manifest, plain JSON, is deflated. Files are streamed in
    one by one, nothing of a photo is held in memory."""
    images = db.query(Image).filter(Image.owner_id == owner_id).all()
    albums = db.query(Album).filter(Album.owner_id == owner_id).all()
    album_images = (
        db.query(AlbumImage).join(Album).filter(Album.owner_id == owner_id).all()
    )
    tags = db.query(Tag).filter(Tag.owner_id == owner_id).all()
    tag_links = (
        db.query(ImageTag.image_id, ImageTag.tag_id, Tag.name)
        .join(Tag, Tag.id == ImageTag.tag_id)
        .filter(Tag.owner_id == owner_id)
        .all()
    )
    # Tag names per photo stay in each image record as well: the library merge
    # reads them from image_to_dict(), and a restore of this manifest by an
    # older app that only knows the names still gets the tags back.
    tags_by_image: dict[str, list[str]] = {}
    for image_id, _tag_id, tag_name in tag_links:
        tags_by_image.setdefault(image_id, []).append(tag_name)
    canvases = db.query(Canvas).filter(Canvas.owner_id == owner_id).all()
    canvas_ids = [c.id for c in canvases]
    canvas_images = (
        db.query(CanvasImage).filter(CanvasImage.canvas_id.in_(canvas_ids)).all() if canvas_ids else []
    )
    layouts = (
        db.query(CanvasLayout).filter(CanvasLayout.canvas_id.in_(canvas_ids)).all() if canvas_ids else []
    )
    layout_ids = [l.id for l in layouts]
    layout_items = db.query(LayoutItem).filter(LayoutItem.layout_id.in_(layout_ids)).all() if layout_ids else []
    layout_versions = (
        db.query(LayoutVersion).filter(LayoutVersion.layout_id.in_(layout_ids)).all() if layout_ids else []
    )
    source_roots = db.query(SourceRoot).filter(SourceRoot.owner_id == owner_id).all()
    # The named snapshots of the photos' edits, and the develop presets.
    image_ids = [i.id for i in images]
    snapshots = []
    for start in range(0, len(image_ids), 500):
        snapshots.extend(
            db.query(EditSnapshot).filter(EditSnapshot.image_id.in_(image_ids[start : start + 500])).all()
        )
    presets = db.query(DevelopPreset).filter(DevelopPreset.owner_id == owner_id).all()
    # The rolls: closed sessions that imported something. Their review state
    # (staged files, sources, the collection folder) is not part of the
    # library and stays behind; the name and the dates are what a roll is.
    rolls = (
        db.query(ImportSession)
        .filter(ImportSession.owner_id == owner_id, ImportSession.status == ImportSessionStatus.committed)
        .all()
    )
    app_settings = {
        row.key: row.value for row in db.query(AppSetting).all() if row.key not in BACKUP_SECRET_SETTINGS
    }

    manifest = {
        "version": BACKUP_MANIFEST_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # What the sections mean, for whoever opens the zip by hand.
        "notes": {
            "files": "Managed originals sit under library/<file_path>. A photo with a "
            "source_root_id is indexed in place on its own storage and travels without its file.",
            "settings_excluded": "Secrets never leave the machine: "
            + ", ".join(BACKUP_SECRET_SETTINGS)
            + ". Open import sessions are not in a backup either - their photos live in "
            "their import folders, outside the library.",
        },
        "images": [image_to_dict(i, sorted(tags_by_image.get(i.id, []))) for i in images],
        "tags": [_row_to_dict(t) for t in tags],
        "image_tags": [{"image_id": image_id, "tag_id": tag_id} for image_id, tag_id, _name in tag_links],
        "albums": [_row_to_dict(a) for a in albums],
        "album_images": [
            {"album_id": ai.album_id, "image_id": ai.image_id, "position": ai.position} for ai in album_images
        ],
        "source_roots": [_row_to_dict(r) for r in source_roots],
        "canvases": [_row_to_dict(c) for c in canvases],
        "canvas_images": [_row_to_dict(ci) for ci in canvas_images],
        "canvas_layouts": [_row_to_dict(l) for l in layouts],
        "layout_items": [_row_to_dict(i) for i in layout_items],
        "layout_versions": [_row_to_dict(v) for v in layout_versions],
        "edit_snapshots": [_row_to_dict(s) for s in snapshots],
        "develop_presets": [_row_to_dict(p) for p in presets],
        "import_sessions": [{**_row_to_dict(s), "staging_dir": None} for s in rolls],
        "settings": app_settings,
        "settings_excluded": list(BACKUP_SECRET_SETTINGS),
    }

    fd, tmp_path_str = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    tmp_path = Path(tmp_path_str)
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2), compress_type=zipfile.ZIP_DEFLATED)
        for image in images:
            if not _has_backup_file(image):
                continue
            full_path = settings.library_root / image.file_path
            if full_path.is_file():
                zf.write(full_path, arcname=f"library/{image.file_path}", compress_type=zipfile.ZIP_STORED)
    return tmp_path


def _unused_folder(base: Path, name: str) -> Path:
    """`base/name`, or `base/name-2` and so on when that exists already."""
    candidate = base / name
    counter = 2
    while candidate.exists():
        candidate = base / f"{name}-{counter}"
        counter += 1
    return candidate


def _stage_backup(upload: UploadedFile, staging: Path) -> tuple[dict, Path]:
    """Read the zip and unpack its photos into `staging/library`, checking
    everything that could go wrong on the way: not a zip, no manifest, a
    manifest from a newer app, a path that would land outside the library.
    Nothing of the live library is read or written here."""
    stream = upload.file
    # zipfile needs to seek; an upload that can't is spooled to a file first.
    if not (hasattr(stream, "seekable") and stream.seekable()):
        spooled = staging / "backup.zip"
        with spooled.open("wb") as out:
            shutil.copyfileobj(upload.file, out, 8 * 1024 * 1024)
        stream = spooled.open("rb")
    untouched = " The library was not changed."
    try:
        zf = zipfile.ZipFile(stream)
    except zipfile.BadZipFile:
        raise RestoreError("That file is not a Rollfilm backup (not a zip archive)." + untouched)
    with zf:
        try:
            manifest = json.loads(zf.read("manifest.json"))
        except KeyError:
            raise RestoreError("That zip holds no manifest.json - it is not a Rollfilm backup." + untouched)
        except ValueError:
            raise RestoreError("The backup's manifest.json is not readable." + untouched)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("images"), list):
            raise RestoreError("The backup's manifest lists no photos section." + untouched)
        # Backups before the version field are version 1.
        version = manifest.get("version", 1)
        if not isinstance(version, int) or version > BACKUP_MANIFEST_VERSION:
            raise RestoreError(
                f"This backup was written by a newer Rollfilm (manifest version {version}; this one "
                f"reads up to {BACKUP_MANIFEST_VERSION}). Update the app, then restore it." + untouched
            )
        for data in manifest["images"]:
            if not isinstance(data, dict):
                raise RestoreError("The backup's manifest has a malformed photo record." + untouched)
            if data.get("source_root_id") or VIRTUAL_PATH_MARKER in str(data.get("file_path", "")):
                continue  # travels without a file; nothing is written at its path
            if _safe_library_path(data.get("file_path")) is None:
                raise RestoreError(
                    f"The backup lists a photo at “{data.get('file_path')}”, which is not a path "
                    "inside a library folder. The backup was refused." + untouched
                )

        extracted = staging / "library"
        extracted.mkdir(parents=True, exist_ok=True)
        for info in zf.infolist():
            name = info.filename
            if info.is_dir() or not name.startswith("library/"):
                continue  # the manifest itself, or something no backup of ours writes
            relative = name[len("library/"):]
            if _safe_library_path(relative) is None:
                raise RestoreError(
                    f"The backup holds a file at “{name}”, which would land outside the library "
                    "folder. The backup was refused." + untouched
                )
            target = extracted / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            # Member by member through a buffer: a RAW is never in memory whole.
            with zf.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
    if stream is not upload.file:
        stream.close()
        (staging / "backup.zip").unlink(missing_ok=True)
    return manifest, extracted


def _restore_rows(db: Session, owner_id: int, manifest: dict) -> dict:
    """Write the manifest into the catalog in one transaction: the old rows go
    and the backup's come in, and the commit at the end is the only one. A
    failure anywhere rolls the whole thing back to the catalog as it was."""
    images = manifest["images"]
    try:
        _wipe_catalog_rows(db, owner_id)
        db.flush()
        # The bulk deletes above don't tell the session's identity map; rows it
        # still holds from before would otherwise collide with the backup's
        # rows of the same ids as they are flushed.
        db.expunge_all()

        # Source roots first: photos indexed in place point at them. The
        # rolls likewise (version 4; older manifests have none, and their
        # photos restore without a roll).
        for data in manifest.get("source_roots", []):
            db.add(_row_from_dict(SourceRoot, data, owner_id=owner_id))
        for data in manifest.get("import_sessions", []):
            db.add(_row_from_dict(ImportSession, data, owner_id=owner_id))
        db.flush()

        # A photo's links to another photo (its RAW/JPEG partner, the original
        # of a virtual copy) are set once every photo is in - with the foreign
        # keys enforced, a link to a row that comes later would fail.
        links: list[tuple[str, str | None, str | None]] = []
        # A photo of a session the backup does not carry (one still open when
        # it was written) comes back without a roll.
        roll_ids = {data["id"] for data in manifest.get("import_sessions", [])}
        for data in images:
            row = image_row_from_dict(data, owner_id)
            if row.import_session_id not in roll_ids:
                row.import_session_id = None
            links.append((row.id, row.paired_image_id, row.virtual_of_image_id))
            row.paired_image_id = None
            row.virtual_of_image_id = None
            db.add(row)
        db.flush()
        for image_id, paired_id, virtual_id in links:
            if paired_id or virtual_id:
                row = db.get(Image, image_id)
                row.paired_image_id = paired_id
                row.virtual_of_image_id = virtual_id
        db.flush()

        if isinstance(manifest.get("tags"), list) and isinstance(manifest.get("image_tags"), list):
            # Version 3: the tag rows themselves (ids, "kept" vocabulary tags
            # without photos) and the links by id.
            for data in manifest["tags"]:
                db.add(_row_from_dict(Tag, data, owner_id=owner_id))
            db.flush()
            for link in manifest["image_tags"]:
                db.add(ImageTag(image_id=link["image_id"], tag_id=link["tag_id"]))
        else:
            # Older manifests: only the tag names per photo.
            tag_by_name: dict[str, Tag] = {}
            for data in images:
                for tag_name in data.get("tags", []):
                    tag = tag_by_name.get(tag_name)
                    if tag is None:
                        tag = Tag(owner_id=owner_id, name=tag_name)
                        db.add(tag)
                        db.flush()  # assigns the UUID id the link below needs
                        tag_by_name[tag_name] = tag
                    db.add(ImageTag(image_id=data["id"], tag_id=tag.id))
        db.flush()

        # Albums in two passes like the photos: a nested album's parent must exist.
        parents: list[tuple[str, str]] = []
        for data in manifest.get("albums", []):
            row = _row_from_dict(Album, data, owner_id=owner_id)
            if row.parent_album_id:
                parents.append((row.id, row.parent_album_id))
                row.parent_album_id = None
            db.add(row)
        db.flush()
        for album_id, parent_id in parents:
            db.get(Album, album_id).parent_album_id = parent_id
        for data in manifest.get("album_images", []):
            db.add(AlbumImage(album_id=data["album_id"], image_id=data["image_id"], position=data["position"]))
        db.flush()

        for data in manifest.get("canvases", []):
            db.add(_row_from_dict(Canvas, data, owner_id=owner_id))
        db.flush()
        for data in manifest.get("canvas_images", []):
            db.add(_row_from_dict(CanvasImage, data))
        for data in manifest.get("canvas_layouts", []):
            db.add(_row_from_dict(CanvasLayout, data, owner_id=owner_id))
        db.flush()
        for data in manifest.get("layout_items", []):
            db.add(_row_from_dict(LayoutItem, data))
        for data in manifest.get("layout_versions", []):
            db.add(_row_from_dict(LayoutVersion, data))
        db.flush()
        # Snapshots and presets (manifests from before they existed have none).
        for data in manifest.get("edit_snapshots", []):
            db.add(_row_from_dict(EditSnapshot, data))
        for data in manifest.get("develop_presets", []):
            db.add(_row_from_dict(DevelopPreset, data, owner_id=owner_id))
        db.flush()

        # The backup's settings replace this machine's, except the secrets a
        # backup never carries (and a manifest edited to carry one is not
        # believed either): the key already here stays.
        settings_section = manifest.get("settings")
        if isinstance(settings_section, dict):
            for key, value in settings_section.items():
                if key in BACKUP_SECRET_SETTINGS or not isinstance(key, str) or not isinstance(value, str):
                    continue
                set_setting(db, key, value)

        # Restored album members get their "album" / "album: …" tags back.
        sync_membership_tags(db, owner_id)
        db.commit()
    except RestoreError:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise RestoreError(
            f"The backup's catalog could not be written ({exc}). The library was not changed."
        ) from exc
    return {
        "images_restored": len(images),
        "albums_restored": len(manifest.get("albums", [])),
        "canvases_restored": len(manifest.get("canvases", [])),
    }


def _swap_library_files(extracted: Path, replaced: Path) -> bool:
    """Put the unpacked photos in place of the library's current files. The
    current files are moved aside into `replaced` (under the app's data
    folder), never deleted: a restore of the wrong backup, or of last month's,
    must not cost the photos of today, and on the same disk the move is a
    rename that takes no space - the user deletes the folder once the restored
    library is seen to be the right one. Returns whether anything was moved
    aside."""
    moved_any = False
    if settings.library_root.is_dir():
        for child in settings.library_root.iterdir():
            if _is_data_dir(child):
                continue
            replaced.mkdir(parents=True, exist_ok=True)
            shutil.move(str(child), str(replaced / child.name))
            moved_any = True
    settings.library_root.mkdir(parents=True, exist_ok=True)
    if extracted.is_dir():
        for child in extracted.iterdir():
            shutil.move(str(child), str(settings.library_root / child.name))
    return moved_any


def restore_from_backup(db: Session, owner_id: int, upload: UploadedFile) -> dict:
    """Replace everything in the library and the catalog with a backup. In
    this order, so that a restore that fails leaves the library exactly as it
    was: (1) the zip is unpacked and checked in a staging folder under the
    app's data folder, (2) the catalog is rewritten in one transaction, (3)
    only then the current files are moved aside and the unpacked ones put in
    their place. Up to the end of (2) nothing of the live library has been
    touched, and the error raised says so. Destructive all the same once it
    goes through - gated like wipe_library() (the /maintenance/restore route)."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    staging = _unused_folder(settings.pm_data_dir / "restore-staging", stamp)
    staging.mkdir(parents=True, exist_ok=True)
    try:
        manifest, extracted = _stage_backup(upload, staging)
        counts = _restore_rows(db, owner_id, manifest)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    replaced = _unused_folder(settings.pm_data_dir, f"restore-replaced-{stamp}")
    moved_aside = _swap_library_files(extracted, replaced)
    shutil.rmtree(staging, ignore_errors=True)
    # Thumbnails and staging belonged to the old library; the post-import
    # jobs below rebuild them for the restored one.
    _clear_derived_folders()
    if moved_aside:
        logger.info("restore: the previous library files were moved to %s", replaced)

    restored_images = db.query(Image).filter(Image.owner_id == owner_id).all()
    for image in restored_images:
        if not _has_backup_file(image):
            continue
        full_path = settings.library_root / image.file_path
        if full_path.is_file():
            enqueue_post_import(image.id, full_path)

    return {**counts, "replaced_folder": str(replaced) if moved_aside else None}
