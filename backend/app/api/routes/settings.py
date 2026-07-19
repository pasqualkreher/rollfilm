from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Album, AlbumImage, FileType, Image, User
from app.db.session import get_db
from app.services import immich as immich_service
from app.services.settings_store import (
    IMMICH_API_KEY,
    IMMICH_BASE_URL,
    IMMICH_MODE_SELECTIVE,
    IMMICH_MODES,
    IMMICH_SYNC_MODE,
    IMMICH_SYNC_PAUSED,
    TRASH_RETENTION_DAYS,
    get_immich_sync_mode,
    get_immich_sync_paused,
    get_setting,
    get_trash_retention_days,
    set_setting,
)
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
        base_url=base_url, api_key_set=bool(api_key), sync_mode=get_immich_sync_mode(db)
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
    db.commit()
    # A mode/server change may make photos newly syncable (or removable) -
    # reconcile now instead of on the next timed pass.
    run_immich_sync_soon()

    api_key = get_setting(db, IMMICH_API_KEY)
    return schemas.ImmichSettingsOut(
        base_url=payload.base_url.strip(),
        api_key_set=bool(api_key),
        sync_mode=get_immich_sync_mode(db),
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
