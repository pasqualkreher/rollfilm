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
from app.services import copy_jobs
from app.workers.queue import derivatives_pending, embeddings_running
from app.services.maintenance import (
    AlreadyRunning,
    RestoreError,
    build_backup_zip,
    get_rebuild_progress,
    get_repair_progress,
    missing_files_status,
    rebuild_all_thumbnails,
    remove_missing_images,
    repair_capture_dates,
    request_rebuild_cancel,
    request_repair_cancel,
    request_sync_cancel,
    restore_from_backup,
    sync_active,
    sync_db_with_library,
    wipe_library,
)
from app.api.routes.images import export_jobs_running
from app.services import db_snapshots

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


def _require_delete_confirmation(confirmation: str) -> None:
    if confirmation.strip().lower() != "delete":
        raise HTTPException(status_code=400, detail="Type 'delete' to confirm this action")


@router.post("/sync", response_model=schemas.SyncResult)
def sync_library(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    try:
        return sync_db_with_library(db, current_user.id)
    except RuntimeError as exc:
        # Library root unreachable (external drive asleep/unplugged), or a
        # sync already running - refuse with a clear message instead of
        # wiping the catalog or a bare 500.
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/missing", response_model=schemas.MissingFilesOut)
def missing_files(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Photos whose file the sync could not find, and whether the last sync
    stopped because too many were missing at once (the title bar's hint)."""
    return missing_files_status(db, current_user.id)


@router.post("/missing/remove", response_model=schemas.RemovedMissingOut)
def remove_missing(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Remove the entries of the photos marked missing - their stars, tags,
    albums and edits with them. The user's step, never the sync's."""
    return {"removed": remove_missing_images(db, current_user.id)}


@router.get("/db-snapshots", response_model=schemas.DbSnapshotsOut)
def db_snapshots_list(current_user: User = Depends(get_current_user)):
    return {
        "snapshots": db_snapshots.list_snapshots(),
        "pending_restore": db_snapshots.pending_restore(),
        "folder": str(db_snapshots.snapshot_dir()),
    }


@router.post("/db-snapshots", response_model=schemas.DbSnapshotOut)
def db_snapshot_now(current_user: User = Depends(get_current_user)):
    path = db_snapshots.take_snapshot("manual")
    if path is None:
        raise HTTPException(status_code=500, detail="The snapshot could not be written")
    entry = next((e for e in db_snapshots.list_snapshots() if e["name"] == path.name), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="The snapshot could not be listed")
    return entry


@router.post("/db-snapshots/restore", response_model=schemas.DbSnapshotRestoreOut)
def db_snapshot_restore(payload: schemas.DbSnapshotRestoreRequest, current_user: User = Depends(get_current_user)):
    """Mark a snapshot: the next start swaps it in before the database is
    opened (nothing happens to the running app)."""
    try:
        db_snapshots.schedule_restore(payload.name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No such snapshot")
    return {"pending": payload.name}


@router.delete("/db-snapshots/restore", status_code=204)
def db_snapshot_restore_cancel(current_user: User = Depends(get_current_user)):
    db_snapshots.cancel_restore()


@router.post("/sync/cancel", status_code=204)
def sync_cancel(current_user: User = Depends(get_current_user)):
    """Stop a running sync. It stops before anything is removed: a sync that
    was stopped has changed nothing (renamed files it had already followed
    keep their new path)."""
    request_sync_cancel()


@router.post("/rebuild-thumbnails", response_model=schemas.RebuildThumbnailsResult)
def rebuild_thumbnails(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    try:
        return rebuild_all_thumbnails(db, current_user.id)
    except AlreadyRunning as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/rebuild-thumbnails/cancel", response_model=schemas.RebuildProgressOut)
def rebuild_thumbnails_cancel(current_user: User = Depends(get_current_user)):
    """Stop a running rebuild. The photos in the workers' hands finish; the
    rest keep the thumbnails they have."""
    request_rebuild_cancel()
    return get_rebuild_progress()


@router.get("/rebuild-progress", response_model=schemas.RebuildProgressOut)
def rebuild_progress(current_user: User = Depends(get_current_user)):
    """Live progress of a running rebuild-all-thumbnails job, polled by the
    Settings page ("N of M photos"). Idle state has active=False."""
    return get_rebuild_progress()


@router.post("/repair-dates", response_model=schemas.RepairDatesResult)
def repair_dates(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    try:
        return repair_capture_dates(db, current_user.id)
    except AlreadyRunning as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/repair-dates/cancel", response_model=schemas.RebuildProgressOut)
def repair_dates_cancel(current_user: User = Depends(get_current_user)):
    """Stop a running date repair. The dates corrected so far are kept."""
    request_repair_cancel()
    return get_repair_progress()


@router.get("/repair-progress", response_model=schemas.RebuildProgressOut)
def repair_progress(current_user: User = Depends(get_current_user)):
    """Live progress of a running capture-date repair, same shape as the
    rebuild's."""
    return get_repair_progress()


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
    """Cannot be stopped: the backup is staged and checked first, then the
    catalog is replaced in one transaction and the files swapped in - a stop
    half-way through the swap would leave two half libraries. The task dock
    shows it without a Stop. A refused backup (bad zip, a path that escapes
    the library, a newer version) leaves the library as it was and says so."""
    _require_delete_confirmation(confirmation)
    try:
        return restore_from_backup(db, current_user.id, file)
    except RestoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/background-activity", response_model=schemas.BackgroundActivityOut)
def background_activity(current_user: User = Depends(get_current_user)):
    """What is still being computed in the background. Polled by the desktop
    shell when the user quits, so it can offer to finish first instead of
    cutting the work off mid-photo."""
    return schemas.BackgroundActivityOut(
        derivatives_pending=derivatives_pending(),
        embeddings_running=embeddings_running(),
        merge_active=get_merge_progress()["active"],
        copy_jobs_running=copy_jobs.running_count(),
        export_jobs_running=export_jobs_running(),
        maintenance_active=sync_active()
        or get_rebuild_progress()["active"]
        or get_repair_progress()["active"],
    )


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
