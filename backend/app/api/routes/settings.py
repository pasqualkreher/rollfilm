from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Album, AlbumImage, FileType, Image, User
from app.db.session import get_db
from app.services import immich as immich_service
from app.services.settings_store import (
    AUTO_DEVELOP_ENABLED,
    AUTO_DEVELOP_GROUP_NAMES,
    AUTO_DEVELOP_GROUPS,
    BORG_ENABLED,
    BORG_PASSPHRASE,
    BORG_REPO,
    IMMICH_API_KEY,
    IMMICH_BASE_URL,
    IMMICH_ENABLED,
    IMMICH_MODE_SELECTIVE,
    IMMICH_MODES,
    IMMICH_SYNC_MODE,
    IMMICH_SYNC_PAUSED,
    RAW_NATIVE_DECODE,
    SMART_ALBUM_PLACE_RADIUS_KM,
    SMART_ALBUM_SECTION_NAMES,
    SMART_ALBUM_SECTIONS,
    TRASH_RETENTION_DAYS,
    get_auto_develop_enabled,
    get_auto_develop_groups,
    get_immich_enabled,
    get_immich_sync_mode,
    get_immich_sync_paused,
    get_raw_native_decode,
    get_setting,
    get_smart_album_config,
    get_trash_retention_days,
    set_setting,
)
from app.services import raw as raw_service
from app.services import thumbnails as thumbnails_service
from app.services import borg_backup
from app.services.immich_sync import run_immich_sync_soon
from app.services.trash import run_purge_soon
from app.workers.queue import immich_pending_uploads, immich_upload_history

router = APIRouter(prefix="/settings", tags=["settings"])


def _sync_progress(db: Session, mode: str) -> tuple[int, int]:
    """(synced, total) for the current sync mode: how many of the JPEGs the
    mode wants on Immich already have a recorded asset id. Full and manual
    count the whole visible library; selective counts flagged photos plus the
    members of flagged albums (both reach Immich in that mode)."""
    query = db.query(Image.id).filter(
        Image.deleted_at.is_(None), Image.file_type == FileType.jpeg
    )
    if mode == IMMICH_MODE_SELECTIVE:
        flagged_album_members = (
            db.query(AlbumImage.image_id)
            .join(Album, Album.id == AlbumImage.album_id)
            .filter(Album.immich_sync.is_(True))
        )
        query = query.filter(
            or_(Image.immich_sync.is_(True), Image.id.in_(flagged_album_members))
        )
    total = query.count()
    synced = query.filter(Image.immich_asset_id.isnot(None)).count()
    return synced, total


def _activity(db: Session) -> schemas.ImmichActivityOut:
    mode = get_immich_sync_mode(db)
    synced, total = _sync_progress(db, mode)
    return schemas.ImmichActivityOut(
        pending_uploads=immich_pending_uploads(),
        sync_mode=mode,
        synced=synced,
        total=total,
        paused=get_immich_sync_paused(db),
    )


@router.get("/immich/activity", response_model=schemas.ImmichActivityOut)
def immich_activity(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """How much Immich upload work is queued or in flight right now, and how
    far the sync has come (synced/total). Polled by the web UI's sync indicator
    and the Settings sync-status panel, and by the desktop shell when the
    window is closed - the upload queue is in-memory, so the shell warns before
    a quit would drop unfinished uploads. sync_mode is included so the warning
    can say whether the startup sync loop will catch up the remainder
    (full/selective) or the uploads are simply gone (manual)."""
    return _activity(db)


@router.put("/immich/pause", response_model=schemas.ImmichActivityOut)
def set_immich_pause(
    payload: schemas.ImmichPauseUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pause/resume automatic Immich syncing (e.g. while on mobile data).
    Pausing stops the background sync loop and drops queued automatic uploads;
    explicit manual "Add to Immich" pushes still work. Resuming wakes the sync
    loop immediately so it catches up on whatever was skipped."""
    set_setting(db, IMMICH_SYNC_PAUSED, "1" if payload.paused else "0")
    db.commit()
    if not payload.paused:
        run_immich_sync_soon()
    return _activity(db)


@router.get("/immich", response_model=schemas.ImmichSettingsOut)
def get_immich_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    base_url = get_setting(db, IMMICH_BASE_URL)
    api_key = get_setting(db, IMMICH_API_KEY)
    return schemas.ImmichSettingsOut(
        base_url=base_url,
        api_key_set=bool(api_key),
        sync_mode=get_immich_sync_mode(db),
        enabled=get_immich_enabled(db),
    )


@router.put("/immich", response_model=schemas.ImmichSettingsOut)
def update_immich_settings(
    payload: schemas.ImmichSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    set_setting(db, IMMICH_BASE_URL, payload.base_url.strip())
    # A null/omitted key leaves the stored one untouched (so the user can edit
    # the host without re-typing the key); an empty string clears it.
    if payload.api_key is not None:
        set_setting(db, IMMICH_API_KEY, payload.api_key.strip())
    if payload.sync_mode is not None and payload.sync_mode in IMMICH_MODES:
        set_setting(db, IMMICH_SYNC_MODE, payload.sync_mode)
    if payload.enabled is not None:
        set_setting(db, IMMICH_ENABLED, "1" if payload.enabled else "0")
    db.commit()
    # A mode/server/switch change may make photos newly syncable (or removable)
    # - reconcile now instead of on the next timed pass. (With the integration
    # disabled the sync pass sees "not configured" and stands down.)
    run_immich_sync_soon()

    api_key = get_setting(db, IMMICH_API_KEY)
    return schemas.ImmichSettingsOut(
        base_url=payload.base_url.strip(),
        api_key_set=bool(api_key),
        sync_mode=get_immich_sync_mode(db),
        enabled=get_immich_enabled(db),
    )


@router.get("/raw", response_model=schemas.RawDecodeSettingsOut)
def get_raw_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return schemas.RawDecodeSettingsOut(native_decode=get_raw_native_decode(db))


@router.put("/raw", response_model=schemas.RawDecodeSettingsOut)
def update_raw_settings(
    payload: schemas.RawDecodeSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Toggle native (no-processing) RAW loading. Persists the setting, flips the
    live decode flag, and drops the in-memory decoded-base cache so the editor
    re-decodes immediately. On-disk thumbnails/previews are rebuilt separately
    (the client kicks off a rebuild) since they're baked at import time."""
    set_setting(db, RAW_NATIVE_DECODE, "1" if payload.native_decode else "0")
    db.commit()
    raw_service.set_native_decode(payload.native_decode)
    # The cached bases were decoded under the old setting - drop them so the next
    # editor preview re-decodes with the new mode.
    thumbnails_service.clear_editor_base_caches()
    return schemas.RawDecodeSettingsOut(native_decode=payload.native_decode)


@router.get("/smart-albums", response_model=schemas.SmartAlbumSettingsOut)
def get_smart_album_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    cfg = get_smart_album_config(db)
    return schemas.SmartAlbumSettingsOut(
        sections=list(cfg.sections), place_radius_km=cfg.place_radius_km
    )


@router.put("/smart-albums", response_model=schemas.SmartAlbumSettingsOut)
def update_smart_album_settings(
    payload: schemas.SmartAlbumSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Which smart-album sections the Albums page shows, and the place radius.
    Either field may be omitted to leave it unchanged. Unknown section names
    are dropped rather than rejected (a stale client after an update just
    loses the sections it doesn't know)."""
    if payload.sections is not None:
        wanted = [s for s in payload.sections if s in SMART_ALBUM_SECTION_NAMES]
        set_setting(db, SMART_ALBUM_SECTIONS, ",".join(wanted))
    if payload.place_radius_km is not None:
        radius = max(1.0, min(500.0, payload.place_radius_km))
        set_setting(db, SMART_ALBUM_PLACE_RADIUS_KM, str(radius))
    db.commit()
    cfg = get_smart_album_config(db)
    return schemas.SmartAlbumSettingsOut(
        sections=list(cfg.sections), place_radius_km=cfg.place_radius_km
    )


@router.get("/trash", response_model=schemas.TrashSettingsOut)
def get_trash_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return schemas.TrashSettingsOut(retention_days=get_trash_retention_days(db))


@router.put("/trash", response_model=schemas.TrashSettingsOut)
def update_trash_settings(
    payload: schemas.TrashSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # 0 = keep forever; capped at ~10 years so a typo can't store nonsense.
    days = max(0, min(3650, payload.retention_days))
    set_setting(db, TRASH_RETENTION_DAYS, str(days))
    db.commit()
    # Apply the new retention right away (in the background) instead of at the
    # next periodic pass - shortening it should visibly clean the Trash now.
    run_purge_soon()
    return schemas.TrashSettingsOut(retention_days=days)


def _auto_develop_example_count(db: Session, owner_id: int) -> int:
    """How many photos currently teach the auto-develop suggestion: still in
    the library (not trashed) and carrying a saved edit - either in place
    (edit_adjustments) or baked into a saved copy (applied_adjustments)."""
    return (
        db.query(Image.id)
        .filter(
            Image.owner_id == owner_id,
            Image.deleted_at.is_(None),
            or_(Image.edit_adjustments.isnot(None), Image.applied_adjustments.isnot(None)),
        )
        .count()
    )


@router.get("/auto-develop", response_model=schemas.AutoDevelopSettingsOut)
def get_auto_develop_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return schemas.AutoDevelopSettingsOut(
        enabled=get_auto_develop_enabled(db),
        enabled_groups=get_auto_develop_groups(db),
        example_count=_auto_develop_example_count(db, current_user.id),
    )


@router.put("/auto-develop", response_model=schemas.AutoDevelopSettingsOut)
def update_auto_develop_settings(
    payload: schemas.AutoDevelopSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    set_setting(db, AUTO_DEVELOP_ENABLED, "1" if payload.enabled else "0")
    if payload.enabled_groups is not None:
        # Keep canonical order and drop unknown/duplicate names; an empty list
        # is stored as "" (= nothing enabled), distinct from unset (= all).
        names = [n for n in AUTO_DEVELOP_GROUP_NAMES if n in payload.enabled_groups]
        set_setting(db, AUTO_DEVELOP_GROUPS, ",".join(names))
    db.commit()
    return schemas.AutoDevelopSettingsOut(
        enabled=payload.enabled,
        enabled_groups=get_auto_develop_groups(db),
        example_count=_auto_develop_example_count(db, current_user.id),
    )


@router.get("/immich/uploads", response_model=list[schemas.ImmichUploadResult])
def recent_immich_uploads(current_user: User = Depends(get_current_user)):
    """Outcome of recent background Immich uploads (kept in memory since the
    last backend start) — the uploads themselves are fire-and-forget, so this
    is how the UI can show whether they actually arrived."""
    return immich_upload_history()


@router.post("/immich/test", response_model=schemas.ImmichTestResult)
def test_immich_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    base_url = (get_setting(db, IMMICH_BASE_URL) or "").strip()
    api_key = (get_setting(db, IMMICH_API_KEY) or "").strip()
    if not base_url or not api_key:
        return schemas.ImmichTestResult(
            ok=False, message="Set both the Immich host and an API key first."
        )
    ok, message = immich_service.check_connection(base_url, api_key)
    return schemas.ImmichTestResult(ok=ok, message=message)


def _borg_out(db: Session) -> schemas.BorgSettingsOut:
    config = borg_backup.get_borg_config(db)
    status = borg_backup.get_status()
    return schemas.BorgSettingsOut(
        enabled=config.enabled,
        repo=config.repo or None,
        passphrase_set=bool(config.passphrase),
        available=borg_backup.borg_available(),
        running=status.running,
        last_ok=status.last_ok,
        last_message=status.last_message,
        last_archive=status.last_archive,
        last_finished_at=status.last_finished_at,
    )


@router.get("/borg", response_model=schemas.BorgSettingsOut)
def get_borg_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Borg backup config plus live status (is borg installed, is a run in
    progress, how did the last one go). Polled by the Settings panel."""
    return _borg_out(db)


@router.put("/borg", response_model=schemas.BorgSettingsOut)
def update_borg_settings(
    payload: schemas.BorgSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save the repository address, passphrase and on/off toggle. Enabling (or
    changing the target) nudges the background loop so an initial backup starts
    soon instead of at the next daily tick."""
    set_setting(db, BORG_ENABLED, "1" if payload.enabled else "0")
    set_setting(db, BORG_REPO, payload.repo.strip())
    # A null/omitted passphrase leaves the stored one untouched (edit the repo
    # without re-typing it); an empty string clears it (unencrypted repo).
    if payload.passphrase is not None:
        set_setting(db, BORG_PASSPHRASE, payload.passphrase)
    db.commit()
    if payload.enabled:
        borg_backup.run_backup_soon()
    return _borg_out(db)


@router.post("/borg/backup", response_model=schemas.BorgSettingsOut)
def run_borg_backup_now(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Start a backup right now, off the request path (borg can run for minutes).
    The returned status has running=true; poll GET /settings/borg for the outcome."""
    borg_backup.trigger_backup_now()
    return _borg_out(db)


@router.post("/borg/test", response_model=schemas.BorgTestResult)
def test_borg_repo(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Check the configured repository is reachable, initializing it if it's new,
    so the user gets an immediate yes/no."""
    ok, message = borg_backup.test_repo(db)
    return schemas.BorgTestResult(ok=ok, message=message)
