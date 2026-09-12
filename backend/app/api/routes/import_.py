import io
import itertools
import json
import logging
import os
import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app import schemas
from app.api.deps import get_owned_import_session
from app.auth import get_current_user
from app.config import settings
from app.db.models import (
    FileType,
    Image,
    ImportSession,
    ImportSessionSource,
    ImportSessionStatus,
    ImportStagedFile,
    User,
)
from app.db.session import get_db
from app.services.import_pipeline import (
    STAGED_PREVIEW_PX,
    StagedFullSuperseded,
    append_uploaded_files,
    commit_import_session,
    compute_staged_pairs,
    create_import_session,
    discard_import_session,
    ensure_session_processing,
    get_import_progress,
    render_review_derivatives,
    render_staged_full,
    stage_uploaded_files,
    staged_demosaic_path,
    staged_preview_path,
    staged_thumb_dir,
)
from app.services.borg_backup import run_backup_soon
from app.services.raw import classify_file_type, extract_full_preview
from app.services.thumbnails import derivative_path
from app.services.volumes import resolve_source_root, volume_of

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import", tags=["import"])

# Staged thumbnails/previews are stable for the (short) life of a review
# session - let the browser cache them so scrolling back through a big review
# grid or re-zapping the lightbox never re-downloads. Not immutable: a RAW's
# thumb can upgrade once from the embedded fallback to the demosaiced render.
_STAGED_CACHE_HEADERS = {"Cache-Control": "private, max-age=3600"}

# The full-resolution render, unlike the thumbnail, never changes for the life
# of the staged file - so it may be cached hard. Without this, every re-zoom of
# the same photo re-downloaded multiple megabytes.
_STAGED_FULL_CACHE_HEADERS = {"Cache-Control": "private, max-age=31536000, immutable"}


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
        duplicate_in_trash=duplicate_in_trash,
        paired_staged_file_id=paired_id,
        taken_at=exif.get("taken_at"),
        camera_make=exif.get("camera_make"),
        camera_model=exif.get("camera_model"),
        width=exif.get("width"),
        height=exif.get("height"),
        immich_sync=f.immich_sync,
        imported=f.imported,
        processed=f.processed,
    )


def _imported_derivative(staged: ImportStagedFile, name: str) -> Path | None:
    """A file an earlier partial import already committed has no staged copy
    or review renders any more - they moved into the library with it. Its
    card and preview are served from the photo it became instead."""
    if not staged.duplicate_of_image_id:
        return None
    path = derivative_path(staged.duplicate_of_image_id) / name
    return path if path.exists() else None


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
    fallback for files without EXIF).

    `source_path` is what an HTTP upload can't offer: the original sits on a
    readable path rather than only in the request body, so the background
    analysis can read it there instead of on the staged copy - keeping those
    reads off the disk the import is copying to."""

    def __init__(self, path: Path):
        self.filename = path.name
        self.file = path.open("rb")
        self.source_path = path
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
    files = _scan_importable(root)
    return schemas.FolderScanOut(files=files, total_bytes=sum(f.size for f in files))


def _scan_importable(root: Path) -> list[schemas.ScannedFileOut]:
    library_root = settings.library_root.resolve()
    files: list[schemas.ScannedFileOut] = []
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
    return files


def _match_source(session: ImportSession, root: Path) -> ImportSessionSource | None:
    """The session's source for this folder, if it has one. Matched by path
    first, then by volume: the same card remounted under another name is the
    same source, and must not become a second one."""
    for source in session.sources:
        if source.root == str(root):
            return source
    for source in session.sources:
        if resolve_source_root(source.root, source.volume_mount, source.volume_uuid) == root:
            return source
    return None


def _source_row(
    db: Session, session: ImportSession, root: Path, file_count: int | None
) -> ImportSessionSource:
    """The session's source row for this folder, created the first time it is
    staged from. A session can have several - the card it was started on, a
    second card, a folder added later - and each is continued on its own. The
    volume identity recorded here is what finds a card again when it comes back
    under another mount name (see services/volumes.py)."""
    existing = _match_source(session, root)
    if existing is not None:
        # Remounted under another name: follow it, so the files staged now are
        # recorded under the same source as the ones staged before.
        existing.root = str(root)
        if file_count is not None:
            existing.file_count = file_count
        db.commit()
        return existing
    info = volume_of(root)
    source = ImportSessionSource(
        import_session_id=session.id,
        label=root.name or str(root),
        root=str(root),
        volume_mount=info.mount if info else None,
        volume_uuid=info.uuid if info else None,
        volume_name=info.name if info else None,
        file_count=file_count,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


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

        source_root = Path(payload.source_root) if payload.source_root else None
        if source_root is not None and not (source_root.is_absolute() and source_root.is_dir()):
            source_root = None

        if payload.session_id:
            session = get_owned_import_session(db, current_user.id, payload.session_id)
            if session.status != ImportSessionStatus.staging:
                raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")
        else:
            # Created before the first batch so its source row exists to stage
            # against (every staged file records which source it came from).
            session = create_import_session(db, current_user.id, payload.source_label)
        source = (
            _source_row(db, session, source_root, payload.source_file_count)
            if source_root is not None
            else None
        )
        return append_uploaded_files(
            db,
            session,
            current_user.id,
            uploads,
            (source.id, source.root) if source is not None else None,
        )
    finally:
        for u in uploads:
            try:
                u.file.close()
            except OSError:
                pass


@router.get("/sessions", response_model=list[schemas.ImportSessionSummaryOut])
def list_open_sessions(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Every import session still open, most recently worked on first - the
    Import page lists them to continue. Counted in SQL: a long-lived session
    holds thousands of rows, and this must not load them all per session."""
    sessions = (
        db.query(ImportSession)
        .filter(
            ImportSession.owner_id == current_user.id,
            ImportSession.status == ImportSessionStatus.staging,
        )
        .all()
    )
    counts: dict[str, tuple] = {}
    copied_per_source: dict[str, int] = {}
    if sessions:
        f = ImportStagedFile
        duplicate = or_(f.duplicate_of_image_id.isnot(None), f.duplicate_of_staged_file_id.isnot(None))
        session_ids = [s.id for s in sessions]

        def _n(cond):
            return func.sum(case((cond, 1), else_=0))

        rows = (
            db.query(
                f.import_session_id,
                func.count(f.id),
                _n(f.imported.is_(True)),
                _n(and_(f.imported.is_(False), duplicate)),
                _n(f.selected.is_(True)),
                _n(f.processed.is_(False)),
            )
            .filter(f.import_session_id.in_(session_ids))
            .group_by(f.import_session_id)
            .all()
        )
        counts = {row[0]: tuple(int(v or 0) for v in row[1:]) for row in rows}
        copied_per_source = {
            row[0]: int(row[1])
            for row in db.query(f.source_id, func.count(f.id))
            .filter(f.import_session_id.in_(session_ids), f.source_id.isnot(None))
            .group_by(f.source_id)
            .all()
        }

    out: list[schemas.ImportSessionSummaryOut] = []
    for s in sessions:
        total, imported, duplicates, selected, pending = counts.get(s.id, (0,) * 5)
        out.append(
            schemas.ImportSessionSummaryOut(
                id=s.id,
                source_path=s.source_path,
                created_at=s.created_at,
                updated_at=s.updated_at,
                file_count=total,
                imported_count=imported,
                duplicate_count=duplicates,
                selected_count=selected,
                pending_count=pending,
                sources=[_to_source_out(src, copied_per_source.get(src.id, 0)) for src in s.sources],
            )
        )
    out.sort(key=lambda o: o.updated_at or o.created_at, reverse=True)
    return out


def _to_source_out(source: ImportSessionSource, copied: int) -> schemas.ImportSourceOut:
    current = resolve_source_root(source.root, source.volume_mount, source.volume_uuid)
    return schemas.ImportSourceOut(
        id=source.id,
        label=source.label,
        root=source.root,
        current_root=str(current) if current is not None else None,
        volume_name=source.volume_name,
        available=current is not None,
        copied=copied,
        remaining=(max(0, source.file_count - copied) if source.file_count is not None else None),
    )


@router.post("/sessions/{session_id}/rescan", response_model=schemas.ImportSessionRescanOut)
def rescan_session_sources(
    session_id: str,
    payload: schemas.ImportRescanRequest = schemas.ImportRescanRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What of the session's sources isn't copied yet.

    Continuing a session scans every source it has; passing `path` scans that
    one folder instead - what adding it to the session would bring in, or, if
    it is already a source, only what is missing from it. Files are matched by
    their place under the source and their size, so nothing is copied twice;
    photos shot onto the card since the last scan show up here. The client
    stages the result through stage-paths with the session's id."""
    session = get_owned_import_session(db, current_user.id, session_id)
    if session.status != ImportSessionStatus.staging:
        raise HTTPException(status_code=400, detail=f"Session already {session.status.value}")

    # (source row or None for a folder not in the session yet, where to scan)
    targets: list[tuple[ImportSessionSource | None, Path | None]] = []
    if payload.path:
        picked = Path(payload.path)
        if not (picked.is_absolute() and picked.is_dir()):
            raise HTTPException(status_code=400, detail="Not a folder that exists on this machine")
        targets.append((_match_source(session, picked), picked))
    else:
        targets = [
            (s, resolve_source_root(s.root, s.volume_mount, s.volume_uuid)) for s in session.sources
        ]

    out: list[schemas.ImportRescanSourceOut] = []
    for source, root in targets:
        if root is None:
            # Not connected: say so, and keep the counts from its last scan.
            out.append(
                schemas.ImportRescanSourceOut(
                    id=source.id,
                    label=source.label,
                    root=source.root,
                    available=False,
                    files=[],
                    total_bytes=0,
                    file_count=source.file_count,
                )
            )
            continue

        copied = [f for f in session.staged_files if source is not None and f.source_id == source.id]
        known = {(f.source_relpath, f.source_size) for f in copied}
        new = [
            f
            for f in _scan_importable(root)
            if (Path(f.path).relative_to(root).as_posix(), f.size) not in known
        ]
        # Counted so "still to copy" is exactly what this scan found missing,
        # shrinking as those files land (see list_open_sessions).
        file_count = len(copied) + len(new)
        if source is not None:
            source.file_count = file_count
            if str(root) != source.root:
                # The card is back under another mount name - remember where.
                info = volume_of(root)
                source.root = str(root)
                if info is not None:
                    source.volume_mount = info.mount
        out.append(
            schemas.ImportRescanSourceOut(
                id=source.id if source is not None else None,
                label=source.label if source is not None else (root.name or str(root)),
                root=str(root),
                available=True,
                files=new,
                total_bytes=sum(f.size for f in new),
                file_count=file_count,
            )
        )
    db.commit()
    return schemas.ImportSessionRescanOut(sources=out)


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
    thumb_dir = staged_thumb_dir(session_id)

    staged = db.get(ImportStagedFile, file_id)
    if staged is not None and staged.import_session_id == session_id and staged.imported:
        library_thumb = _imported_derivative(staged, "thumbnail.jpg")
        if library_thumb is None:
            raise HTTPException(status_code=404, detail="Thumbnail not found")
        return FileResponse(library_thumb, headers=_STAGED_CACHE_HEADERS)

    # RAW cards get a demosaiced thumbnail so they look like the actual sensor
    # data (as in the library) instead of the camera-rendered embedded JPEG,
    # which is indistinguishable from the JPEG sibling's card. The background
    # pass produces these during the import, so this is normally a plain file
    # read; the render below only covers what it hasn't reached (or couldn't
    # do), and any failure falls back to the staging-time embedded thumb.
    if staged is not None and staged.import_session_id == session_id and staged.file_type == FileType.raw:
        demosaic_path = staged_demosaic_path(thumb_dir, file_id)
        if not demosaic_path.exists():
            source_path = settings.import_staging_root / staged.staged_path
            if source_path.exists():
                try:
                    # Thumbnail only: a grid scroll must not queue behind the
                    # much larger lightbox preview for a photo nobody opened.
                    render_review_derivatives(
                        source_path, file_id, thumb_dir, is_raw=True, want_preview=False
                    )
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
    """Larger preview for zapping through staged photos in the import review
    lightbox.

    Normally a plain file read: the import renders this for every staged file
    in the background (see render_review_derivatives), which is what keeps
    opening a card instant - decoding the original on the spot costs a few
    hundred milliseconds for a big JPEG and well over a second for a RAW.
    Whatever that pass hasn't reached yet is rendered on first request and
    kept, so at worst one viewer waits for it once."""
    get_owned_import_session(db, current_user.id, session_id)
    staged = db.get(ImportStagedFile, file_id)
    if staged is None or staged.import_session_id != session_id:
        raise HTTPException(status_code=404, detail="Staged file not found")
    if staged.imported:
        library_preview = _imported_derivative(staged, "preview.jpg")
        if library_preview is None:
            raise HTTPException(status_code=404, detail="Preview not found")
        return FileResponse(library_preview, headers=_STAGED_CACHE_HEADERS)

    thumb_dir = staged_thumb_dir(session_id)
    preview_path = staged_preview_path(thumb_dir, file_id)
    if preview_path.exists():
        return FileResponse(preview_path, headers=_STAGED_CACHE_HEADERS)

    staged_full_path = settings.import_staging_root / staged.staged_path
    if not staged_full_path.exists():
        raise HTTPException(status_code=404, detail="Staged file missing from disk")

    is_raw = staged.file_type == FileType.raw
    # A damaged file must not take the request down with a 500 - the lightbox
    # shows a clean "can't display" state on 404 and the review keeps working.
    try:
        # Shares the render gate with the background pass (and produces a RAW's
        # grid thumbnail in the same decode, if that pass hasn't got there yet).
        render_review_derivatives(staged_full_path, file_id, thumb_dir, is_raw=is_raw)
    except Exception:
        logger.exception("Staged preview render failed for %s", staged.original_filename)
    if preview_path.exists():
        return FileResponse(preview_path, headers=_STAGED_CACHE_HEADERS)

    # It couldn't be written (the session folder vanished under us, disk full):
    # render once into memory so the review still shows the photo.
    try:
        preview = extract_full_preview(staged_full_path)
    except Exception:
        logger.exception("Staged preview render failed for %s", staged.original_filename)
        raise HTTPException(status_code=404, detail="Preview could not be rendered")
    preview.thumbnail((STAGED_PREVIEW_PX, STAGED_PREVIEW_PX))
    buf = io.BytesIO()
    preview.save(buf, "JPEG", quality=88)
    return Response(
        content=buf.getvalue(), media_type="image/jpeg", headers=_STAGED_CACHE_HEADERS
    )


# Only the newest 100%-zoom request can still be on screen: the review lightbox
# shows one photo at a time. Each uncached request marks itself newest, so an
# older RAW render still queued behind the single render slot bails (409) for a
# photo the user has already zapped past, instead of making them wait behind it.
# Same mechanism as the library lightbox's /full route.
_staged_full_zoom_seq = itertools.count(1)
_staged_full_zoom_latest = 0
_staged_full_zoom_lock = threading.Lock()


@router.get("/sessions/{session_id}/files/{file_id}/full")
def get_staged_file_full(
    session_id: str,
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full-resolution pixels of a staged file, for true 100% zoom in the import
    review lightbox.

    The lightbox shows the 2048px preview while the photo is at fit size and
    asks for this only once the user zooms in - so culling an import inspects
    real pixels (critical focus) exactly like browsing the library does, without
    paying a full render for every photo that is merely looked at."""
    global _staged_full_zoom_latest
    get_owned_import_session(db, current_user.id, session_id)
    staged = db.get(ImportStagedFile, file_id)
    if staged is None or staged.import_session_id != session_id:
        raise HTTPException(status_code=404, detail="Staged file not found")
    if staged.imported:
        # Its bytes are in the library now. A JPEG is its own full size; a RAW
        # isn't rendered again here - the lightbox stays on the preview.
        image = db.get(Image, staged.duplicate_of_image_id) if staged.duplicate_of_image_id else None
        library_file = settings.library_root / image.file_path if image else None
        if staged.file_type == FileType.raw or library_file is None or not library_file.exists():
            raise HTTPException(status_code=404, detail="Full-resolution image not available")
        return FileResponse(library_file, headers=_STAGED_FULL_CACHE_HEADERS)

    source_path = settings.import_staging_root / staged.staged_path
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Staged file missing from disk")

    # A staged JPEG/PNG already *is* the full resolution - hand the original
    # bytes over rather than re-encoding them into a second copy on the staging
    # disk (the browser applies its EXIF orientation, as it does for any image).
    # Only a RAW has to be rendered.
    if staged.file_type != FileType.raw:
        return FileResponse(source_path, headers=_STAGED_FULL_CACHE_HEADERS)

    # Claim "newest zoom" even for a cached serve: the user is now looking at
    # this photo, so a render still queued for the previous one should die.
    with _staged_full_zoom_lock:
        seq = next(_staged_full_zoom_seq)
        _staged_full_zoom_latest = seq

    def _is_stale() -> bool:
        with _staged_full_zoom_lock:
            return _staged_full_zoom_latest != seq

    try:
        full_path = render_staged_full(
            source_path, file_id, staged_thumb_dir(session_id), is_stale=_is_stale
        )
    except StagedFullSuperseded:
        # The client aborted this fetch when the user moved on; the status only
        # matters to anything that still happens to be listening.
        raise HTTPException(status_code=409, detail="Superseded by a newer full-resolution request")
    except Exception:
        # A damaged file must not 500 - the lightbox falls back to the preview.
        logger.exception("Staged full render failed for %s", staged.original_filename)
        raise HTTPException(status_code=404, detail="Full-resolution image not available")
    return FileResponse(full_path, headers=_STAGED_FULL_CACHE_HEADERS)


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

    is_duplicate = bool(
        staged.duplicate_of_image_id or staged.duplicate_of_staged_file_id or staged.imported
    )
    if payload.selected and is_duplicate:
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
            is_duplicate = bool(
                staged.duplicate_of_image_id
                or staged.duplicate_of_staged_file_id
                or staged.imported
            )
            allowed = not payload.selected or not is_duplicate
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
    result = commit_import_session(
        db,
        session,
        current_user.id,
        payload.upload_to_immich,
        sync_all_to_immich=payload.sync_all_to_immich,
    )
    # New photos landed in the library - schedule an incremental Borg backup
    # (debounced; a no-op unless the user configured one in Settings).
    run_backup_soon()
    return result


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
