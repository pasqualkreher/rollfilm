from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app import schemas
from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services.library_merge import (
    MergeError,
    get_merge_progress,
    inspect_library,
    request_merge_cancel,
    start_merge,
)
from app.services.maintenance import (
    build_backup_zip,
    get_rebuild_progress,
    rebuild_all_thumbnails,
    repair_capture_dates,
    restore_from_backup,
    sync_db_with_library,
    wipe_library,
)

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


def _require_delete_confirmation(confirmation: str) -> None:
    if confirmation.strip().lower() != "delete":
        raise HTTPException(status_code=400, detail="Type 'delete' to confirm this action")


@router.post("/sync", response_model=schemas.SyncResult)
def sync_library(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    try:
        return sync_db_with_library(db, current_user.id)
    except RuntimeError as exc:
        # Library root unreachable (external drive asleep/unplugged) - refuse
        # with a clear message instead of wiping the catalog or a bare 500.
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/rebuild-thumbnails", response_model=schemas.RebuildThumbnailsResult)
def rebuild_thumbnails(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return rebuild_all_thumbnails(db, current_user.id)


@router.get("/rebuild-progress", response_model=schemas.RebuildProgressOut)
def rebuild_progress(current_user: User = Depends(get_current_user)):
    """Live progress of a running rebuild-all-thumbnails job, polled by the
    Settings page ("N of M photos"). Idle state has active=False."""
    return get_rebuild_progress()


@router.post("/repair-dates", response_model=schemas.RepairDatesResult)
def repair_dates(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return repair_capture_dates(db, current_user.id)


@router.get("/backup")
def backup(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    zip_path = build_backup_zip(db, current_user.id)
    return FileResponse(
        zip_path,
        filename="rollfilm-backup.zip",
        media_type="application/zip",
        background=BackgroundTask(zip_path.unlink),
    )


@router.post("/wipe", status_code=204)
def wipe(
    payload: schemas.DangerZoneRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_delete_confirmation(payload.confirmation)
    wipe_library(db, current_user.id)


@router.post("/restore", response_model=schemas.RestoreResult)
def restore(
    confirmation: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_delete_confirmation(confirmation)
    return restore_from_backup(db, current_user.id, file)


@router.post("/merge-library/inspect", response_model=schemas.LibraryMergeSummary)
def merge_library_inspect(
    payload: schemas.LibraryMergeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read-only look at another Rollfilm library, for the confirmation step of
    the import screen's "Import a library" section. Touches nothing."""
    try:
        return inspect_library(db, current_user.id, Path(payload.path)).as_dict()
    except MergeError as exc:
        # Written for the user (wrong folder, other app version) - pass it
        # through as the message the screen shows.
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/merge-library", response_model=schemas.LibraryMergeProgressOut, status_code=202)
def merge_library_run(
    payload: schemas.LibraryMergeRequest,
    current_user: User = Depends(get_current_user),
):
    """Start folding another library into this one, and return immediately.

    The copy runs in the background so the rest of Rollfilm stays usable while
    it works - it can be minutes or hours. Follow it through
    /merge-library/progress, which also carries the outcome once it finishes.
    Additive: the source drive is only read and nothing here is removed."""
    try:
        start_merge(current_user.id, Path(payload.path))
    except MergeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return get_merge_progress()


@router.post("/merge-library/cancel", response_model=schemas.LibraryMergeProgressOut)
def merge_library_cancel(current_user: User = Depends(get_current_user)):
    """Stop a running merge. It finishes the photo it is on and then stops;
    everything already brought over stays."""
    request_merge_cancel()
    return get_merge_progress()


@router.get("/merge-library/progress", response_model=schemas.LibraryMergeProgressOut)
def merge_library_progress(current_user: User = Depends(get_current_user)):
    return get_merge_progress()
