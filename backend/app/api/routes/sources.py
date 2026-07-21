import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.auth import get_current_user
from app.db.models import Image, ImportStagedFile, SourceRoot, User
from app.db.session import get_db
from app.services import sources as sources_service
from app.services.thumbnails import derivative_dir

router = APIRouter(prefix="/sources", tags=["sources"])

# Where the folder picker starts. /hostfs and /sources are legacy container
# mount points (kept so old setups still resolve); the desktop app falls back to
# the filesystem root. From the start point the user can navigate to any folder
# the backend can see.
FS_ROOT = Path("/")
BROWSE_START_CANDIDATES = [Path("/hostfs"), Path("/sources")]


def _default_browse_start() -> Path:
    for candidate in BROWSE_START_CANDIDATES:
        if candidate.is_dir():
            return candidate
    return FS_ROOT


def _to_source_out(db: Session, source: SourceRoot) -> schemas.SourceRootOut:
    count = (
        db.query(func.count(Image.id)).filter(Image.source_root_id == source.id).scalar() or 0
    )
    status = sources_service.get_scan_status(source.id)
    return schemas.SourceRootOut(
        id=source.id,
        name=source.name,
        path=source.path,
        created_at=source.created_at,
        last_scanned_at=source.last_scanned_at,
        image_count=count,
        scanning=bool(status.get("running")),
        available=sources_service.is_path_available(source.path),
    )


@router.get("", response_model=list[schemas.SourceRootOut])
def list_sources(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    sources = (
        db.query(SourceRoot)
        .filter(SourceRoot.owner_id == current_user.id)
        .order_by(SourceRoot.created_at.desc())
        .all()
    )
    return [_to_source_out(db, s) for s in sources]


@router.get("/browse", response_model=schemas.DirListing)
def browse_directories(
    path: str | None = None, current_user: User = Depends(get_current_user)
):
    """Server-side folder picker: lists the sub-directories of `path` so the
    user can navigate the backend's filesystem and pick a folder to index
    without typing a path. Navigation goes all the way up to `/` so any mounted
    location (a NAS, another volume) is reachable, not just the default mount."""
    if path:
        target = Path(path).resolve()
    else:
        target = _default_browse_start()

    if not target.is_dir():
        return schemas.DirListing(path=str(target), parent=None, exists=False, entries=[])

    entries: list[schemas.DirEntry] = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith("."):
                continue
            try:
                if child.is_dir():
                    entries.append(schemas.DirEntry(name=child.name, path=str(child)))
            except OSError:
                # Broken symlink / unreadable entry - just skip it.
                continue
    except PermissionError:
        pass

    parent = str(target.parent) if target != FS_ROOT else None
    return schemas.DirListing(path=str(target), parent=parent, exists=True, entries=entries)


@router.post("", response_model=schemas.SourceRootOut)
def add_source(
    payload: schemas.SourceRootCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    path = payload.path.strip()
    name = payload.name.strip() or path
    if not path:
        raise HTTPException(status_code=400, detail="A folder path is required")
    if not Path(path).is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"'{path}' is not a folder the app can see. Check that the drive is "
            "connected and the path is spelled correctly.",
        )
    existing = (
        db.query(SourceRoot)
        .filter(SourceRoot.owner_id == current_user.id, SourceRoot.path == path)
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="That folder is already registered as a source")

    source = SourceRoot(owner_id=current_user.id, name=name, path=path)
    db.add(source)
    db.commit()
    db.refresh(source)

    # Index it straight away so the photos show up without a manual step.
    sources_service.start_scan(source.id, include_excluded=True)
    return _to_source_out(db, source)


@router.post("/{source_id}/scan", response_model=schemas.ScanStatusOut)
def scan_source(
    source_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    source = db.get(SourceRoot, source_id)
    if source is None or source.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Source not found")
    # An explicit "Scan now" means "index this folder again, all of it" - it
    # also brings back photos previously deleted from this source. Only the
    # automatic startup scan preserves those deletions.
    sources_service.start_scan(source.id, include_excluded=True)
    return schemas.ScanStatusOut(**sources_service.get_scan_status(source.id))


@router.get("/{source_id}/scan-status", response_model=schemas.ScanStatusOut)
def scan_status(
    source_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    source = db.get(SourceRoot, source_id)
    if source is None or source.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Source not found")
    return schemas.ScanStatusOut(**sources_service.get_scan_status(source.id))


@router.delete("/{source_id}", status_code=204)
def remove_source(
    source_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Removes the source and the library entries indexed from it. The original
    files on the source (NAS/folder) are never touched - only our DB rows and
    cached thumbnails."""
    source = db.get(SourceRoot, source_id)
    if source is None or source.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    images = db.query(Image).filter(Image.source_root_id == source.id).all()
    image_ids = [image.id for image in images]

    # Clear every foreign key that points at the rows we're about to delete, or
    # SQLite's FK check aborts the DELETE. These are all nullable pointers, so
    # nulling them just detaches the reference without removing other data:
    #   1. RAW/JPEG pairing links - both the deleted rows' own paired_image_id
    #      (a pair where *both* halves live in this source references itself)
    #      and any external sibling still pointing back in.
    #   2. Import staged files that recorded one of these images as a duplicate.
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
        shutil.rmtree(derivative_dir(image.id), ignore_errors=True)
        db.delete(image)
    db.delete(source)
    db.commit()
