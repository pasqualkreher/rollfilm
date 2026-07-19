"""In-app Trash: permanent deletion of soft-deleted photos.

Shared by the trash API routes (user-triggered "Delete forever") and the
automatic purge that runs in the background on every app start, removing
photos that sat in the Trash longer than the configured retention period.
"""

import logging
import shutil
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import FileType, Image, ImmichPendingDeletion, ImportStagedFile
from app.db.session import SessionLocal
from app.services import thumbnails
from app.services.hashing import sha1_file
from app.services.settings_store import (
    IMMICH_MODE_FULL,
    IMMICH_MODE_SELECTIVE,
    get_immich_config,
    get_trash_retention_days,
)

logger = logging.getLogger(__name__)


def prune_empty_dirs(start: Path, stop_at: Path) -> None:
    """After deleting a managed original, remove any now-empty parent folders the
    app created for it (the per-year / per-day import folders), walking upward.
    Never touches stop_at (the library root) itself, and bails the moment it
    would step outside it - so a bad path can't delete unrelated directories."""
    try:
        stop_at = stop_at.resolve()
    except OSError:
        return
    current = start.parent
    while True:
        try:
            resolved = current.resolve()
        except OSError:
            return
        # Stop at the library root, or if we've somehow escaped above it.
        if resolved == stop_at or stop_at not in resolved.parents:
            return
        try:
            next(resolved.iterdir())
            return  # still has contents - leave it (and everything above) alone
        except StopIteration:
            pass  # empty - safe to remove
        except OSError:
            return
        try:
            resolved.rmdir()
        except OSError:
            return
        current = resolved.parent


def _queue_immich_removals(db: Session, images: list[Image]) -> None:
    """For each currently-synced photo about to be permanently deleted, write a
    durable ImmichPendingDeletion row (same transaction as the deletion) that
    the background sync loop turns into an Immich-side delete. Nothing is
    queued in manual mode - there uploads are one-off pushes, not a sync, and
    silently deleting from Immich would be a surprise. Likewise, selective-mode
    photos whose flag was turned off stay on Immich, matching the unflag
    behavior ("photos already on Immich are left there")."""
    config = get_immich_config(db)
    if config is None or config.sync_mode not in (IMMICH_MODE_SELECTIVE, IMMICH_MODE_FULL):
        return
    for image in images:
        if config.sync_mode == IMMICH_MODE_SELECTIVE and not image.immich_sync:
            continue
        if image.immich_asset_id:
            db.add(
                ImmichPendingDeletion(
                    asset_id=image.immich_asset_id, filename=image.original_filename
                )
            )
        elif image.file_type == FileType.jpeg and image.source_root_id is None:
            # Synced before asset ids were recorded: hash the file while it
            # still exists; the sync loop resolves it against Immich later.
            checksum = sha1_file(settings.library_root / image.file_path)
            if checksum:
                db.add(
                    ImmichPendingDeletion(
                        sha1_checksum=checksum, filename=image.original_filename
                    )
                )


def hard_delete_images(db: Session, images: list[Image], *, delete_files: bool) -> None:
    """Remove image rows for good. paired_image_id and
    ImportStagedFile.duplicate_of_image_id both have FK constraints (enforced -
    see db/session.py) back to images.id; null those out first or deleting a row
    still referenced by another would fail. Clear the deleted rows' own pairing
    link *and* any external sibling pointing back in - when both halves of a
    pair are selected, only nulling the sibling leaves the first half still
    pointing at the second.

    Original files are only ever touched for managed photos (delete_files=True
    from the Trash); photos indexed from a source root always keep their file -
    it lives in the user's own folder and was never ours to delete.

    Trash deletions (delete_files=True) also queue the Immich-side removal of
    synced photos. The maintenance cleanup of vanished files (delete_files=
    False) deliberately doesn't: the file disappearing outside the app isn't
    the user asking for the photo to be gone from Immich."""
    if delete_files:
        # Before anything is unlinked - the checksum fallback needs the file.
        _queue_immich_removals(db, images)
    image_ids = {image.id for image in images}
    for image in images:
        image.paired_image_id = None
    if image_ids:
        db.query(Image).filter(Image.paired_image_id.in_(image_ids)).update(
            {Image.paired_image_id: None}, synchronize_session=False
        )
        db.query(ImportStagedFile).filter(
            ImportStagedFile.duplicate_of_image_id.in_(image_ids)
        ).update({ImportStagedFile.duplicate_of_image_id: None}, synchronize_session=False)
    db.flush()

    for image in images:
        if delete_files and image.source_root_id is None:
            # Managed (imported) library file - ours to delete. Also tidy the
            # date folders the app created once they're empty, so deleting the
            # last shot of a day/year doesn't leave hollow dirs.
            original = settings.library_root / image.file_path
            original.unlink(missing_ok=True)
            prune_empty_dirs(original, settings.library_root)
        shutil.rmtree(thumbnails.derivative_dir(image.id), ignore_errors=True)
        db.delete(image)


def purge_expired() -> int:
    """Permanently delete managed photos whose Trash stay exceeded the
    configured retention (Settings, default 14 days; 0 = keep forever).

    Only managed rows are purged: deleted source-root photos are also
    soft-deleted rows, but they act as permanent scan-exclusion markers and
    must survive (see images.bulk_delete_images)."""
    # With the library root unreachable (external drive asleep/unplugged),
    # purging would delete the DB rows and queue Immich removals while the
    # actual files sit untouched on the absent drive - orphaning them there
    # forever. Skip the pass; the next one after the drive returns purges.
    if not settings.library_root.is_dir():
        logger.warning(
            "Trash purge skipped: library root %s not found", settings.library_root
        )
        return 0
    db = SessionLocal()
    try:
        days = get_trash_retention_days(db)
        if days <= 0:
            return 0
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        expired = (
            db.query(Image)
            .filter(
                Image.source_root_id.is_(None),
                Image.deleted_at.isnot(None),
                Image.deleted_at < cutoff,
            )
            .all()
        )
        if expired:
            hard_delete_images(db, expired, delete_files=True)
            db.commit()
            logger.info(
                "Trash auto-purge: permanently deleted %d photo(s) trashed more than %d day(s) ago",
                len(expired),
                days,
            )
            # Process any Immich removals the deletion just queued right away.
            from app.services.immich_sync import run_immich_sync_soon

            run_immich_sync_soon()
        return len(expired)
    finally:
        db.close()


# Re-check the trash a few times a day: the desktop app can stay open for
# days/weeks, and with a purge that only ran at process start, photos sat in
# the Trash long past their retention until the next relaunch ("trash clean
# does not work"). Startup still purges immediately; this keeps it honest
# for long-running sessions.
_PURGE_INTERVAL_S = 6 * 60 * 60

_purge_wakeup = threading.Event()
_purge_thread_started = threading.Lock()
_purge_running = False


def run_purge_soon() -> None:
    """Wake the purge loop now (e.g. right after the user changes the retention
    setting, so a shorter retention takes effect immediately, not hours later)."""
    _purge_wakeup.set()


def start_background_purge() -> None:
    """Purge on startup and then periodically, off the request/startup path -
    deleting many originals can take a while and must never delay or break the
    API coming up."""
    global _purge_running
    with _purge_thread_started:
        if _purge_running:
            return
        _purge_running = True

    def _run() -> None:
        while True:
            try:
                purge_expired()
            except Exception:
                logger.exception("Trash auto-purge failed")
            _purge_wakeup.wait(timeout=_PURGE_INTERVAL_S)
            _purge_wakeup.clear()

    threading.Thread(target=_run, name="trash-purge", daemon=True).start()
