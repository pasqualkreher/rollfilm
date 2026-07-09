"""Scan-in-place indexing of external source roots (e.g. a mounted NAS).

Unlike the import pipeline, this never copies or moves files - it walks a
registered folder, creates Image rows that point at the originals where they
already live, and generates thumbnails/embeddings into our own cache. Runs on a
single background worker so multiple roots (and the startup auto-scan) don't
hammer the same storage with parallel full-file reads.
"""

import json
import logging
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from app.db.models import FileType, Image, SourceRoot
from app.db.session import SessionLocal
from app.services.exif import read_exif
from app.services.filesystem import resolve_image_path
from app.services.hashing import perceptual_hash, sha256_file
from app.services.raw import classify_file_type, extract_preview
from app.workers.queue import enqueue_post_import

logger = logging.getLogger(__name__)

_scan_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="source-scan")

_status_lock = threading.Lock()
_scan_status: dict[str, dict] = {}


def _blank_status() -> dict:
    return {"running": False, "scanned": 0, "added": 0, "error": None}


def get_scan_status(source_root_id: str) -> dict:
    with _status_lock:
        return dict(_scan_status.get(source_root_id, _blank_status()))


def _update_status(source_root_id: str, **fields) -> None:
    with _status_lock:
        status = _scan_status.setdefault(source_root_id, _blank_status())
        status.update(fields)


def start_scan(source_root_id: str) -> bool:
    """Kick off a background scan. Returns False (a no-op) if one is already
    running for this source, so overlapping triggers (startup + manual) don't
    double-index."""
    with _status_lock:
        current = _scan_status.get(source_root_id)
        if current and current.get("running"):
            return False
        _scan_status[source_root_id] = {**_blank_status(), "running": True}
    _scan_executor.submit(_run_scan, source_root_id)
    return True


def scan_all_sources() -> None:
    """Incremental scan of every registered source root - used on startup.

    Deliberately swallows all errors: a scan problem (or a not-yet-migrated DB
    during a dev reload) must never stop the API from starting up.
    """
    try:
        db = SessionLocal()
        try:
            ids = [row[0] for row in db.query(SourceRoot.id).all()]
        finally:
            db.close()
        for source_root_id in ids:
            start_scan(source_root_id)
    except Exception:
        logger.exception("Startup source scan could not be started")


def _pair_scanned(images: list[Image]) -> None:
    """Link RAW+JPEG siblings, but only within the same directory - unlike an
    import batch, a big tree can reuse basenames (DSCF0001) across many folders,
    so pairing purely by stem would mislink unrelated shots."""
    groups: dict[tuple[str, str], list[Image]] = defaultdict(list)
    for image in images:
        p = Path(image.file_path)
        groups[(str(p.parent), p.stem.lower())].append(image)
    for group in groups.values():
        raws = [i for i in group if i.file_type == FileType.raw]
        jpegs = [i for i in group if i.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            raws[0].paired_image_id = jpegs[0].id
            jpegs[0].paired_image_id = raws[0].id


def _index_file(db, source_root: SourceRoot, path: Path) -> Image:
    stat = path.stat()
    sha256 = sha256_file(path)
    phash = perceptual_hash(extract_preview(path))
    exif = json.loads(read_exif(path).to_json())
    file_type = FileType(classify_file_type(path))

    taken_at = (
        datetime.fromisoformat(exif["taken_at"])
        if exif.get("taken_at")
        else datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    )

    image = Image(
        owner_id=source_root.owner_id,
        file_path=str(path),
        source_root_id=source_root.id,
        original_filename=path.name,
        file_hash=sha256,
        perceptual_hash=phash,
        file_type=file_type,
        raw_format=path.suffix.lstrip(".").upper() if file_type == FileType.raw else None,
        width=exif.get("width"),
        height=exif.get("height"),
        file_size=stat.st_size,
        taken_at=taken_at,
        camera_make=exif.get("camera_make"),
        camera_model=exif.get("camera_model"),
        iso=exif.get("iso"),
        aperture=exif.get("aperture"),
        shutter_speed=exif.get("shutter_speed"),
        focal_length=exif.get("focal_length"),
        gps_lat=exif.get("gps_lat"),
        gps_lon=exif.get("gps_lon"),
    )
    db.add(image)
    db.flush()
    return image


def _run_scan(source_root_id: str) -> None:
    db = SessionLocal()
    try:
        source_root = db.get(SourceRoot, source_root_id)
        if source_root is None:
            _update_status(source_root_id, running=False, error="Source was removed")
            return

        root = Path(source_root.path)
        if not root.is_dir():
            _update_status(
                source_root_id,
                running=False,
                error=f"Path not found or not mounted: {source_root.path}",
            )
            return

        # Files from this source already indexed - skip them so re-scans only
        # pick up what's new (dedup by absolute path).
        already: set[str] = {
            row[0]
            for row in db.query(Image.file_path)
            .filter(Image.source_root_id == source_root.id)
            .all()
        }

        new_images: list[Image] = []
        scanned = 0
        added = 0
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            if classify_file_type(path) is None:
                continue
            scanned += 1
            if scanned % 25 == 0:
                _update_status(source_root_id, scanned=scanned, added=added)

            key = str(path)
            if key in already:
                continue
            try:
                new_images.append(_index_file(db, source_root, path))
                already.add(key)
                added += 1
            except Exception:
                logger.exception("Failed to index %s", path)

        _pair_scanned(new_images)
        source_root.last_scanned_at = datetime.now(timezone.utc)
        db.commit()

        # Thumbnails + embeddings run on the shared post-import pool, reading the
        # original straight from its source location.
        for image in new_images:
            db.refresh(image)
            enqueue_post_import(image.id, resolve_image_path(image))

        _update_status(source_root_id, running=False, scanned=scanned, added=added, error=None)
    except Exception as exc:
        logger.exception("Scan failed for source %s", source_root_id)
        _update_status(source_root_id, running=False, error=str(exc))
    finally:
        db.close()
