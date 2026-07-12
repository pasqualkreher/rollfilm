import io
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_import_session
from app.auth import get_current_user
from app.config import settings
from app.db.models import Image, ImportSessionStatus, ImportStagedFile, User
from app.db.session import get_db
from app.services.import_pipeline import (
    append_uploaded_files,
    commit_import_session,
    compute_staged_pairs,
    discard_import_session,
    stage_uploaded_files,
)
from app.services.raw import extract_full_preview

LIGHTBOX_PREVIEW_PX = 2048

router = APIRouter(prefix="/import", tags=["import"])


def _to_staged_file_out(f: ImportStagedFile, paired_id: str | None = None) -> schemas.StagedFileOut:
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
        paired_staged_file_id=paired_id,
        taken_at=exif.get("taken_at"),
        camera_make=exif.get("camera_make"),
        camera_model=exif.get("camera_model"),
        width=exif.get("width"),
        height=exif.get("height"),
    )


@router.post("/sessions/upload", response_model=schemas.ImportSessionOut)
def upload_import_session(
    files: list[UploadFile] = File(...),
    source_label: str = Form("Uploaded folder"),
    session_id: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stage uploaded photos. The multipart parser rejects requests with more
    than 1000 files, so large imports are uploaded in several batches: the
    first call creates the session, follow-ups pass its `session_id` to append
    to it."""
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")
    if session_id:
        session = get_owned_import_session(db, current_user.id, session_id)
        if session.status != ImportSessionStatus.staging:
            raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
        return append_uploaded_files(db, session, current_user.id, files)
    return stage_uploaded_files(db, current_user.id, files, source_label)


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
    pairs = compute_staged_pairs(session.staged_files)
    return [_to_staged_file_out(f, pairs.get(f.id)) for f in session.staged_files]


@router.get("/sessions/{session_id}/files/{file_id}/thumbnail")
def get_staged_file_thumbnail(
    session_id: str,
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_import_session(db, current_user.id, session_id)
    thumb_path = settings.import_staging_root / session_id / ".thumbnails" / f"{file_id}.jpg"
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(thumb_path)


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

    preview = extract_full_preview(staged_full_path)
    preview.thumbnail((LIGHTBOX_PREVIEW_PX, LIGHTBOX_PREVIEW_PX))
    buf = io.BytesIO()
    preview.save(buf, "JPEG", quality=88)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


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
        # One exception: a byte-identical copy of a photo that's only *indexed
        # in place* from an external source root may be imported - the managed
        # library copy becomes the source of truth (the existing row is
        # promoted at commit, see import_pipeline.commit_import_session).
        dup_image = (
            db.get(Image, staged.duplicate_of_image_id) if staged.duplicate_of_image_id else None
        )
        duplicates_referenced_only = dup_image is not None and dup_image.source_root_id is not None
        if not duplicates_referenced_only:
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
    db.commit()
    db.refresh(staged)

    pairs = compute_staged_pairs(session.staged_files)
    return _to_staged_file_out(staged, pairs.get(staged.id))


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
    return commit_import_session(db, session, current_user.id, payload.upload_to_immich)


@router.delete("/sessions/{session_id}", status_code=204)
def discard_session(
    session_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    session = get_owned_import_session(db, current_user.id, session_id)
    if session.status != ImportSessionStatus.staging:
        raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
    discard_import_session(db, session)
