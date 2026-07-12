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

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from app.db.models import FileType, Image, SourceRoot
from app.db.session import SessionLocal
from app.services.exif import read_exif
from app.services.filesystem import resolve_image_path
from app.services.hashing import perceptual_hash, sha256_file
from app.services.raw import classify_file_type, extract_preview
from app.workers.queue import enqueue_post_import

logger = logging.getLogger(__name__)


def is_path_available(path: str) -> bool:
    """True when a source root's folder is currently reachable. For an external
    drive or NAS this is False while it's unplugged/unmounted - the signal we
    use to hide its photos from the library instead of showing dead thumbnails."""
    try:
        return Path(path).is_dir()
    except OSError:
        # A hung or broken network mount can raise rather than return False.
        return False


def unavailable_source_ids(db: Session, owner_id: int) -> list[str]:
    """Ids of the owner's source roots whose folder isn't currently reachable."""
    rows = db.query(SourceRoot.id, SourceRoot.path).filter(SourceRoot.owner_id == owner_id).all()
    return [sid for sid, path in rows if not is_path_available(path)]


def exclude_unavailable(query: Query, unavailable_ids: list[str]) -> Query:
    """Drop images that belong to a currently-unreachable source root, while
    keeping managed-library images (no source root) and reachable-source ones."""
    if not unavailable_ids:
        return query
    return query.filter(
        or_(Image.source_root_id.is_(None), Image.source_root_id.notin_(unavailable_ids))
    )


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


def start_scan(source_root_id: str, include_excluded: bool = False) -> bool:
    """Kick off a background scan. Returns False (a no-op) if one is already
    running for this source, so overlapping triggers (startup + manual) don't
    double-index.

    include_excluded=True (an explicit user-triggered scan) also brings back
    photos that were deleted from this source: the scan is the user saying
    "index this folder again, all of it". The automatic startup scan passes
    False, so deletions survive app restarts."""
    with _status_lock:
        current = _scan_status.get(source_root_id)
        if current and current.get("running"):
            return False
        _scan_status[source_root_id] = {**_blank_status(), "running": True}
    _scan_executor.submit(_run_scan, source_root_id, include_excluded)
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


def _pair_scanned(db: Session, source_root: SourceRoot) -> None:
    """Link RAW+JPEG siblings, but only within the same directory - unlike an
    import batch, a big tree can reuse basenames (DSCF0001) across many folders,
    so pairing purely by stem would mislink unrelated shots.

    Runs over *all* of this source's still-unpaired rows, not just the ones the
    current scan added: the two halves of a pair can be indexed in different
    scans (e.g. one half skipped earlier because a byte-identical copy was in
    the managed library, and picked up only after that copy was deleted) - the
    pair must still link up once both rows exist."""
    unpaired = (
        db.query(Image)
        .filter(
            Image.source_root_id == source_root.id,
            Image.paired_image_id.is_(None),
            # Deleted (excluded) rows must not soak up a visible sibling's
            # pairing slot - the visible half would show as paired to a photo
            # that never appears.
            Image.deleted_at.is_(None),
        )
        .all()
    )
    groups: dict[tuple[str, str], list[Image]] = defaultdict(list)
    for image in unpaired:
        p = Path(image.file_path)
        groups[(str(p.parent), p.stem.lower())].append(image)
    for group in groups.values():
        raws = [i for i in group if i.file_type == FileType.raw]
        jpegs = [i for i in group if i.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            raws[0].paired_image_id = jpegs[0].id
            jpegs[0].paired_image_id = raws[0].id

    # Second pass: pair the shots whose halves don't sit side by side in this
    # source - a RAW and JPEG kept in sibling subfolders (RAW/ + JPG/), or one
    # half that lives in the managed library / another source because it was
    # imported before this folder was added ("skipped_managed" in the scan).
    # Directory can't disambiguate here, so the stricter key is same stem AND
    # identical capture time: two files of one shot always share both, while a
    # reused basename (DSCF0001 from a different day) practically never does.
    db.flush()  # autoflush is off - the query below must see pass-one's pairs
    unpaired_all = (
        db.query(Image)
        .filter(
            Image.owner_id == source_root.owner_id,
            Image.paired_image_id.is_(None),
            Image.deleted_at.is_(None),
            Image.taken_at.isnot(None),
        )
        .all()
    )
    by_shot: dict[tuple[str, datetime], list[Image]] = defaultdict(list)
    for image in unpaired_all:
        stem = Path(image.original_filename).stem.lower()
        by_shot[(stem, image.taken_at)].append(image)
    for group in by_shot.values():
        raws = [i for i in group if i.file_type == FileType.raw]
        jpegs = [i for i in group if i.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            raws[0].paired_image_id = jpegs[0].id
            jpegs[0].paired_image_id = raws[0].id


def _index_file(db, source_root: SourceRoot, path: Path, sha256: str | None = None) -> Image:
    stat = path.stat()
    sha256 = sha256 or sha256_file(path)
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


def _run_scan(source_root_id: str, include_excluded: bool = False) -> None:
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

        # Files already indexed anywhere in the library - skip them so re-scans
        # only pick up what's new. Dedup is global (not just this source):
        # Image.file_path is globally unique, so a folder that overlaps another
        # source root (or the same folder added twice) would otherwise hit a
        # UNIQUE violation on insert.
        already: set[str] = {row[0] for row in db.query(Image.file_path).all()}

        # Content-hash index of this source's rows, so a file we've never seen at
        # this path but whose bytes match an existing row can be recognised as a
        # rename/move rather than indexed as a brand-new duplicate. This is the
        # "mapping by hash": a file's identity is its content, not its name.
        by_hash: dict[str, Image] = {}
        for img in db.query(Image).filter(Image.source_root_id == source_root.id).all():
            by_hash.setdefault(img.file_hash, img)

        # Cross-mode duplicate rule: a photo imported *into* the managed library
        # is the source of truth. A scanned file whose bytes match a managed
        # image (including one sitting in the Trash - it's still restorable) is
        # skipped rather than indexed as an external duplicate.
        managed_hashes: set[str] = {
            file_hash
            for (file_hash,) in db.query(Image.file_hash)
            .filter(Image.owner_id == source_root.owner_id, Image.source_root_id.is_(None))
            .all()
        }

        # Rows for photos the user deleted from this source (kept as hidden
        # exclusion markers - see images.bulk_delete_images). A manual scan
        # revives them; the automatic startup scan leaves them deleted.
        excluded_by_path: dict[str, Image] = {
            img.file_path: img
            for img in db.query(Image)
            .filter(Image.source_root_id == source_root.id, Image.deleted_at.isnot(None))
            .all()
        }

        new_images: list[Image] = []
        scanned = 0
        added = 0
        renamed = 0
        revived = 0
        skipped_managed = 0
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
                excluded = excluded_by_path.get(key)
                if include_excluded and excluded is not None:
                    excluded.deleted_at = None
                    del excluded_by_path[key]
                    revived += 1
                continue

            try:
                sha256 = sha256_file(path)
            except OSError:
                logger.exception("Could not read %s", path)
                continue

            if sha256 in managed_hashes:
                skipped_managed += 1
                continue

            moved = by_hash.get(sha256)
            if moved is not None and not Path(moved.file_path).exists():
                # Same bytes as an indexed file whose old path is now gone: this
                # is that file, renamed or moved. Relocate the existing row in
                # place so its RAW/JPEG pairing, rating, tags and id all survive
                # - instead of leaving a stale row and inserting a duplicate.
                already.discard(moved.file_path)
                excluded_by_path.pop(moved.file_path, None)
                moved.file_path = key
                moved.original_filename = path.name
                if moved.deleted_at is not None:
                    if include_excluded:
                        moved.deleted_at = None
                        revived += 1
                    else:
                        # Still deleted by the user - keep excluding it, now
                        # under its new path.
                        excluded_by_path[key] = moved
                already.add(key)
                renamed += 1
                continue

            try:
                # Nested transaction (SAVEPOINT) so one unreadable or otherwise
                # failing file rolls back only itself - the session stays usable
                # and the files already indexed in this batch are kept, instead
                # of one bad file poisoning the whole scan.
                with db.begin_nested():
                    image = _index_file(db, source_root, path, sha256=sha256)
                new_images.append(image)
                by_hash.setdefault(sha256, image)
                already.add(key)
                added += 1
            except Exception:
                logger.exception("Failed to index %s", path)

        if renamed:
            logger.info("Source %s: relocated %d renamed/moved file(s)", source_root_id, renamed)
        if revived:
            logger.info(
                "Source %s: manual scan revived %d previously deleted photo(s)",
                source_root_id,
                revived,
            )
        if skipped_managed:
            logger.info(
                "Source %s: skipped %d file(s) already imported into the managed library",
                source_root_id,
                skipped_managed,
            )

        _pair_scanned(db, source_root)
        source_root.last_scanned_at = datetime.now(timezone.utc)
        db.commit()

        # Thumbnails + embeddings run on the shared post-import pool, reading the
        # original straight from its source location.
        for image in new_images:
            db.refresh(image)
            enqueue_post_import(image.id, resolve_image_path(image))

        # Revived photos count as "added" for the status readout - from the
        # user's point of view they (re)appeared in the library.
        _update_status(
            source_root_id, running=False, scanned=scanned, added=added + revived, error=None
        )
    except Exception as exc:
        logger.exception("Scan failed for source %s", source_root_id)
        _update_status(source_root_id, running=False, error=str(exc))
    finally:
        db.close()
