import io
import json
import logging
import os
import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image as PILImage
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_import_session
from app.auth import get_current_user
from app.config import settings
from app.db.models import FileType, Image, ImportSessionStatus, ImportStagedFile, User
from app.db.session import get_db
from app.services.import_pipeline import (
    append_uploaded_files,
    commit_import_session,
    compute_staged_pairs,
    discard_import_session,
    ensure_session_processing,
    get_import_progress,
    stage_uploaded_files,
)
from app.services.raw import classify_file_type, extract_full_preview
from app.services.thumbnails import THUMBNAIL_MAX_PX

logger = logging.getLogger(__name__)

LIGHTBOX_PREVIEW_PX = 2048

# Staging thumbnails RAW files from the embedded camera JPEG (fast, but it has
# the camera's JPEG rendering baked in) makes a RAW card pixel-identical to its
# JPEG sibling in the review grid. Demosaiced replacements are generated lazily
# here on first request instead - same philosophy as the lightbox preview - and
# this gate keeps a grid full of RAWs from demosaicing all at once.
_RAW_THUMB_SLOTS = threading.BoundedSemaphore(min(4, max(2, (os.cpu_count() or 4) // 2)))

router = APIRouter(prefix="/import", tags=["import"])

# Staged thumbnails/previews are stable for the (short) life of a review
# session - let the browser cache them so scrolling back through a big review
# grid or re-zapping the lightbox never re-downloads. Not immutable: a RAW's
# thumb can upgrade once from the embedded fallback to the demosaiced render.
_STAGED_CACHE_HEADERS = {"Cache-Control": "private, max-age=3600"}


def _trashed_duplicate_ids(db: Session, files: list[ImportStagedFile]) -> set[str]:
    """Ids of Trash-dwelling managed images referenced by these staged files'
    exact-duplicate links, resolved in one query - the review UI shows those
    files as "restores from Trash" (importable) rather than "already in
    library" (blocked)."""
    ids = {f.duplicate_of_image_id for f in files if f.duplicate_of_image_id}
    if not ids:
        return set()
    rows = db.query(Image.id).filter(Image.id.in_(ids), Image.deleted_at.isnot(None)).all()
    return {row.id for row in rows}


def _to_staged_file_out(
    f: ImportStagedFile, paired_id: str | None = None, duplicate_in_trash: bool = False
) -> schemas.StagedFileOut:
    exif = json.loads(f.exif_json) if f.exif_json else {}
    return schemas.StagedFileOut(
        id=f.id,
        original_filename=f.original_filename,
        file_type=f.file_type,
        selected=f.selected,
        rating=f.rating,
        color_label=f.color_label,
        duplicate_of_image_id=f.duplicate_of_image_id,
        duplicate_of_staged_file_id=f.duplicate_of_staged_file_id,
        is_near_duplicate=f.is_near_duplicate,
        duplicate_in_trash=duplicate_in_trash,
        paired_staged_file_id=paired_id,
        taken_at=exif.get("taken_at"),
        camera_make=exif.get("camera_make"),
        camera_model=exif.get("camera_model"),
        width=exif.get("width"),
        height=exif.get("height"),
        immich_sync=f.immich_sync,
        processed=f.processed,
    )


# Keep this much of the disk out of reach of an import: the staged bytes are
# *moved* into the library at commit (a rename, no second copy), but the
# in-flight batch is spooled to the temp dir while it parses, and a macOS
# system volume that runs completely full takes the whole machine down with it.
_DISK_SPACE_RESERVE_BYTES = 10 * 1024**3


def _free_disk_bytes() -> int:
    return shutil.disk_usage(settings.import_staging_root).free


@router.post("/sessions/upload", response_model=schemas.ImportSessionOut)
def upload_import_session(
    files: list[UploadFile] = File(...),
    source_label: str = Form("Uploaded folder"),
    session_id: str | None = Form(None),
    total_bytes: int = Form(0),
    mtimes: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stage uploaded photos. The multipart parser rejects requests with more
    than 1000 files, so large imports are uploaded in several batches: the
    first call creates the session, follow-ups pass its `session_id` to append
    to it. `total_bytes` is the size of the *whole* planned import (all
    batches), sent by the client so the very first request can be rejected
    with a clear message when the import can never fit on the disk - instead
    of dying halfway through with what looks like a network error.

    `mtimes` is an optional JSON array of epoch seconds, aligned with `files`,
    carrying each source file's modification time (the browser's
    File.lastModified) - multipart itself doesn't transport it. Staging stamps
    it on the staged copy so photos without an EXIF capture date still sort by
    their real file date."""
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")

    if mtimes:
        try:
            parsed_mtimes = json.loads(mtimes)
        except ValueError:
            parsed_mtimes = []
        for f, m in zip(files, parsed_mtimes):
            if isinstance(m, (int, float)) and m > 0:
                f.mtime = m  # type: ignore[attr-defined]  # read via getattr in staging

    free = _free_disk_bytes()
    if not session_id and total_bytes and total_bytes + _DISK_SPACE_RESERVE_BYTES > free:
        raise HTTPException(
            status_code=507,
            detail=(
                f"Not enough disk space for this import: it needs about "
                f"{total_bytes / 1e9:.0f} GB, but only {max(free - _DISK_SPACE_RESERVE_BYTES, 0) / 1e9:.0f} GB "
                f"are usable. Free up space or import a smaller selection."
            ),
        )
    if free < _DISK_SPACE_RESERVE_BYTES:
        # Mid-import floor: something else filled the disk since the preflight
        # (or an old client didn't send total_bytes) - stop cleanly now rather
        # than letting a staging write fail halfway through a batch.
        raise HTTPException(
            status_code=507,
            detail="The disk is almost full - the import was stopped so the system stays usable.",
        )

    if session_id:
        session = get_owned_import_session(db, current_user.id, session_id)
        if session.status != ImportSessionStatus.staging:
            raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
        return append_uploaded_files(db, session, current_user.id, files)
    return stage_uploaded_files(db, current_user.id, files, source_label)


class _LocalUpload:
    """Presents a file already on local disk through the same structural
    interface as FastAPI's UploadFile (filename + file), so the direct folder
    import reuses the staging pipeline of the HTTP upload unchanged. `mtime`
    lets staging preserve the source file's modification time (the capture-date
    fallback for files without EXIF)."""

    def __init__(self, path: Path):
        self.filename = path.name
        self.file = path.open("rb")
        try:
            self.mtime: float | None = path.stat().st_mtime
        except OSError:
            self.mtime = None


@router.post("/scan-folder", response_model=schemas.FolderScanOut)
def scan_folder(
    payload: schemas.FolderScanRequest,
    current_user: User = Depends(get_current_user),
):
    """List the importable photos under a local folder, for the desktop app's
    direct import: the renderer picks a folder via the native dialog, and the
    backend - which runs on the same machine - reads the files itself instead
    of pumping them through a browser upload. (Like the rest of the API this
    trusts its caller; the backend binds to localhost for exactly that reason.)"""
    root = Path(payload.path)
    if not root.is_absolute() or not root.is_dir():
        raise HTTPException(status_code=400, detail="Not a folder that exists on this machine")

    library_root = settings.library_root.resolve()
    files: list[schemas.ScannedFileOut] = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # Never descend into hidden folders (.photomanager holds the app's own
        # database/staging) or into the library itself - scanning the library's
        # parent folder must not re-import the whole library.
        dirnames[:] = [
            d
            for d in dirnames
            if not d.startswith(".") and (Path(dirpath) / d).resolve() != library_root
        ]
        for name in sorted(filenames):
            if name.startswith(".") or classify_file_type(Path(name)) is None:
                continue
            p = Path(dirpath) / name
            try:
                size = p.stat().st_size
            except OSError:
                continue  # unreadable/vanished - skip rather than fail the scan
            files.append(schemas.ScannedFileOut(path=str(p), name=name, size=size))
            total += size
    return schemas.FolderScanOut(files=files, total_bytes=total)


@router.post("/sessions/stage-paths", response_model=schemas.ImportSessionOut)
def stage_local_paths(
    payload: schemas.StagePathsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stage one batch of a direct folder import (see scan_folder). Same
    batching contract and disk preflight as the multipart upload route."""
    if not payload.paths:
        raise HTTPException(status_code=400, detail="No files given")

    free = _free_disk_bytes()
    if (
        not payload.session_id
        and payload.total_bytes
        and payload.total_bytes + _DISK_SPACE_RESERVE_BYTES > free
    ):
        raise HTTPException(
            status_code=507,
            detail=(
                f"Not enough disk space for this import: it needs about "
                f"{payload.total_bytes / 1e9:.0f} GB, but only "
                f"{max(free - _DISK_SPACE_RESERVE_BYTES, 0) / 1e9:.0f} GB are usable."
            ),
        )
    if free < _DISK_SPACE_RESERVE_BYTES:
        raise HTTPException(
            status_code=507,
            detail="The disk is almost full - the import was stopped so the system stays usable.",
        )

    uploads: list[_LocalUpload] = []
    try:
        for path_str in payload.paths:
            p = Path(path_str)
            try:
                if p.is_absolute() and p.is_file():
                    uploads.append(_LocalUpload(p))
            except OSError:
                continue  # vanished between scan and stage - skip
        if not uploads:
            raise HTTPException(status_code=400, detail="None of the given files are readable")
        if len(uploads) < len(payload.paths):
            logger.warning(
                "folder import: %d of %d files vanished between scan and staging",
                len(payload.paths) - len(uploads),
                len(payload.paths),
            )

        if payload.session_id:
            session = get_owned_import_session(db, current_user.id, payload.session_id)
            if session.status != ImportSessionStatus.staging:
                raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
            return append_uploaded_files(db, session, current_user.id, uploads)
        return stage_uploaded_files(db, current_user.id, uploads, payload.source_label)
    finally:
        for u in uploads:
            try:
                u.file.close()
            except OSError:
                pass


@router.get("/sessions/{session_id}", response_model=schemas.ImportSessionOut)
def get_import_session(
    session_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return get_owned_import_session(db, current_user.id, session_id)


@router.get("/sessions/{session_id}/files", response_model=list[schemas.StagedFileOut])
def list_staged_files(
    session_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    session = get_owned_import_session(db, current_user.id, session_id)
    # Self-healing: if the backend restarted mid-analysis (the worker queue is
    # in-memory), re-enqueue whatever is still unprocessed. The review screen
    # polls this route, so a stuck session recovers as soon as it's looked at.
    ensure_session_processing(session)
    pairs = compute_staged_pairs(session.staged_files)
    trashed = _trashed_duplicate_ids(db, session.staged_files)
    return [
        _to_staged_file_out(f, pairs.get(f.id), f.duplicate_of_image_id in trashed)
        for f in session.staged_files
    ]


@router.get("/sessions/{session_id}/files/{file_id}/thumbnail")
def get_staged_file_thumbnail(
    session_id: str,
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_import_session(db, current_user.id, session_id)
    thumb_dir = settings.import_staging_root / session_id / ".thumbnails"

    # RAW cards get a demosaiced thumbnail so they look like the actual sensor
    # data (as in the library) instead of the camera-rendered embedded JPEG,
    # which is indistinguishable from the JPEG sibling's card. Generated lazily
    # and cached; any failure falls back to the staging-time embedded thumb.
    staged = db.get(ImportStagedFile, file_id)
    if staged is not None and staged.import_session_id == session_id and staged.file_type == FileType.raw:
        demosaic_path = thumb_dir / f"{file_id}.demosaic.jpg"
        if not demosaic_path.exists():
            source_path = settings.import_staging_root / staged.staged_path
            if source_path.exists():
                try:
                    with _RAW_THUMB_SLOTS:
                        if not demosaic_path.exists():
                            preview = extract_full_preview(source_path)
                            # Match the staging thumb's sizing: a quarter of the
                            # original (the demosaic is half-size, so half of it),
                            # capped like the library's grid thumbnails.
                            tw = min(max(1, round(preview.width * 0.5)), THUMBNAIL_MAX_PX)
                            th = min(max(1, round(preview.height * 0.5)), THUMBNAIL_MAX_PX)
                            preview.thumbnail((tw, th), PILImage.LANCZOS)
                            tmp_path = thumb_dir / f"{file_id}.demosaic.tmp"
                            preview.save(tmp_path, "JPEG", quality=88)
                            os.replace(tmp_path, demosaic_path)
                except Exception:
                    logger.exception("Demosaiced staging thumbnail failed for %s", staged.original_filename)
        if demosaic_path.exists():
            return FileResponse(demosaic_path, headers=_STAGED_CACHE_HEADERS)

    thumb_path = thumb_dir / f"{file_id}.jpg"
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(thumb_path, headers=_STAGED_CACHE_HEADERS)


@router.get("/sessions/{session_id}/files/{file_id}/preview")
def get_staged_file_preview(
    session_id: str,
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Larger on-demand preview for zapping through staged photos in the
    import review lightbox - generated lazily per-request rather than for
    every staged file up front, so staging a big card stays fast."""
    get_owned_import_session(db, current_user.id, session_id)
    staged = db.get(ImportStagedFile, file_id)
    if staged is None or staged.import_session_id != session_id:
        raise HTTPException(status_code=404, detail="Staged file not found")

    staged_full_path = settings.import_staging_root / staged.staged_path
    if not staged_full_path.exists():
        raise HTTPException(status_code=404, detail="Staged file missing from disk")

    # A damaged file must not take the request down with a 500 - the lightbox
    # shows a clean "can't display" state on 404 and the review keeps working.
    try:
        preview = extract_full_preview(staged_full_path)
    except Exception:
        logger.exception("Staged preview render failed for %s", staged.original_filename)
        raise HTTPException(status_code=404, detail="Preview could not be rendered")
    preview.thumbnail((LIGHTBOX_PREVIEW_PX, LIGHTBOX_PREVIEW_PX))
    buf = io.BytesIO()
    preview.save(buf, "JPEG", quality=88)
    # Rendered on demand (RAW decode!) - caching saves the full re-render when
    # the user zaps back to a photo in the lightbox.
    return Response(
        content=buf.getvalue(), media_type="image/jpeg", headers=_STAGED_CACHE_HEADERS
    )


@router.patch("/sessions/{session_id}/files/{file_id}", response_model=schemas.StagedFileOut)
def update_staged_file(
    session_id: str,
    file_id: str,
    payload: schemas.StagedFileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = get_owned_import_session(db, current_user.id, session_id)
    staged = db.get(ImportStagedFile, file_id)
    if staged is None or staged.import_session_id != session_id:
        raise HTTPException(status_code=404, detail="Staged file not found")

    is_exact_duplicate = (
        staged.duplicate_of_image_id or staged.duplicate_of_staged_file_id
    ) and not staged.is_near_duplicate
    if payload.selected and is_exact_duplicate:
        # Two exceptions: a byte-identical copy of a photo that's only *indexed
        # in place* from an external source root may be imported (the managed
        # library copy becomes the source of truth - the existing row is
        # promoted at commit), and a copy of a photo sitting in the Trash may
        # be imported to restore it (see import_pipeline.commit_import_session).
        dup_image = (
            db.get(Image, staged.duplicate_of_image_id) if staged.duplicate_of_image_id else None
        )
        reimportable = dup_image is not None and (
            dup_image.source_root_id is not None or dup_image.deleted_at is not None
        )
        if not reimportable:
            raise HTTPException(
                status_code=400,
                detail="This file is byte-identical to another photo (already in your library, or elsewhere in "
                "this batch) and can't be imported again.",
            )

    if payload.selected is not None:
        staged.selected = payload.selected
    if payload.rating is not None:
        staged.rating = payload.rating
    if payload.color_label is not None:
        staged.color_label = payload.color_label
    if payload.immich_sync is not None:
        staged.immich_sync = payload.immich_sync
    db.commit()
    db.refresh(staged)

    pairs = compute_staged_pairs(session.staged_files)
    trashed = _trashed_duplicate_ids(db, [staged])
    return _to_staged_file_out(staged, pairs.get(staged.id), staged.duplicate_of_image_id in trashed)


@router.patch("/sessions/{session_id}/files", response_model=list[schemas.StagedFileOut])
def bulk_update_staged_files(
    session_id: str,
    payload: schemas.StagedFilesBulkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Apply one patch to many staged files at once (select all / range select /
    flag-for-sync). One transaction instead of a request per file. Files that
    can't take the change (exact duplicates being selected) are skipped rather
    than failing the whole batch - mirroring what the per-file UI allows."""
    session = get_owned_import_session(db, current_user.id, session_id)
    by_id = {f.id: f for f in session.staged_files}
    for file_id in payload.file_ids:
        staged = by_id.get(file_id)
        if staged is None:
            continue
        if payload.selected is not None:
            is_exact_duplicate = (
                staged.duplicate_of_image_id or staged.duplicate_of_staged_file_id
            ) and not staged.is_near_duplicate
            allowed = not payload.selected or not is_exact_duplicate
            if not allowed and staged.duplicate_of_image_id:
                # Same exceptions as the per-file route: source-root promotions
                # and restores from the Trash may be (re)selected.
                dup_image = db.get(Image, staged.duplicate_of_image_id)
                allowed = dup_image is not None and (
                    dup_image.source_root_id is not None or dup_image.deleted_at is not None
                )
            if allowed:
                staged.selected = payload.selected
        if payload.rating is not None:
            staged.rating = payload.rating
        if payload.color_label is not None:
            staged.color_label = payload.color_label
        if payload.immich_sync is not None:
            staged.immich_sync = payload.immich_sync
    db.commit()
    db.refresh(session)
    pairs = compute_staged_pairs(session.staged_files)
    trashed = _trashed_duplicate_ids(db, session.staged_files)
    return [
        _to_staged_file_out(f, pairs.get(f.id), f.duplicate_of_image_id in trashed)
        for f in session.staged_files
    ]


@router.post("/sessions/{session_id}/commit", response_model=list[schemas.ImageOut])
def commit_session(
    session_id: str,
    payload: schemas.CommitImportRequest = schemas.CommitImportRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = get_owned_import_session(db, current_user.id, session_id)
    if session.status != ImportSessionStatus.staging:
        raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
    unprocessed = sum(1 for f in session.staged_files if not f.processed)
    if unprocessed:
        # Copying finished but the background analysis hasn't - committing now
        # would import files whose duplicate checks and metadata aren't done.
        # (Kick the queue too, in case the backend restarted mid-analysis.)
        ensure_session_processing(session)
        raise HTTPException(
            status_code=409,
            detail=f"{unprocessed} photo(s) are still being analyzed - wait a moment and try again.",
        )
    return commit_import_session(
        db,
        session,
        current_user.id,
        payload.upload_to_immich,
        sync_all_to_immich=payload.sync_all_to_immich,
    )


@router.get("/sessions/{session_id}/progress", response_model=schemas.ImportProgressOut)
def import_session_progress(
    session_id: str, current_user: User = Depends(get_current_user)
):
    """Live staging/commit progress for the UI's ETA. Reads only in-memory
    counters (no DB) so polling it never contends with the write transaction the
    commit itself is holding. Single-user app, so no per-session ownership check."""
    progress = get_import_progress(session_id)
    if progress is None:
        return schemas.ImportProgressOut(phase="idle", processed=0, total=0, eta_seconds=None)
    return schemas.ImportProgressOut(**progress)


@router.delete("/sessions/{session_id}", status_code=204)
def discard_session(
    session_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    session = get_owned_import_session(db, current_user.id, session_id)
    if session.status != ImportSessionStatus.staging:
        raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
    discard_import_session(db, session)
