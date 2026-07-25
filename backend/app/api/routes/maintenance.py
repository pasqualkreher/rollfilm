from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app import schemas
from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
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
