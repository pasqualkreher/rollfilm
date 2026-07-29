import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    ColorLabel,
    FileType,
    Image,
    ImportSession,
    ImportSessionStatus,
    ImportStagedFile,
)
from app.db.session import SessionLocal
from app.services import geocode
from app.services.exif import (
    ExifData,
    capture_date_from_filename,
    new_helper,
    read_exif,
    to_float,
    to_int,
)
from app.services.filesystem import library_relative_path
from app.services.hashing import hamming_int, perceptual_hash, phash_to_int, sha256_file
from app.services.pairing import pair_library, pair_siblings
from app.services.raw import classify_file_type, extract_preview_with_size
from app.services.settings_store import (
    IMMICH_MODE_FULL,
    IMMICH_MODE_MANUAL,
    IMMICH_MODE_SELECTIVE,
    get_immich_config,
)
from app.services.thumbnails import THUMBNAIL_MAX_PX, THUMBNAIL_SCALE
from app.workers.queue import (
    enqueue_immich_upload,
    enqueue_post_import,
    register_import_activity_probe,
)

from PIL import Image as PILImage


class UploadedFile(Protocol):
    """Structural type matching FastAPI's UploadFile - kept narrow so this
    module doesn't need to import Starlette directly.

    An upload may additionally carry an `mtime` attribute (epoch seconds of the
    *source* file, read via getattr) - staging stamps it onto the staged copy,
    so a photo without an EXIF capture date still sorts by its real file date
    instead of the moment it was imported."""

    filename: str | None
    file: BinaryIO


def _same_shot_stem(name_a: str, name_b: str) -> bool:
    return Path(name_a).stem.lower() == Path(name_b).stem.lower()


def compute_staged_pairs(staged_files: list[ImportStagedFile]) -> dict[str, str]:
    """Read-only preview of the RAW+JPEG pairing pair_siblings() will do at
    commit time, so the review screen can offer the same combined/JPEG/RAW
    view toggle as the library before anything is actually imported."""
    by_stem: dict[str, list[ImportStagedFile]] = defaultdict(list)
    for f in staged_files:
        by_stem[Path(f.original_filename).stem.lower()].append(f)

    pairs: dict[str, str] = {}
    for group in by_stem.values():
        raws = [f for f in group if f.file_type == FileType.raw]
        jpegs = [f for f in group if f.file_type == FileType.jpeg]
        if len(raws) == 1 and len(jpegs) == 1:
            pairs[raws[0].id] = jpegs[0].id
            pairs[jpegs[0].id] = raws[0].id
    return pairs


logger = logging.getLogger(__name__)

# Cap on the concurrent analysis workers (and thus exiftool processes). Each
# file is independent and its work is a mix of GIL-releasing native code
# (image decode, phash) and blocking waits (its exiftool subprocess, disk
# reads), so throughput keeps climbing past the core count - idle workers
# waiting on a subprocess/disk overlap with the busy ones. Oversubscribed to
# ~2x cores for that overlap, capped so a huge import can't spawn a runaway
# number of exiftool processes (each worker holds one, plus a small decoded
# preview).
_STAGE_WORKERS = min(16, max(4, (os.cpu_count() or 4) * 2))


@dataclass
class _Analyzed:
    """The result of the heavy, per-file staging work (hashing, preview, phash,
    exif, thumbnail) - computed in parallel, then turned into DB rows serially.
    Carries a pre-generated id so its thumbnail can be written before the row
    exists in the database."""

    id: str
    staged_rel_path: str
    original_filename: str
    file_type: str
    sha256: str
    perceptual_hash: str | None
    exif_json: str


@dataclass
class _CommitEntry:
    """A staged file that will be imported, with its resolved library
    destination - computed serially, then moved in parallel and turned into a
    DB row serially (see commit_import_session)."""

    staged: "ImportStagedFile"
    promoted: "Image | None"
    exif_dict: dict
    taken_at: datetime
    relative_dest: str
    dest_path: Path
    staged_full_path: Path
    # A previous commit attempt that failed after its move phase already
    # placed this file in the library - don't move it again.
    already_moved: bool = False


def _analyze_file(
    staged_path: Path,
    original_filename: str,
    file_type: str,
    staged_id: str,
    thumb_dir: Path,
    helper,
    sha256: str,
) -> _Analyzed:
    """Pure computation, safe to run on a worker thread (no DB access). sha256
    was already computed while the file streamed into staging (see
    _hash_and_copy) so the bytes aren't read a second time here;
    preview/phash/thumbnail/exif are each guarded so a single corrupt file
    can't abort a large import - it's still staged (its bytes are known) just
    without a preview/hash."""
    perceptual = None
    exif = ExifData()

    try:
        preview, (orig_w, orig_h) = extract_preview_with_size(staged_path)
        perceptual = perceptual_hash(preview)
        # Match the library's grid thumbnail exactly (0.25 of the original,
        # capped, LANCZOS) so the import review shows the same quality. The
        # target is computed from the true original size (the JPEG preview above
        # is already DCT-downscaled), and thumbnail() only ever shrinks.
        thumb = preview.copy()
        tw = min(THUMBNAIL_MAX_PX, max(1, round(orig_w * THUMBNAIL_SCALE)))
        th = min(THUMBNAIL_MAX_PX, max(1, round(orig_h * THUMBNAIL_SCALE)))
        thumb.thumbnail((tw, th), PILImage.LANCZOS)
        thumb.save(thumb_dir / f"{staged_id}.jpg", "JPEG", quality=88)
    except Exception:
        logger.exception("Preview/thumbnail failed for %s (staged without one)", original_filename)

    try:
        exif = read_exif(staged_path, helper=helper)
    except Exception:
        logger.exception("EXIF read failed for %s", original_filename)

    return _Analyzed(
        id=staged_id,
        staged_rel_path=str(staged_path.relative_to(settings.import_staging_root)),
        original_filename=original_filename,
        file_type=file_type,
        sha256=sha256,
        perceptual_hash=perceptual,
        exif_json=exif.to_json(),
    )


def _hash_and_copy(src: BinaryIO, dest: Path) -> tuple[str, int]:
    """Stream an upload to its staging path, hashing while the bytes pass
    through - so the source medium is read exactly once instead of copied and
    then re-read for sha256."""
    digest = hashlib.sha256()
    size = 0
    with dest.open("wb") as out:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


# --- Background analysis ------------------------------------------------------
# The copy phase (inside the staging request) only streams bytes into the
# staging folder and creates unprocessed rows; everything slow - preview,
# phash, thumbnail, EXIF, duplicate detection - runs here, on a process-wide
# worker pool, after the request has already returned. That keeps the staging
# requests fast and bounded (copying runs at source-medium speed) instead of
# stalling for minutes behind the analysis of the previous batch.
_analysis_executor = ThreadPoolExecutor(
    max_workers=_STAGE_WORKERS, thread_name_prefix="import-analyze"
)

# Each analysis worker thread keeps its own exiftool -stay_open helper (the
# helper can't be shared between threads). Created lazily, lives as long as
# the thread; exiftool exits by itself when its stdin pipe closes on shutdown.
_thread_helpers = threading.local()


def _thread_helper():
    helper = getattr(_thread_helpers, "helper", None)
    if helper is None:
        helper = new_helper()
        _thread_helpers.helper = helper
    return helper


# Staged-file ids with an analysis job queued or running - so re-enqueueing
# (another batch, the restart-recovery sweep) never double-processes a file.
_inflight: set[str] = set()
_inflight_lock = threading.Lock()


class _SessionDedupState:
    """Per-import-session duplicate-detection index, shared by all analysis
    jobs of that session. The library's hash indexes are loaded once (not
    re-queried per file - that's what keeps a big import from degrading into
    O(files x library) database round-trips), and every processed staged file
    is appended so later files still dedup against earlier ones. The lock also
    serializes the per-file DB write, which keeps the "first one processed is
    the original, the rest are its duplicates" ordering consistent."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.loaded = False
        self.image_by_hash: dict[str, tuple[str, str | None]] = {}  # sha -> (image id, source_root_id)
        self.image_phashes: list[tuple[int, str, str]] = []  # (int phash, filename, image id)
        self.staged_by_hash: dict[str, str] = {}  # sha -> staged file id
        self.staged_phashes: list[tuple[int, str, str]] = []  # (int phash, filename, staged id)


_session_states: dict[str, _SessionDedupState] = {}
_session_states_lock = threading.Lock()


def _session_state(session_id: str) -> _SessionDedupState:
    with _session_states_lock:
        state = _session_states.get(session_id)
        if state is None:
            state = _session_states[session_id] = _SessionDedupState()
        return state


def _drop_session_state(session_id: str) -> None:
    """Forget a finished (committed/discarded) session's in-memory dedup index
    and progress counters."""
    with _session_states_lock:
        _session_states.pop(session_id, None)
    with _progress_lock:
        _progress.pop(session_id, None)


def _load_dedup_state(state: _SessionDedupState, db: Session, session_id: str, owner_id: int) -> None:
    """Load the library's dedup indexes once per session, and seed the staged
    indexes with files of this session that are already processed (matters
    after a backend restart mid-analysis)."""
    for row in db.query(
        Image.id, Image.file_hash, Image.perceptual_hash, Image.original_filename, Image.source_root_id
    ).filter(Image.owner_id == owner_id):
        state.image_by_hash.setdefault(row.file_hash, (row.id, row.source_root_id))
        if row.perceptual_hash:
            state.image_phashes.append(
                (phash_to_int(row.perceptual_hash), row.original_filename, row.id)
            )
    for existing in (
        db.query(ImportStagedFile)
        .filter(
            ImportStagedFile.import_session_id == session_id,
            ImportStagedFile.processed.is_(True),
        )
        .all()
    ):
        state.staged_by_hash.setdefault(existing.sha256, existing.id)
        if existing.perceptual_hash:
            state.staged_phashes.append(
                (phash_to_int(existing.perceptual_hash), existing.original_filename, existing.id)
            )
    state.loaded = True


def _apply_analysis(session_id: str, owner_id: int, a: _Analyzed) -> None:
    """Persist one file's analysis results and flag duplicates. Serialized per
    session via the dedup-state lock (the index reads/updates and the 'earlier
    file wins' duplicate ordering both need it)."""
    threshold = settings.duplicate_phash_hamming_threshold
    state = _session_state(session_id)

    def _near(phash_int: int, filename: str, candidates: list[tuple[int, str, str]]) -> str | None:
        for other_int, other_name, ref_id in candidates:
            # A RAW+JPEG pair from the same shot has near-identical pixels but is
            # a sibling to be paired (see pairing.py), not a duplicate.
            if _same_shot_stem(filename, other_name):
                continue
            if hamming_int(phash_int, other_int) <= threshold:
                return ref_id
        return None

    with state.lock:
        db = SessionLocal()
        try:
            staged = db.get(ImportStagedFile, a.id)
            session = db.get(ImportSession, session_id)
            if (
                staged is None
                or session is None
                or session.status != ImportSessionStatus.staging
            ):
                return  # session discarded/committed while this job waited
            if staged.processed:
                return
            if not state.loaded:
                _load_dedup_state(state, db, session_id, owner_id)

            staged.perceptual_hash = a.perceptual_hash
            staged.exif_json = a.exif_json

            # Exact library match first, then exact match earlier in this session,
            # then a perceptual near-duplicate against the library, then the session.
            exact_image = state.image_by_hash.get(a.sha256)
            if exact_image is not None:
                image_id, source_root_id = exact_image
                staged.duplicate_of_image_id = image_id
                # Trash state is read fresh (not from the session-lifetime dedup
                # index): the user may well have trashed the photo just before
                # re-importing it.
                dup_row = db.get(Image, image_id) if source_root_id is None else None
                if source_root_id is None and (dup_row is None or dup_row.deleted_at is None):
                    # Byte-identical to a visible managed-library photo - don't
                    # re-import by default (the API also rejects re-selecting it).
                    staged.selected = False
                # else: the only copy is indexed in place from an external source
                # root (importing promotes it) or sits in the Trash (importing
                # the same bytes is the explicit way to bring it back, mirroring
                # the source-root rule) - leave it selected.
            elif a.sha256 in state.staged_by_hash:
                staged.duplicate_of_staged_file_id = state.staged_by_hash[a.sha256]
                staged.selected = False
            elif a.perceptual_hash:
                phash_int = phash_to_int(a.perceptual_hash)
                near_image = _near(phash_int, a.original_filename, state.image_phashes)
                if near_image is not None:
                    staged.duplicate_of_image_id = near_image
                    staged.is_near_duplicate = True
                else:
                    near_staged = _near(phash_int, a.original_filename, state.staged_phashes)
                    if near_staged is not None:
                        staged.duplicate_of_staged_file_id = near_staged
                        staged.is_near_duplicate = True

            staged.processed = True
            db.commit()

            state.staged_by_hash.setdefault(a.sha256, a.id)
            if a.perceptual_hash:
                state.staged_phashes.append(
                    (phash_to_int(a.perceptual_hash), a.original_filename, a.id)
                )
        finally:
            db.close()


def _run_analysis(session_id: str, staged_id: str) -> None:
    """One background analysis job: read the staged row, do the heavy per-file
    work, persist the result. Never raises - a single bad file must not take
    the worker thread (or the import) down with it."""
    try:
        db = SessionLocal()
        try:
            staged = db.get(ImportStagedFile, staged_id)
            session = db.get(ImportSession, session_id)
            if (
                staged is None
                or staged.processed
                or session is None
                or session.status != ImportSessionStatus.staging
            ):
                return
            owner_id = session.owner_id
            staged_full_path = settings.import_staging_root / staged.staged_path
            original_filename = staged.original_filename
            file_type = staged.file_type.value
            sha256 = staged.sha256
        finally:
            db.close()

        thumb_dir = settings.import_staging_root / session_id / ".thumbnails"
        analyzed = _analyze_file(
            staged_full_path,
            original_filename,
            file_type,
            staged_id,
            thumb_dir,
            _thread_helper(),
            sha256,
        )
        _apply_analysis(session_id, owner_id, analyzed)
        _progress_step(session_id)
    except Exception:
        logger.exception("Background analysis failed for staged file %s", staged_id)
    finally:
        with _inflight_lock:
            _inflight.discard(staged_id)


def _enqueue_analysis(session_id: str, staged_id: str) -> None:
    with _inflight_lock:
        if staged_id in _inflight:
            return
        _inflight.add(staged_id)
    try:
        _analysis_executor.submit(_run_analysis, session_id, staged_id)
    except Exception:
        with _inflight_lock:
            _inflight.discard(staged_id)
        raise


def ensure_session_processing(session: ImportSession) -> None:
    """Re-enqueue analysis for any unprocessed file of the session that has no
    job queued or running. Called from the routes the review screen polls, so
    a backend restart mid-analysis (the executor and its queue are in-memory)
    heals itself the moment the UI looks at the session again."""
    if session.status != ImportSessionStatus.staging:
        return
    pending = [f.id for f in session.staged_files if not f.processed]
    if not pending:
        return
    # Rebuild the in-memory progress entry after a restart, so the UI's
    # processed/total readout picks up where it left off.
    with _progress_lock:
        if session.id not in _progress:
            p = _progress_new("staging", len(session.staged_files))
            p["copied"] = len(session.staged_files)
            p["processed"] = len(session.staged_files) - len(pending)
            _progress[session.id] = p
    for staged_id in pending:
        _enqueue_analysis(session.id, staged_id)


# The client deliberately keeps two staging requests in flight. The copy work
# itself must not interleave though - two batches writing into the same
# session folder could race the unique-filename check - so it's serialized
# behind one process-wide lock. Copying is fast (analysis happens in the
# background), so the wait is short.
_staging_lock = threading.Lock()


# --- Import progress (for the UI's "processing"/"importing" phase ETA) --------
# Upload byte-progress is reported by the browser itself, but the backend
# phases with no feedback are the staging copy, the background analysis
# (preview/exif/thumbnail/dedup) and the commit. Track per-session counters
# here so a poll endpoint can surface live counts and a time estimate.
# For the staging phase: `copied` files are fully in the staging folder,
# `processed` of `total` have finished background analysis.
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()


# How many recent completions the ETA rate is computed from. Big enough to
# smooth per-file variance (JPEG vs RAW), small enough that the estimate
# tracks the *current* rate instead of averaging over the whole session -
# an average lies badly when the quick JPEGs finish first or when I/O stalls.
_ETA_WINDOW = 20


def _progress_new(phase: str, total: int) -> dict:
    return {
        "phase": phase,
        "processed": 0,
        "copied": 0,
        "total": total,
        "started": time.monotonic(),
        "recent": deque(maxlen=_ETA_WINDOW),
    }


def _progress_begin(session_id: str, phase: str, total: int) -> None:
    with _progress_lock:
        _progress[session_id] = _progress_new(phase, total)


def _progress_add_total(session_id: str, n: int) -> None:
    """Grow the staging phase's target by one incoming batch. Unlike
    _progress_begin this accumulates - the analysis backlog spans batches."""
    with _progress_lock:
        p = _progress.get(session_id)
        if p is None or p["phase"] != "staging":
            p = _progress_new("staging", 0)
            _progress[session_id] = p
        p["total"] += n


def _progress_copy_step(session_id: str, n: int = 1) -> None:
    with _progress_lock:
        p = _progress.get(session_id)
        if p is not None:
            p["copied"] += n


def _progress_step(session_id: str, n: int = 1) -> None:
    with _progress_lock:
        p = _progress.get(session_id)
        if p is not None:
            p["processed"] += n
            now = time.monotonic()
            for _ in range(n):
                p["recent"].append(now)


def _progress_done(session_id: str) -> None:
    with _progress_lock:
        p = _progress.get(session_id)
        if p is not None:
            p["phase"] = "idle"
            p["processed"] = p["total"]


def has_active_import_work() -> bool:
    """Whether any import currently has staging/analysis/commit work
    outstanding. The embedding backfill (workers/queue.py) yields to this, so
    CLIP encoding never steals CPU or the SQLite write lock from a running
    import. A session merely sitting open in review - everything copied and
    analyzed, the user still picking photos - does not count as active."""
    with _inflight_lock:
        if _inflight:
            return True
    with _progress_lock:
        for p in _progress.values():
            if p["phase"] == "staging" and (
                p["copied"] < p["total"] or p["processed"] < p["total"]
            ):
                return True
            if p["phase"] == "commit" and p["processed"] < p["total"]:
                return True
    return False


register_import_activity_probe(has_active_import_work)


def get_import_progress(session_id: str) -> dict | None:
    """Live progress for the given import session, or None if nothing is (or was
    recently) running. `eta_seconds` is a rolling estimate from the observed
    rate so far; None until at least one item has finished."""
    with _progress_lock:
        p = _progress.get(session_id)
        if p is None:
            return None
        phase, processed, total, started = p["phase"], p["processed"], p["total"], p["started"]
        copied = p.get("copied", 0)
        recent = list(p["recent"])
    eta = None
    if phase != "idle" and processed > 0 and total > processed:
        now = time.monotonic()
        # Rate over the most recent completions, measured up to *now* rather
        # than up to the last finish - so a stall (slow RAWs, throttled I/O)
        # makes the ETA honestly grow instead of freezing at a stale value.
        if len(recent) >= 2 and now > recent[0]:
            rate = len(recent) / (now - recent[0])
            eta = (total - processed) / rate
        else:
            elapsed = now - started
            eta = elapsed / processed * (total - processed)
    return {
        "phase": phase,
        "processed": processed,
        "copied": copied,
        "total": total,
        "eta_seconds": eta,
    }


def stage_uploaded_files(
    db: Session, owner_id: int, uploads: list[UploadedFile], source_label: str
) -> ImportSession:
    """Handles photos picked via the browser's native folder dialog and
    uploaded over HTTP - the backend never needs filesystem access to
    wherever the user's SD card/folder actually is."""
    session = ImportSession(owner_id=owner_id, source_path=source_label or "Uploaded folder")
    db.add(session)
    db.flush()
    with _staging_lock:
        _stage_uploads_into(db, session, owner_id, uploads)
        db.commit()
    db.refresh(session)
    return session


def append_uploaded_files(
    db: Session, session: ImportSession, owner_id: int, uploads: list[UploadedFile]
) -> ImportSession:
    """Stage another batch of uploads into an existing staging session. The
    multipart parser caps a single request at 1000 files, so big imports are
    sent as several requests all appending to one session - duplicate checks
    and RAW+JPEG pairing still see the whole session, not just one batch."""
    with _staging_lock:
        # This request's read transaction began before the lock was acquired
        # (the route already loaded the session row). End it so the copy phase
        # below starts fresh against whatever a concurrent batch committed.
        db.rollback()
        _stage_uploads_into(db, session, owner_id, uploads)
        db.commit()
    db.refresh(session)
    return session


def _stage_uploads_into(
    db: Session, session: ImportSession, owner_id: int, uploads: list[UploadedFile]
) -> None:
    """Copy phase only: stream each file into the staging folder (hashing
    in-flight, see _hash_and_copy), create its row unprocessed, and hand it to
    the background analysis pool. The request returns as soon as the bytes are
    copied - all the slow per-file work (preview/phash/exif/thumbnail/dedup)
    runs in the background while the next batch is already copying. Each row
    is committed individually so the review grid and the analysis workers see
    files the moment they land, not when the whole batch is done."""
    session_dir = settings.import_staging_root / session.id
    thumb_dir = session_dir / ".thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    # Filter down to importable files first so the progress total covers the
    # whole batch before the first byte is copied.
    incoming: list[tuple[UploadedFile, str, str]] = []
    for upload in uploads:
        original_filename = Path(upload.filename or "").name
        if not original_filename or original_filename.startswith("."):
            continue
        file_type = classify_file_type(Path(original_filename))
        if file_type is None:
            continue
        incoming.append((upload, original_filename, file_type))

    started = time.monotonic()
    total_bytes = 0
    _progress_add_total(session.id, len(incoming))

    # Copying stays serial: sequential reads are what source media (SD card,
    # NAS, upload spool) do best, and the analysis pool works alongside.
    for upload, original_filename, file_type in incoming:
        staged_path = session_dir / original_filename
        counter = 1
        while staged_path.exists():
            staged_path = (
                session_dir
                / f"{Path(original_filename).stem}_{counter}{Path(original_filename).suffix}"
            )
            counter += 1

        sha256, size = _hash_and_copy(upload.file, staged_path)
        total_bytes += size
        # Carry the source file's modification time onto the staged
        # copy. Without this the staged mtime is "just now", and the
        # commit-time fallback for photos lacking an EXIF capture date
        # would date them to the import instead of the original file.
        source_mtime = getattr(upload, "mtime", None)
        if source_mtime:
            try:
                os.utime(staged_path, (source_mtime, source_mtime))
            except OSError:
                pass

        staged_id = str(uuid.uuid4())
        db.add(
            ImportStagedFile(
                id=staged_id,
                import_session_id=session.id,
                staged_path=str(staged_path.relative_to(settings.import_staging_root)),
                original_filename=original_filename,
                file_type=FileType(file_type),
                sha256=sha256,
                processed=False,
            )
        )
        # Commit per file: the row must be durable before the background job
        # (which uses its own DB session) can pick it up.
        db.commit()
        _progress_copy_step(session.id)
        _enqueue_analysis(session.id, staged_id)

    # One line per batch so a slow import is diagnosable from the server log
    # alone. This now measures the copy only - if it tracks the batch's byte
    # size at the source medium's read speed, the source is the bottleneck.
    logger.info(
        "import batch copied: %d files (%.0f MB) in %.1fs (analysis continues in background)",
        len(incoming),
        total_bytes / 1e6,
        time.monotonic() - started,
    )


def commit_import_session(
    db: Session,
    session: ImportSession,
    owner_id: int,
    upload_to_immich: bool = False,
    sync_all_to_immich: bool = False,
) -> list[Image]:
    def _exact_referenced_duplicate(f: ImportStagedFile) -> Image | None:
        """The existing image this staged file is a byte-identical copy of, if
        importing it again is allowed. Two exact-duplicate cases qualify: a
        scan-in-place (source root) row - a copy imported *into* the library is
        the source of truth, so committing promotes that row to a managed one -
        and a managed row sitting in the Trash, where importing the same bytes
        is the explicit way to bring the photo back (it's restored at commit
        instead of staying invisibly trashed forever)."""
        if not f.duplicate_of_image_id or f.is_near_duplicate:
            return None
        existing = db.get(Image, f.duplicate_of_image_id)
        if existing is None:
            return None
        if existing.source_root_id is not None or existing.deleted_at is not None:
            return existing
        return None

    def _is_exact_duplicate(f: ImportStagedFile) -> bool:
        return bool(
            (f.duplicate_of_image_id or f.duplicate_of_staged_file_id) and not f.is_near_duplicate
        )

    def _find_moved_library_copy(staged: ImportStagedFile, taken_at: datetime) -> Path | None:
        """Locate a staged file that a previous, mid-way-failed commit attempt
        already moved into the library. The move phase runs before the DB
        transaction lands, and a rollback can't un-move files - so on retry the
        staging copy is gone but the bytes sit at the destination the failed
        attempt computed. Match by name pattern + content hash, and only claim
        files no DB row owns yet."""
        day_dir = settings.library_root / f"{taken_at.year:04d}" / taken_at.strftime("%Y-%m-%d")
        if not day_dir.is_dir():
            return None
        stem = Path(staged.original_filename).stem
        suffix = Path(staged.original_filename).suffix
        candidates = [day_dir / staged.original_filename] + sorted(
            p
            for p in day_dir.iterdir()
            if p.name.startswith(f"{stem}_") and p.suffix == suffix
        )
        for candidate in candidates:
            if not candidate.is_file():
                continue
            if sha256_file(candidate) != staged.sha256:
                continue
            rel = str(candidate.relative_to(settings.library_root))
            owned = db.query(Image.id).filter(Image.file_path == rel).first()
            if owned is None:
                return candidate
        return None

    # Only fully analyzed files can commit (the route refuses the request while
    # any file is unprocessed - this filter is the belt-and-braces guard).
    selected_files = [
        f
        for f in session.staged_files
        if f.selected
        and f.processed
        and (not _is_exact_duplicate(f) or _exact_referenced_duplicate(f) is not None)
    ]
    new_images: list[Image] = []

    # Decide which staged files actually import, and where each lands, *before*
    # touching disk. The exact-duplicate promotion logic is order-dependent (an
    # earlier file in this commit can promote a shared source-root row, which
    # then makes a later identical copy a no-op), so replay it serially here
    # rather than inside the parallel move below. `promoted_ids` mirrors the
    # source_root_id=None mutation the real promotion does, without writing yet.
    plan: list[_CommitEntry] = []
    promoted_ids: set[str] = set()
    # Destinations claimed by earlier files in this plan. The filesystem check
    # inside library_relative_path can't see them (nothing is moved until the
    # whole plan is final), so without this, two same-name shots from the same
    # day would both plan the same path - one overwriting the other on move and
    # the second row then failing the UNIQUE(file_path) constraint.
    planned_dests: set[str] = set()

    def _dest_taken(rel: str) -> bool:
        if rel in planned_dests:
            return True
        # Also veto paths a DB row still claims even though no file is there
        # (e.g. a trashed photo whose file left the library folder).
        return db.query(Image.id).filter(Image.file_path == rel).first() is not None

    for staged in selected_files:
        promoted = _exact_referenced_duplicate(staged)
        if promoted is not None and promoted.id in promoted_ids:
            promoted = None  # already claimed by an earlier file in this commit
        if _is_exact_duplicate(staged) and promoted is None:
            continue

        exif_dict = json.loads(staged.exif_json) if staged.exif_json else {}
        staged_full_path = settings.import_staging_root / staged.staged_path

        # A managed photo sitting in the Trash whose original is still in the
        # library folder (trash keeps files on disk until permanent deletion):
        # restore it in place. Same bytes, same path - nothing to move, the
        # staged copy is simply discarded with the session. The commit loop's
        # promoted branch clears deleted_at.
        if (
            promoted is not None
            and promoted.source_root_id is None
            and (settings.library_root / promoted.file_path).exists()
        ):
            promoted_ids.add(promoted.id)
            planned_dests.add(promoted.file_path)
            plan.append(
                _CommitEntry(
                    staged,
                    promoted,
                    exif_dict,
                    promoted.taken_at or datetime.now(timezone.utc),
                    promoted.file_path,
                    settings.library_root / promoted.file_path,
                    staged_full_path,
                    already_moved=True,
                )
            )
            continue

        staged_missing = not staged_full_path.exists()

        taken_at = (
            datetime.fromisoformat(exif_dict["taken_at"]) if exif_dict.get("taken_at") else None
        )
        if taken_at is None:
            # No date in the metadata at all (WhatsApp strips EXIF entirely):
            # a date embedded in the filename still beats the mtime fallback.
            taken_at = capture_date_from_filename(staged.original_filename)
        if taken_at is None:
            if staged_missing:
                logger.warning(
                    "commit: skipping %s - staging copy is gone and it has no EXIF "
                    "capture date to locate an already-moved library copy by",
                    staged.original_filename,
                )
                continue
            taken_at = datetime.fromtimestamp(staged_full_path.stat().st_mtime, tz=timezone.utc)

        if staged_missing:
            # A previous commit attempt failed after moving this file into the
            # library; adopt that copy instead of failing the whole commit.
            moved_copy = _find_moved_library_copy(staged, taken_at)
            if moved_copy is None:
                logger.warning(
                    "commit: skipping %s - missing from staging and no matching "
                    "unclaimed library copy found",
                    staged.original_filename,
                )
                continue
            relative_dest = str(moved_copy.relative_to(settings.library_root))
            dest_path = moved_copy
            already_moved = True
        else:
            relative_dest = library_relative_path(
                taken_at, staged.original_filename, settings.library_root, is_taken=_dest_taken
            )
            dest_path = settings.library_root / relative_dest
            already_moved = False

        planned_dests.add(relative_dest)
        if promoted is not None:
            promoted_ids.add(promoted.id)
        plan.append(
            _CommitEntry(
                staged,
                promoted,
                exif_dict,
                taken_at,
                relative_dest,
                dest_path,
                staged_full_path,
                already_moved,
            )
        )

    _progress_begin(session.id, "commit", len(plan))

    # Move the staged files into the library in parallel - independent disk I/O
    # (a rename on the same filesystem, or a copy across one), the slowest part
    # of the commit. DB row creation stays serial below (the SQLAlchemy Session
    # isn't thread-safe). Moves must all finish before any row is created, since
    # a row records the post-move library path and size.
    to_move = [e for e in plan if not e.already_moved]
    if to_move:
        move_workers = min(_STAGE_WORKERS, len(to_move))
        with ThreadPoolExecutor(max_workers=move_workers) as pool:
            list(pool.map(lambda e: shutil.move(str(e.staged_full_path), str(e.dest_path)), to_move))

    # Release the write lock periodically: one mega-transaction over the whole
    # loop held it for minutes on a big import, starving every other writer
    # past its busy_timeout ("database is locked" when e.g. starting another
    # import meanwhile). Files are moved before any row is written, so a chunk
    # that committed stays valid even if a later one fails - the retry path
    # (_find_moved_library_copy) adopts whatever the failed remainder left.
    _COMMIT_CHUNK = 200
    rows_since_commit = 0

    for entry in plan:
        _progress_step(session.id)
        staged = entry.staged
        promoted = entry.promoted
        exif_dict = entry.exif_dict
        taken_at = entry.taken_at
        relative_dest = entry.relative_dest
        dest_path = entry.dest_path

        if promoted is not None:
            # Same bytes, previously only indexed in place from an external
            # folder. Point the existing row at the fresh library copy and drop
            # its source link - it keeps its id, so rating, tags, albums, edits
            # and RAW/JPEG pairing all survive. The external file stays where
            # it is, untouched.
            promoted.file_path = relative_dest
            promoted.source_root_id = None
            promoted.original_filename = staged.original_filename
            promoted.file_size = dest_path.stat().st_size
            # A previously deleted source-root photo lives on as a hidden
            # scan-exclusion row, and a managed photo may sit in the Trash;
            # importing the same bytes is the explicit way to bring either back.
            promoted.deleted_at = None
            if staged.rating:
                promoted.rating = staged.rating
            if staged.color_label != ColorLabel.none:
                promoted.color_label = staged.color_label
            if staged.immich_sync:
                promoted.immich_sync = True
            image = promoted
        else:
            image = Image(
                owner_id=owner_id,
                file_path=relative_dest,
                original_filename=staged.original_filename,
                file_hash=staged.sha256,
                perceptual_hash=staged.perceptual_hash,
                file_type=staged.file_type,
                raw_format=(
                    Path(staged.original_filename).suffix.lstrip(".").upper()
                    if staged.file_type == FileType.raw
                    else None
                ),
                # Coerced defensively: sessions staged before exif.py sanitised
                # numeric tags can still carry exiftool's 'undef' strings in
                # their stored exif_json.
                width=to_int(exif_dict.get("width")),
                height=to_int(exif_dict.get("height")),
                file_size=dest_path.stat().st_size,
                taken_at=taken_at,
                camera_make=exif_dict.get("camera_make"),
                camera_model=exif_dict.get("camera_model"),
                iso=to_int(exif_dict.get("iso")),
                aperture=to_float(exif_dict.get("aperture")),
                shutter_speed=exif_dict.get("shutter_speed"),
                focal_length=to_float(exif_dict.get("focal_length")),
                gps_lat=to_float(exif_dict.get("gps_lat")),
                gps_lon=to_float(exif_dict.get("gps_lon")),
                rating=staged.rating,
                color_label=staged.color_label,
                immich_sync=staged.immich_sync,
            )
            db.add(image)
        db.flush()
        new_images.append(image)
        rows_since_commit += 1
        if rows_since_commit >= _COMMIT_CHUNK:
            db.commit()
            rows_since_commit = 0

    pair_siblings(new_images)
    # Cross-import pairing: a photo's RAW/JPEG partner may already be in the
    # library from an earlier import - link those up too (only the stems this
    # import touched, so the pass stays cheap).
    if new_images:
        pair_library(
            db,
            new_images[0].owner_id,
            stems={Path(img.original_filename).stem.lower() for img in new_images},
        )
    # Resolve each new photo's GPS fix to a country (offline) so it's filterable
    # by region straight after import.
    geocode.annotate_images(new_images)
    session.status = ImportSessionStatus.committed
    db.commit()
    _progress_done(session.id)

    # Decide whether freshly imported photos go to Immich. In "full" mode every
    # JPEG is synced automatically; in "manual" mode only when the user ticked
    # the per-import checkbox; in "selective" mode the photos flagged during
    # review (or all of them, via the action-bar "sync all" checkbox) are
    # flagged and uploaded.
    immich = get_immich_config(db)
    selective = immich is not None and immich.sync_mode == IMMICH_MODE_SELECTIVE
    if selective and sync_all_to_immich:
        for image in new_images:
            image.immich_sync = True
        db.commit()
    upload_all = immich is not None and (
        immich.sync_mode == IMMICH_MODE_FULL
        or (immich.sync_mode == IMMICH_MODE_MANUAL and upload_to_immich)
    )

    for image in new_images:
        db.refresh(image)
        image_path = settings.library_root / image.file_path
        enqueue_post_import(image.id, image_path)

        # Push only the JPEGs to Immich, never the RAWs.
        if immich and image.file_type == FileType.jpeg and (
            upload_all or (selective and image.immich_sync)
        ):
            enqueue_immich_upload(
                immich.base_url,
                immich.api_key,
                image_path,
                image.taken_at,
                image_id=image.id,
            )

    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    _drop_session_state(session.id)
    return new_images


def discard_import_session(db: Session, session: ImportSession) -> None:
    # Flip the status first: in-flight background analysis jobs re-check it
    # before touching the row, so they turn into no-ops instead of racing the
    # rmtree below.
    session.status = ImportSessionStatus.discarded
    db.commit()
    shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    _drop_session_state(session.id)
