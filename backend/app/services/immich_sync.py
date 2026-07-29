"""Background Immich sync loop: reconciles the library with Immich at startup
and every minute after that (see main.py). Only active in the "selective" and
"full" sync modes - "manual" stays what it says.

Immich mirrors the *visible* library. Each pass:

- Trashed photos leave Immich: a synced photo moved to the in-app Trash has
  its Immich asset deleted (and its stored asset id cleared).
- Restored photos come back: restore clears deleted_at, so the photo is simply
  an upload candidate again and gets re-uploaded on the next pass.
- Uploads: every JPEG that should be on Immich (full mode: all of them;
  selective: the immich_sync-flagged ones) but has no recorded asset id yet is
  uploaded and its asset id stored. Immich dedups by checksum server-side, so
  photos that are already there just get their asset id backfilled.
- Album membership: photos *already* on Immich are added to the Immich albums
  they belong in (full mode: all their albums; selective: the flagged ones).
  Uploads only mirror albums at upload time, so without this a photo added to
  an album after its upload - or a library synced before full mode was turned
  on - would never appear in the Immich album.
- Permanent deletions: immich_pending_deletions rows (written when a photo is
  hard-deleted - see trash.hard_delete_images - covering the gap where a photo
  is trashed and permanently deleted before this loop ever saw it) are
  resolved and the matching Immich assets deleted.

The event-driven uploads (import commit, flag toggles, album adds) still run
instantly through the worker queue; this loop is the safety net that catches
whatever they missed - Immich offline at the time, photos synced before asset
ids existed, deletions that failed mid-flight.
"""

import logging
import threading
import time

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.models import Album, AlbumImage, FileType, Image, ImageTag, ImmichPendingDeletion, Tag
from app.db.session import SessionLocal
from app.services.filesystem import resolve_image_path
from app.services.hashing import sha1_file
from app.services.immich import (
    add_assets_to_album,
    delete_assets,
    find_asset_ids_by_checksums,
    upload_asset,
)
from app.services.settings_store import (
    IMMICH_MODE_FULL,
    IMMICH_MODE_SELECTIVE,
    ImmichConfig,
    get_immich_config,
    get_immich_sync_paused,
)

# Shared with the fire-and-forget upload path on purpose: the sync loop's
# uploads/removals land in the same Settings activity history, and album
# mirroring must behave identically no matter which path uploaded the photo.
from app.workers.queue import _add_to_albums, _record_upload, _resolve_album_id

logger = logging.getLogger(__name__)

_SYNC_INTERVAL_S = 60

# Per-image retry backoff so one broken photo (missing file, Immich rejecting
# it with a 4xx) doesn't get re-attempted - and re-logged - every minute
# forever. Failures double the wait, capped at an hour; success clears it.
_BACKOFF_START_S = 120
_BACKOFF_MAX_S = 3600
_upload_backoff: dict[str, tuple[int, float]] = {}
_backoff_lock = threading.Lock()


def _should_attempt(image_id: str) -> bool:
    with _backoff_lock:
        entry = _upload_backoff.get(image_id)
    return entry is None or time.monotonic() >= entry[1]


def _note_failure(image_id: str) -> None:
    with _backoff_lock:
        failures = _upload_backoff.get(image_id, (0, 0.0))[0] + 1
        delay = min(_BACKOFF_START_S * 2 ** (failures - 1), _BACKOFF_MAX_S)
        _upload_backoff[image_id] = (failures, time.monotonic() + delay)


def _clear_failure(image_id: str) -> None:
    with _backoff_lock:
        _upload_backoff.pop(image_id, None)


def immich_album_names(db: Session, image: Image, config: ImmichConfig) -> tuple[str, ...]:
    """Immich album names an image should be mirrored into, given the sync mode.
    Full mode mirrors every album the photo is in; selective mode only albums
    the user flagged (immich_sync); manual mode mirrors nothing. Membership
    counts manual adds and a matching album tag rule alike."""
    if not config.album_sync:
        return ()
    manual_ids = {link.album_id for link in image.albums}
    query = db.query(Album).filter(
        or_(Album.id.in_(manual_ids), Album.tag_filter.isnot(None))
        if manual_ids
        else Album.tag_filter.isnot(None)
    )
    if config.sync_mode != IMMICH_MODE_FULL:
        query = query.filter(Album.immich_sync.is_(True))
    image_tags = set(image.tags)
    return tuple(
        a.name
        for a in query.all()
        if a.id in manual_ids or (image_tags and image_tags & set(a.tag_filter_list))
    )


def _delete_asset_tolerant(config: ImmichConfig, asset_id: str, filename: str) -> None:
    """Delete one asset, treating "Immich doesn't know this id" (HTTP 400 -
    already deleted over there, or a stale id from a previous server) as
    success: the goal is the asset being gone. Anything else (network, auth)
    propagates so the caller retries on a later pass. force=True because a
    merely-trashed Immich asset would swallow a later re-upload of the same
    checksum (restore from this app's Trash); the library file stays the
    recoverable copy."""
    try:
        delete_assets(config.base_url, config.api_key, [asset_id], force=True)
    except RuntimeError as exc:
        if "HTTP 400" not in str(exc):
            raise
        logger.info("Immich no longer has asset %s (%s)", asset_id, filename)
    else:
        _record_upload(filename, True, "removed from Immich")
        logger.info("Removed %s from Immich", filename)


# Trashed photos without a stored asset id that were already looked up on
# Immich by checksum (found or not) - so legacy photos in the Trash don't get
# re-hashed and re-queried every minute. In-memory on purpose: a restart just
# costs one repeated bulk lookup.
_trash_checked: set[str] = set()


def _remove_trashed(db: Session, config: ImmichConfig) -> None:
    """Photos sitting in the in-app Trash must not be visible on Immich. Photos
    with a recorded asset id are deleted directly (and the id cleared, so a
    later restore makes them upload candidates again). Legacy photos synced
    before asset ids existed are matched by checksum once - their file is still
    on disk while they're in the Trash."""
    query = db.query(Image).filter(Image.deleted_at.isnot(None))
    if config.sync_mode == IMMICH_MODE_SELECTIVE:
        query = query.filter(Image.immich_sync.is_(True))

    lookup: dict[str, Image] = {}
    for image in query.all():
        if image.immich_asset_id:
            _delete_asset_tolerant(config, image.immich_asset_id, image.original_filename)
            image.immich_asset_id = None
            db.commit()
        elif image.file_type == FileType.jpeg and image.id not in _trash_checked:
            path = resolve_image_path(image)
            checksum = sha1_file(path) if path.exists() else None
            if checksum:
                lookup[checksum] = image
            else:
                _trash_checked.add(image.id)

    if not lookup:
        return
    resolved = find_asset_ids_by_checksums(config.base_url, config.api_key, list(lookup))
    for checksum, image in lookup.items():
        asset_id = resolved.get(checksum)
        if asset_id:
            _delete_asset_tolerant(config, asset_id, image.original_filename)
        _trash_checked.add(image.id)


def _process_pending_deletions(db: Session, config: ImmichConfig) -> None:
    """Work through the durable deletion queue. Each row is deleted only after
    its Immich call succeeded (or turned out to be unnecessary), so a network
    failure just leaves it for the next pass. Rows are handled one by one: a
    single stale asset id must not wedge the whole queue."""
    pending = db.query(ImmichPendingDeletion).order_by(ImmichPendingDeletion.created_at).all()
    if not pending:
        return

    checksums = [row.sha1_checksum for row in pending if not row.asset_id and row.sha1_checksum]
    resolved = find_asset_ids_by_checksums(config.base_url, config.api_key, checksums)

    for row in pending:
        asset_id = row.asset_id or resolved.get(row.sha1_checksum or "")
        if asset_id:
            _delete_asset_tolerant(config, asset_id, row.filename)
        # No asset id and no checksum match: the photo was never on Immich (or
        # is already gone) - nothing to remove.
        db.delete(row)
        db.commit()


def _upload_missing(db: Session, config: ImmichConfig) -> None:
    """Upload every JPEG the sync mode says belongs on Immich but that has no
    recorded asset id yet. Sequential on the loop thread on purpose: passes
    can't overlap themselves, so a big first pass (full mode over an existing
    library) just takes a few cycles' worth of time instead of flooding the
    upload pool with duplicates."""
    query = db.query(Image).filter(
        Image.deleted_at.is_(None),
        Image.file_type == FileType.jpeg,
        Image.immich_asset_id.is_(None),
    )
    if config.sync_mode == IMMICH_MODE_SELECTIVE:
        # Flagged photos, plus photos matching a flagged album's tag rule -
        # tagging a photo later must land it on Immich just like adding it to
        # the flagged album by hand does (that path uploads event-driven).
        rule_tags: set[str] = set()
        for album in db.query(Album).filter(
            Album.immich_sync.is_(True), Album.tag_filter.isnot(None)
        ):
            rule_tags.update(album.tag_filter_list)
        if rule_tags:
            tagged = (
                db.query(ImageTag.image_id)
                .join(Tag, Tag.id == ImageTag.tag_id)
                .filter(Tag.name.in_(rule_tags))
            )
            query = query.filter(
                or_(Image.immich_sync.is_(True), Image.id.in_(tagged))
            )
        else:
            query = query.filter(Image.immich_sync.is_(True))
    for image in query.all():
        if not _should_attempt(image.id):
            continue
        path = resolve_image_path(image)
        if not path.exists():
            _note_failure(image.id)
            continue
        try:
            status, asset_id = upload_asset(config.base_url, config.api_key, path, image.taken_at)
            image.immich_asset_id = asset_id
            db.commit()
            album_note = _add_to_albums(
                config.base_url, config.api_key, asset_id, immich_album_names(db, image, config)
            )
            _clear_failure(image.id)
            # If this is a restore-from-Trash re-upload, allow a future trip
            # back to the Trash to be checksum-checked again if ever needed.
            _trash_checked.discard(image.id)
            # "duplicate" here just means the asset id got backfilled for a
            # photo Immich already had - routine during the first full-mode
            # pass, so don't flood the activity history with it.
            if status != "duplicate":
                _record_upload(path.name, True, f"{status}{album_note} (background sync)")
                logger.info("Immich sync uploaded %s (%s)%s", path.name, status, album_note)
        except Exception:
            logger.exception("Immich sync upload failed for %s", path.name)
            _note_failure(image.id)


# (album name, asset id) pairs this process already pushed to Immich, so the
# every-minute reconcile doesn't re-PUT every album's full membership forever.
# In-memory on purpose (same as _trash_checked), and cleared every hour: adds
# are idempotent on Immich, so a restart or reset just costs one repeated batch
# add per album - and the hourly full push heals memberships this set wrongly
# remembers as synced (e.g. a photo removed from an album and re-added while
# Immich was unreachable).
_album_pairs_synced: set[tuple[str, str]] = set()
_ALBUM_FULL_RESYNC_S = 3600
_album_pairs_cleared_at = 0.0


def _sync_album_membership(db: Session, config: ImmichConfig) -> None:
    """Add photos that are *already* on Immich to the Immich albums they belong
    in. Uploads mirror albums only at upload time, which misses membership that
    changed afterwards: a photo added to an album later, an album flagged for
    sync after its photos were uploaded, or a whole library uploaded before
    full mode / album sync was switched on. Add-only by design - removals stay
    event-driven (enqueue_immich_album_remove_assets), so this pass can never
    fight photos the user added to an Immich album by hand."""
    if not config.album_sync:
        return
    global _album_pairs_cleared_at
    now = time.monotonic()
    if now - _album_pairs_cleared_at >= _ALBUM_FULL_RESYNC_S:
        _album_pairs_synced.clear()
        _album_pairs_cleared_at = now
    query = (
        db.query(Album.name, Image.immich_asset_id)
        .join(AlbumImage, AlbumImage.album_id == Album.id)
        .join(Image, AlbumImage.image_id == Image.id)
        .filter(Image.deleted_at.is_(None), Image.immich_asset_id.isnot(None))
    )
    # Selective mode mirrors flagged *albums* with all their members (matching
    # set_album_immich_sync, which uploads every JPEG in a flagged album) - the
    # per-image flag only decides which loose photos get uploaded.
    if config.sync_mode == IMMICH_MODE_SELECTIVE:
        query = query.filter(Album.immich_sync.is_(True))
    pairs: set[tuple[str, str]] = {(name, asset_id) for name, asset_id in query.all()}

    # Tag-rule membership: photos carrying a tag of a mirrored album's rule
    # belong in that Immich album exactly like manually added ones.
    rule_albums = db.query(Album).filter(Album.tag_filter.isnot(None))
    if config.sync_mode == IMMICH_MODE_SELECTIVE:
        rule_albums = rule_albums.filter(Album.immich_sync.is_(True))
    for album in rule_albums.all():
        rule_tags = album.tag_filter_list
        if not rule_tags:
            continue
        tagged = (
            db.query(Image.immich_asset_id)
            .join(ImageTag, ImageTag.image_id == Image.id)
            .join(Tag, Tag.id == ImageTag.tag_id)
            .filter(
                Tag.owner_id == album.owner_id,
                Tag.name.in_(rule_tags),
                Image.deleted_at.is_(None),
                Image.immich_asset_id.isnot(None),
            )
            .distinct()
        )
        pairs.update((album.name, asset_id) for (asset_id,) in tagged.all())

    to_push: dict[str, list[str]] = {}
    for name, asset_id in pairs:
        if (name, asset_id) not in _album_pairs_synced:
            to_push.setdefault(name, []).append(asset_id)

    for name, asset_ids in to_push.items():
        try:
            album_id = _resolve_album_id(config.base_url, config.api_key, name)
            added = add_assets_to_album(config.base_url, config.api_key, album_id, asset_ids)
        except Exception:
            logger.exception("Immich album sync failed for album %r", name)
            continue
        _album_pairs_synced.update((name, asset_id) for asset_id in asset_ids)
        # added == 0 means Immich already had them all (routine right after a
        # restart, when the in-memory set is empty) - not worth a history entry.
        if added:
            _record_upload(name, True, f"added {added} photo(s) to Immich album (background sync)")
            logger.info("Immich sync added %d photo(s) to album %r", added, name)


def run_sync_once() -> None:
    db = SessionLocal()
    try:
        config = get_immich_config(db)
        if config is None or config.sync_mode not in (IMMICH_MODE_SELECTIVE, IMMICH_MODE_FULL):
            return
        # User-requested pause (e.g. on mobile data): no Immich traffic at all
        # until resumed - resuming wakes the loop, which then catches up.
        if get_immich_sync_paused(db):
            return
        _remove_trashed(db, config)
        _process_pending_deletions(db, config)
        _upload_missing(db, config)
        _sync_album_membership(db, config)
    finally:
        db.close()


_sync_wakeup = threading.Event()
_sync_thread_started = threading.Lock()
_sync_running = False


def run_immich_sync_soon() -> None:
    """Wake the sync loop now (e.g. right after a permanent deletion queued
    Immich removals, or after the user changes the sync settings), instead of
    waiting out the rest of the interval."""
    _sync_wakeup.set()


def start_background_immich_sync() -> None:
    """Sync on startup and then every minute, on its own daemon thread - the
    same pattern as trash.start_background_purge. Network errors are logged
    and retried on the next pass; they can never break the API."""
    global _sync_running
    with _sync_thread_started:
        if _sync_running:
            return
        _sync_running = True

    def _run() -> None:
        while True:
            try:
                run_sync_once()
            except Exception:
                logger.exception("Immich background sync failed")
            _sync_wakeup.wait(timeout=_SYNC_INTERVAL_S)
            _sync_wakeup.clear()

    threading.Thread(target=_run, name="immich-sync", daemon=True).start()
