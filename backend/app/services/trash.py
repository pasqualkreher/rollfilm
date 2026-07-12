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
from app.db.models import Image, ImportStagedFile
from app.db.session import SessionLocal
from app.services import thumbnails
from app.services.settings_store import get_trash_retention_days

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
    it lives in the user's own folder and was never ours to delete."""
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
        return len(expired)
    finally:
        db.close()


def start_background_purge() -> None:
    """Run the purge off the startup path - deleting many originals can take a
    while and must never delay or break the API coming up."""

    def _run() -> None:
        try:
            purge_expired()
        except Exception:
            logger.exception("Trash auto-purge failed")

    threading.Thread(target=_run, name="trash-purge", daemon=True).start()
