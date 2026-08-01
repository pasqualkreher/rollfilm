import hashlib
import json
import logging
import os
import queue
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
from app.services.hashing import perceptual_hash, sha256_file
from app.services.pairing import pair_library, pair_siblings
from app.services.raw import classify_file_type, extract_full_preview, extract_preview_with_size
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

# Long-edge cap of the staged lightbox preview. Written as a BYPRODUCT of
# work that already decoded the image (JPEG analysis / RAW demosaic), so
# opening a photo in the review lightbox is a plain file serve instead of an
# on-demand render.
STAGED_PREVIEW_PX = 2048


def staged_preview_path(session_id: str, staged_id: str) -> Path:
    return settings.import_staging_root / session_id / ".thumbnails" / f"{staged_id}.preview.jpg"


class UploadedFile(Protocol):
    """Structural type matching FastAPI's UploadFile - kept narrow so this
    module doesn't need to import Starlette directly.

    An upload may additionally carry an `mtime` attribute (epoch seconds of the
    *source* file, read via getattr) - staging stamps it onto the staged copy,
    so a photo without an EXIF capture date still sorts by its real file date
    instead of the moment it was imported."""

    filename: str | None
    file: BinaryIO


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
# Deliberately the SAME on every machine (no RAM scaling): each worker holds
# an exiftool helper process (~30MB) plus transient decode/file buffers.
# Sixteen of those on an 8GB machine, next to the demosaic pool and Electron,
# pushed the whole system into swap during big imports - and macOS eventually
# killed the backend outright (import froze mid-copy). Sized for the 4GB
# floor the app supports: six workers still keep analysis ahead of any real
# source medium (the decode gate below bounds their memory, not the count),
# and behavior stays predictable regardless of the host.
_STAGE_WORKERS = min(6, max(4, (os.cpu_count() or 4) * 2))


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
    # Denormalized copies of the EXIF fields the review grid shows, written
    # into their own columns so /files never parses exif_json per poll.
    taken_at: str | None
    camera_make: str | None
    camera_model: str | None
    width: int | None
    height: int | None


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
    sha256: str = "",
    data: bytes | None = None,
) -> _Analyzed:
    """Pure computation, safe to run on a worker thread (no DB access). The
    sha256 normally arrives from the copy loop (hashed inline right after the
    bytes landed, while they're guaranteed page-cache-hot even on small-RAM
    machines); the compute here only needs the SMALL reads - embedded
    preview and EXIF headers - which go through the trickle gate one at a
    time while a copy runs. Each step is guarded so a single corrupt file
    can't abort a large import - it's still staged, just without a
    hash/preview."""
    perceptual = None
    exif = ExifData()

    if not sha256:
        # Fallback (restart self-heal - the inline hash was lost with the
        # process): a full cold read, throttled like everything else.
        try:
            with _AdaptiveReadGate():
                sha256 = sha256_file(staged_path)
        except Exception:
            logger.exception("Hashing failed for %s (staged without a hash)", original_filename)

    try:
        # The disk read inside extract_preview_with_size runs under the IO
        # gate (protects spinning-disk staging from seek thrash against the
        # copy stream); the decode itself runs under the decode gate, which
        # bounds the transient memory of concurrent decodes.
        with _analysis_decode_gate:
            preview, (orig_w, orig_h) = extract_preview_with_size(
                staged_path, io_gate=_AdaptiveReadGate(), data=data
            )
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
        # Non-RAW: the decode in hand IS what the lightbox shows - write the
        # preview now (atomic; the preview route serves it as its cache) so
        # opening this photo large is instant, never an on-demand render.
        # RAWs get theirs from the demosaic job instead (the embedded JPEG
        # here is the camera's rendering, not the sensor's).
        if file_type != FileType.raw.value:
            preview.thumbnail((STAGED_PREVIEW_PX, STAGED_PREVIEW_PX), PILImage.LANCZOS)
            tmp_path = thumb_dir / f"{staged_id}.preview.tmp"
            preview.save(tmp_path, "JPEG", quality=88)
            os.replace(tmp_path, thumb_dir / f"{staged_id}.preview.jpg")
    except Exception:
        logger.exception("Preview/thumbnail failed for %s (staged without one)", original_filename)

    try:
        # exiftool reads the file's header structures with SEEKS - several of
        # these in parallel past the gate were the last reader still fighting
        # the copy stream on a spinning staging disk. Same adaptive gate as
        # the preview read: 4 slots normally, a single slot while copying.
        with _AdaptiveReadGate():
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
        taken_at=exif.taken_at.isoformat() if exif.taken_at else None,
        camera_make=exif.camera_make,
        camera_model=exif.camera_model,
        width=exif.width,
        height=exif.height,
    )


# Bytes of copied files currently teed to analysis jobs (see
# _copy_into_staging). Hard global budget so a lagging analysis pool can
# never balloon memory - a file whose bytes don't fit is analyzed from disk
# (trickled) instead. 96MB ≈ two-three typical RAWs; sized for the 4GB-RAM
# floor (the tee is an optimization - losing it costs a little disk read,
# never correctness).
_PAYLOAD_MAX_FILE = 64 * 1024**2
_PAYLOAD_BUDGET = 96 * 1024**2
_payload_used = 0
_payload_lock = threading.Lock()
_analysis_payload: dict[str, bytes] = {}


def _payload_try_reserve(n: int) -> bool:
    global _payload_used
    with _payload_lock:
        if _payload_used + n > _PAYLOAD_BUDGET:
            return False
        _payload_used += n
        return True


def _payload_release(n: int) -> None:
    global _payload_used
    with _payload_lock:
        _payload_used = max(0, _payload_used - n)


def _payload_take(staged_id: str) -> bytes | None:
    """Hand the teed bytes to their analysis job (ownership transfers; the
    caller must _payload_release(len(...)) when done)."""
    with _payload_lock:
        return _analysis_payload.pop(staged_id, None)


def _payload_drop_all() -> None:
    global _payload_used
    with _payload_lock:
        _analysis_payload.clear()
        _payload_used = 0


def _copy_into_staging(upload: UploadedFile, dest: Path) -> tuple[int, str, bytes | None]:
    """Land one file in staging at media speed - reading the source exactly
    ONCE. The stream is teed three ways as it passes through: to the
    destination (via a bounded queue + writer thread, so source reads and
    destination writes overlap), into sha256, and - budget permitting - into
    an in-memory payload handed to the analysis job. That last part is what
    keeps the staging disk from ever being READ during a copy: re-reading
    each file for analysis cost real throughput on an HDD ("MB/s sinks once
    analysis starts"), because the pages were already evicted again on
    small-RAM machines. Returns (size, sha256-hex, payload-or-None)."""
    size = 0
    digest = hashlib.sha256()
    chunks: list[bytes] | None = []
    reserved = 0
    q: "queue.Queue[bytes | None]" = queue.Queue(maxsize=4)
    write_error: list[BaseException] = []

    def _writer() -> None:
        try:
            with dest.open("wb") as out:
                while True:
                    chunk = q.get()
                    if chunk is None:
                        return
                    out.write(chunk)
        except BaseException as e:
            write_error.append(e)
            # Keep draining so the (bounded) queue never blocks the reader.
            while q.get() is not None:
                pass

    writer = threading.Thread(target=_writer, name="import-copy-writer", daemon=True)
    writer.start()
    try:
        while not write_error:
            chunk = upload.file.read(8 * 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
            if chunks is not None:
                if size > _PAYLOAD_MAX_FILE or not _payload_try_reserve(len(chunk)):
                    _payload_release(reserved)
                    reserved = 0
                    chunks = None  # too big / budget full - analyze from disk
                else:
                    reserved += len(chunk)
                    chunks.append(chunk)
            q.put(chunk)
    finally:
        q.put(None)
        writer.join()
    if write_error:
        _payload_release(reserved)
        raise write_error[0]
    payload = b"".join(chunks) if chunks else None
    return size, digest.hexdigest(), payload


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

# Gate on the analysis workers' heavy file reads (preview extraction reads
# the staged original). The pool is sized for CPU overlap (~2x cores), but on
# a spinning-disk staging area 16 concurrent readers turn the copy stream
# writing to the same disk into pure seek thrash - HDD-to-HDD imports crawled.
# Four concurrent reads keep an HDD mostly sequential; on SSDs reads are fast
# enough that the gate is rarely even contended.
_analysis_read_gate = threading.BoundedSemaphore(4)

# Gate on the memory-heavy DECODE section (payload + BytesIO copy + LibRaw's
# internal buffer ≈ 3x the file size in flight per worker): eight workers
# bursting through a catch-up wave held ~1GB transiently, which on an 8GB
# machine kicked the system into swap and visibly dented the copy's io rate.
# Two concurrent decodes (~7 files/s) still outrun any real source medium
# and keep the transient peak ~400MB - safe on the 4GB-RAM floor.
_analysis_decode_gate = threading.BoundedSemaphore(2)

# While a copy phase is ACTIVE the disk belongs to the copy stream: analysis
# reads narrow to a single slot. Side-by-side measurement (Finder vs import,
# SD -> external HDD) showed the interleaved analysis read-back costing the
# copy nearly half its throughput; with a single trickle slot the analysis
# still inches forward (mostly page-cache hits for freshly copied files) and
# opens back up to all four slots the moment copying finishes.
_analysis_copy_trickle = threading.BoundedSemaphore(1)


class _AdaptiveReadGate:
    """Context manager handed to extract_preview_with_size: the 4-slot gate
    always, plus the single trickle slot while any import is still copying -
    the staging disk sees at most ONE analysis reader beside the copy
    stream. The reads taken through here are the small ones (embedded
    preview, EXIF headers); the full-file hash happens inline in the copy
    loop where the bytes are guaranteed cache-hot."""

    def __enter__(self):
        _analysis_read_gate.acquire()
        self._trickled = _staging_copy_active()
        if self._trickled:
            _analysis_copy_trickle.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._trickled:
            _analysis_copy_trickle.release()
        _analysis_read_gate.release()

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

# Per-file metadata for queued analysis jobs, handed over IN MEMORY by the
# copy loop - the job must not depend on its DB row existing yet (rows are
# written in lazy batches; the DB read remains only as the self-heal
# fallback after a restart). Cleared when a file finishes processing or the
# session is dropped.
_analysis_meta: dict[str, tuple[int, str, str, str, str]] = {}  # id -> (owner, rel_path, filename, type, sha256)
_analysis_meta_lock = threading.Lock()

# Per-session change counter for the review poll's cheap "unchanged" answer:
# every mutation of a session's staged data (rows landing, analysis results,
# rating/selection edits, a demosaic thumb arriving) bumps it, and /files
# short-circuits when the client already has the current version - the O(n)
# load+serialize then only runs when something actually changed. Seeded from
# the wall clock so a backend restart (which empties this dict) can never
# resume at a number a client already holds.
_session_versions: dict[str, int] = {}
_session_versions_lock = threading.Lock()


def get_session_version(session_id: str) -> int:
    with _session_versions_lock:
        v = _session_versions.get(session_id)
        if v is None:
            v = int(time.time() * 1000)
            _session_versions[session_id] = v
        return v


def bump_session_version(session_id: str) -> None:
    with _session_versions_lock:
        cur = _session_versions.get(session_id)
        _session_versions[session_id] = (cur if cur is not None else int(time.time() * 1000)) + 1


# --- In-memory review view -----------------------------------------------
# THE source the review poll serves from. During an import the DB is written
# in batched chunks only; every field the review grid shows lives in these
# plain dicts, updated in place as files land / analyze / demosaic. Before
# this view existed the 1s poll loaded ALL n staged rows through the ORM,
# recomputed pairs and stat()ed every RAW - O(n) work per second that grew
# with the import and (via the GIL) visibly slowed the copy loop the longer
# an import ran. Serving from memory makes the poll O(n) dict copies, ~1ms
# at multi-thousand-file scale. The DB stays authoritative for commit and
# restarts; a missing view (fresh process) is rebuilt from the DB once.
_files_view: dict[str, dict[str, dict]] = {}  # session id -> staged id -> row
_files_view_pairs: dict[str, dict[str, str]] = {}
_files_view_pairs_dirty: set[str] = set()
_files_view_lock = threading.Lock()


def _new_view_row(staged_id: str, original_filename: str, file_type: str) -> dict:
    """A just-copied, not-yet-analyzed file, mirroring the model defaults."""
    return {
        "id": staged_id,
        "original_filename": original_filename,
        "file_type": file_type,
        "selected": True,
        "rating": 0,
        "color_label": "none",
        "duplicate_of_image_id": None,
        "duplicate_of_staged_file_id": None,
        "is_near_duplicate": False,
        "duplicate_in_trash": False,
        "paired_staged_file_id": None,
        "taken_at": None,
        "camera_make": None,
        "camera_model": None,
        "width": None,
        "height": None,
        "immich_sync": False,
        "has_demosaic_thumb": False,
        "processed": False,
    }


def add_view_rows(session_id: str, rows: list[dict]) -> None:
    with _files_view_lock:
        view = _files_view.setdefault(session_id, {})
        for r in rows:
            view[r["id"]] = r
        _files_view_pairs_dirty.add(session_id)
    bump_session_version(session_id)


def update_view_row(session_id: str, staged_id: str, fields: dict) -> None:
    with _files_view_lock:
        row = _files_view.get(session_id, {}).get(staged_id)
        if row is not None:
            row.update(fields)
    bump_session_version(session_id)


def mark_demosaic_ready(session_id: str, staged_id: str) -> None:
    update_view_row(session_id, staged_id, {"has_demosaic_thumb": True})


def _view_pairs(view: dict[str, dict]) -> dict[str, str]:
    """Same pairing rule as compute_staged_pairs, over the view rows."""
    by_stem: dict[str, list[dict]] = defaultdict(list)
    for r in view.values():
        by_stem[Path(r["original_filename"]).stem.lower()].append(r)
    pairs: dict[str, str] = {}
    for group in by_stem.values():
        raws = [r for r in group if r["file_type"] == FileType.raw.value]
        jpegs = [r for r in group if r["file_type"] == FileType.jpeg.value]
        if len(raws) == 1 and len(jpegs) == 1:
            pairs[raws[0]["id"]] = jpegs[0]["id"]
            pairs[jpegs[0]["id"]] = raws[0]["id"]
    return pairs


def _rebuild_view_from_db(db: Session, session: ImportSession) -> None:
    """Restart path: reconstruct the in-memory view from the DB once (plus
    one trash-state query and one demosaic stat per RAW - costs that used to
    run on EVERY poll)."""
    staged = list(session.staged_files)
    dup_ids = {f.duplicate_of_image_id for f in staged if f.duplicate_of_image_id}
    trashed: set[str] = set()
    if dup_ids:
        trashed = {
            row.id
            for row in db.query(Image.id)
            .filter(Image.id.in_(dup_ids), Image.deleted_at.isnot(None))
            .all()
        }
    rows: dict[str, dict] = {}
    for f in staged:
        row = _new_view_row(f.id, f.original_filename, f.file_type.value)
        row.update(
            selected=f.selected,
            rating=f.rating,
            color_label=f.color_label.value,
            duplicate_of_image_id=f.duplicate_of_image_id,
            duplicate_of_staged_file_id=f.duplicate_of_staged_file_id,
            is_near_duplicate=f.is_near_duplicate,
            duplicate_in_trash=f.duplicate_of_image_id in trashed,
            taken_at=f.taken_at,
            camera_make=f.camera_make,
            camera_model=f.camera_model,
            width=f.width,
            height=f.height,
            immich_sync=f.immich_sync,
            has_demosaic_thumb=(
                f.file_type == FileType.raw
                and staged_demosaic_path(session.id, f.id).exists()
            ),
            processed=f.processed,
        )
        rows[f.id] = row
    with _files_view_lock:
        _files_view[session.id] = rows
        _files_view_pairs_dirty.add(session.id)


def get_session_files_view(db: Session, session: ImportSession) -> list[dict]:
    """The review poll's payload: shallow copies of the view rows with the
    current pairing attached. Pure dict work - no ORM, no disk."""
    with _files_view_lock:
        have = session.id in _files_view
    if not have:
        _rebuild_view_from_db(db, session)
    with _files_view_lock:
        view = _files_view.get(session.id, {})
        if session.id in _files_view_pairs_dirty or session.id not in _files_view_pairs:
            _files_view_pairs[session.id] = _view_pairs(view)
            _files_view_pairs_dirty.discard(session.id)
        pairs = _files_view_pairs[session.id]
        return [dict(r, paired_staged_file_id=pairs.get(rid)) for rid, r in view.items()]


def get_view_row(session_id: str, staged_id: str) -> dict | None:
    """One row (for PATCH responses), with pairing attached."""
    with _files_view_lock:
        view = _files_view.get(session_id)
        if view is None or staged_id not in view:
            return None
        if session_id in _files_view_pairs_dirty or session_id not in _files_view_pairs:
            _files_view_pairs[session_id] = _view_pairs(view)
            _files_view_pairs_dirty.discard(session_id)
        return dict(view[staged_id], paired_staged_file_id=_files_view_pairs[session_id].get(staged_id))

# --- Demosaiced RAW staging thumbnails (background) ---------------------------
# A RAW card thumbnailed from its embedded camera JPEG looks pixel-identical
# to its JPEG sibling; the review grid wants the actual sensor rendering. The
# demosaic is expensive (~seconds per 40MP X-Trans file), so it runs HERE, on
# its own small pool, fed eagerly as each RAW finishes analysis - the grid
# serves the fast embedded thumb meanwhile and swaps when the real one lands
# (the /files poll carries a has_demosaic_thumb flag that busts the img URL).
# Deliberately the SAME on every machine (no RAM scaling): a half-size
# demosaic of a 40MP X-Trans file peaks well past 400MB with its float
# intermediates. Six of them (the old CPU-based sizing) drove an 8GB machine
# deep into swap until macOS killed the backend mid-import; a SINGLE worker
# caps the worst case at ~500MB - the ceiling that keeps a 4GB machine out
# of swap - and the program's behavior predictable everywhere. The demosaic
# is a background nicety (the embedded-preview thumb carries the card until
# it lands), so halving its throughput costs no interaction anywhere. RAWs
# only ever demosaic AFTER the copy phase, so this pool never competes with
# an active import.
_STAGED_DEMOSAIC_WORKERS = 1

_staged_demosaic_executor = ThreadPoolExecutor(
    max_workers=_STAGED_DEMOSAIC_WORKERS,
    thread_name_prefix="staged-raw-thumb",
)

# Belt-and-braces: if a NEW copy starts while post-copy demosaics are already
# rendering, at most one proceeds alongside it.
_staged_demosaic_copy_cap = threading.BoundedSemaphore(1)
_staged_demosaic_inflight: set[str] = set()
_staged_demosaic_lock = threading.Lock()


def staged_demosaic_path(session_id: str, staged_id: str) -> Path:
    return settings.import_staging_root / session_id / ".thumbnails" / f"{staged_id}.demosaic.jpg"


# Monotonic timestamp of the last copied file, updated by the copy loop.
# _staging_copy_active treats the copy as live for a grace period past it:
# between two batches `copied == total` holds for a moment, and gating on the
# counters alone let the deferred demosaic jobs wake at EVERY batch boundary
# and rip into the disk alongside the next batch - imports got slower, not
# faster. The client keeps two batches in flight, so a real end of copying is
# the only thing that lets the grace period lapse.
_last_copy_activity = 0.0


def _touch_copy_activity() -> None:
    global _last_copy_activity
    _last_copy_activity = time.monotonic()


# NO hot-window/cache heuristics anymore (they behaved differently per
# machine - fast for one page-cache-sized burst, then a cliff): analysis
# never needs a big read (the hash happens inline in the copy loop), and
# demosaics simply wait for the copy to end. Same behavior everywhere.


# Count of staging REQUESTS currently executing (or queued on the staging
# lock). This - not the copied/total counters - is what decides whether a
# copy is live: a batch that died mid-way (SD card yanked, request aborted)
# leaves `copied < total` behind FOREVER, and gating on the counters froze
# the whole analysis backlog ("Analyzing 125/208" forever, import locked).
_staging_requests_inflight = 0
_staging_inflight_lock = threading.Lock()


def _staging_request_begin() -> None:
    global _staging_requests_inflight
    with _staging_inflight_lock:
        _staging_requests_inflight += 1
    _touch_copy_activity()


def _staging_request_end() -> None:
    global _staging_requests_inflight
    with _staging_inflight_lock:
        _staging_requests_inflight -= 1


def _staging_copy_active() -> bool:
    """Whether a copy is LIVE right now: a staging request is in flight, or
    one landed a file within the grace window (covers the moment between two
    double-buffered batches). Deliberately NOT the copied/total counters -
    they stay behind forever when a batch dies. The demosaic pool and the
    analysis wait loop defer to this. The grace only needs to bridge the
    client's batch round-trip (double-buffered, so near zero) - every extra
    second here is dead time in which the deferred analysis backlog sits
    idle after the copy actually finished."""
    if time.monotonic() - _last_copy_activity < 2.0:
        return True
    with _staging_inflight_lock:
        return _staging_requests_inflight > 0


def schedule_staged_raw_demosaic(session_id: str, staged_id: str, staged_rel_path: str) -> None:
    """Queue one RAW staged file's demosaiced grid thumbnail. Deduped; safe to
    call again (analysis completion AND any cache-miss thumbnail request call
    in here). Never blocks the caller."""
    demosaic_path = staged_demosaic_path(session_id, staged_id)
    source_path = settings.import_staging_root / staged_rel_path
    with _staged_demosaic_lock:
        if staged_id in _staged_demosaic_inflight:
            return
        _staged_demosaic_inflight.add(staged_id)

    _staged_demosaic_executor.submit(_run_demosaic, session_id, staged_id, staged_rel_path)


def _run_demosaic(session_id: str, staged_id: str, staged_rel_path: str) -> None:
    demosaic_path = staged_demosaic_path(session_id, staged_id)
    source_path = settings.import_staging_root / staged_rel_path
    deferred = False
    try:
        if demosaic_path.exists() or not source_path.exists():
            return
        # NEVER demosaic while a copy runs - each render churns ~500MB of
        # working set and a fat read, which stole the disk and the page
        # cache from the import (and on small machines helped push the
        # system into swap). Deferred RAWs are resubmitted by the drainer
        # the moment the copy ends; the embedded-preview thumb carries the
        # card meanwhile. Same rule on every machine.
        if _staging_copy_active():
            deferred = True
            with _deferred_analysis_lock:
                _deferred_demosaic.append((session_id, staged_id, staged_rel_path))
            return

        def _render() -> None:
            preview = extract_full_preview(source_path)
            # Match the staging thumb's sizing: a quarter of the original
            # (the demosaic is half-size, so half of it), capped like the
            # library's grid thumbnails.
            tw = min(max(1, round(preview.width * 0.5)), THUMBNAIL_MAX_PX)
            th = min(max(1, round(preview.height * 0.5)), THUMBNAIL_MAX_PX)
            # ONE demosaic feeds both outputs, biggest first: the lightbox
            # preview (this exact render is what the preview route would
            # demosaic AGAIN on first open - seconds per RAF, now free)...
            preview.thumbnail((STAGED_PREVIEW_PX, STAGED_PREVIEW_PX), PILImage.LANCZOS)
            lb_tmp = staged_preview_path(session_id, staged_id).with_suffix(".tmp")
            preview.save(lb_tmp, "JPEG", quality=88)
            os.replace(lb_tmp, staged_preview_path(session_id, staged_id))
            # ...then the grid thumbnail (tw/th <= THUMBNAIL_MAX_PX 1600 <
            # STAGED_PREVIEW_PX, so this only ever shrinks further).
            preview.thumbnail((tw, th), PILImage.LANCZOS)
            tmp_path = demosaic_path.with_suffix(".tmp")
            preview.save(tmp_path, "JPEG", quality=88)
            os.replace(tmp_path, demosaic_path)
            # Flip has_demosaic_thumb in the in-memory view (bumps the
            # version, so the next poll swaps the card's thumb).
            mark_demosaic_ready(session_id, staged_id)

        if _staging_copy_active():
            with _staged_demosaic_copy_cap:
                _render()
        else:
            _render()
    except Exception:
        logger.exception("Demosaiced staging thumbnail failed for %s", source_path.name)
    finally:
        if not deferred:
            with _staged_demosaic_lock:
                _staged_demosaic_inflight.discard(staged_id)


class _SessionDedupState:
    """Per-import-session duplicate-detection index, shared by all analysis
    jobs of that session. Duplicate = EXACT byte match (sha256), nothing
    fuzzier - perceptual near-matching used to live here too, but flagging
    "possible duplicates" the user then had to judge cost more review
    attention than it saved (and its worst failure mode was hiding a photo
    that was in fact new). The library's hash index is loaded once per
    session; every processed staged file is appended so later files dedup
    against earlier ones. The lock also serializes the per-file DB write,
    which keeps the "first one processed is the original, the rest are its
    duplicates" ordering consistent."""

    def __init__(self) -> None:
        # Reentrant: the writer-enqueue helpers take it too, and analysis
        # calls them while already holding it for the dedup bookkeeping.
        self.lock = threading.RLock()
        # Serializes the one-time library-index load SEPARATELY from the hot
        # lock: the load scans the whole images table, which on a busy/cold
        # HDD can take a long time - holding state.lock through it parked
        # every analysis worker AND the copy loop (its writer enqueue takes
        # state.lock), freezing the import right after the first analyzed
        # file.
        self.load_lock = threading.Lock()
        self.loaded = False
        self.image_by_hash: dict[str, tuple[str, str | None]] = {}  # sha -> (image id, source_root_id)
        self.staged_by_hash: dict[str, str] = {}  # sha -> staged file id
        # SINGLE WRITER: all staged-row persistence of this session funnels
        # through these buffers - new rows from the copy loop, field updates
        # from analysis and the demosaic - and lands in the DB in one batched
        # transaction every _DB_FLUSH_CHUNK items / _DB_FLUSH_S seconds.
        # During an import to a saturated HDD *any* write syscall to that
        # volume can stall for hundreds of ms (writeback throttling - fsync
        # or not), so the copy path must not touch the DB per file at all.
        # An update for a row still waiting in pending_inserts merges into
        # the insert - ordering races between the two streams can't exist.
        self.pending_inserts: dict[str, dict] = {}
        self.pending_updates: dict[str, dict] = {}
        # Ids whose INSERT has committed - an update may only flush once its
        # row is confirmed in the DB (flushing it alongside/before its own
        # in-flight insert raised StaleDataError and rolled back the batch).
        self.inserted_ids: set[str] = set()
        # Serializes whole flush transactions (state.lock only guards the
        # buffer swaps, never the DB write).
        self.flush_lock = threading.Lock()
        self.last_flush = time.monotonic()


_session_states: dict[str, _SessionDedupState] = {}
_session_states_lock = threading.Lock()


def _session_state(session_id: str) -> _SessionDedupState:
    with _session_states_lock:
        state = _session_states.get(session_id)
        if state is None:
            state = _session_states[session_id] = _SessionDedupState()
        return state


def _drop_session_state(session_id: str) -> None:
    """Forget a finished (committed/discarded) session's in-memory dedup index,
    review view and progress counters."""
    with _files_view_lock:
        _files_view.pop(session_id, None)
        _files_view_pairs.pop(session_id, None)
        _files_view_pairs_dirty.discard(session_id)
    with _session_states_lock:
        _session_states.pop(session_id, None)
    with _progress_lock:
        _progress.pop(session_id, None)
    # The analysis jobs' in-memory metadata/payload handoffs are per-import;
    # drop them with the session so they never outgrow one import.
    with _analysis_meta_lock:
        _analysis_meta.clear()
    _payload_drop_all()


def _ensure_dedup_loaded(state: _SessionDedupState, session_id: str, owner_id: int) -> None:
    """Load the library's dedup indexes once per session - WITHOUT holding
    state.lock (see load_lock above): the queries run into local dicts and
    are merged under the hot lock only at the end. Also seeds the staged
    index with this session's already-processed files (matters after a
    backend restart mid-analysis). Idempotent and safe to call from a
    background prewarm thread AND lazily from analysis."""
    if state.loaded:
        return
    with state.load_lock:
        if state.loaded:
            return
        image_by_hash: dict[str, tuple[str, str | None]] = {}
        staged_by_hash: dict[str, str] = {}
        inserted: set[str] = set()
        db = SessionLocal()
        try:
            for row in db.query(Image.id, Image.file_hash, Image.source_root_id).filter(
                Image.owner_id == owner_id
            ):
                image_by_hash.setdefault(row.file_hash, (row.id, row.source_root_id))
            for existing in (
                db.query(ImportStagedFile.id, ImportStagedFile.sha256)
                .filter(
                    ImportStagedFile.import_session_id == session_id,
                    ImportStagedFile.processed.is_(True),
                )
                .all()
            ):
                if existing.sha256:
                    staged_by_hash.setdefault(existing.sha256, existing.id)
            # Rows already durable in the DB (restart / earlier flushes) count
            # as inserted - the writer holds an update back until its row is
            # confirmed, and without this seed a re-analyzed file's update
            # would wait forever.
            for row in (
                db.query(ImportStagedFile.id)
                .filter(ImportStagedFile.import_session_id == session_id)
                .all()
            ):
                inserted.add(row.id)
        finally:
            db.close()
        with state.lock:
            for k, v in image_by_hash.items():
                state.image_by_hash.setdefault(k, v)
            for k, v in staged_by_hash.items():
                state.staged_by_hash.setdefault(k, v)
            state.inserted_ids.update(inserted)
            state.loaded = True


def prewarm_dedup_index(session_id: str, owner_id: int) -> None:
    """Kick the library-index load off in the background the moment a staging
    session starts, so it overlaps with the copy instead of ambushing the
    first analyzed file."""
    state = _session_state(session_id)
    if state.loaded:
        return
    threading.Thread(
        target=_ensure_dedup_loaded,
        args=(state, session_id, owner_id),
        name="import-dedup-prewarm",
        daemon=True,
    ).start()


# The single writer's flush thresholds. Restart mid-import can lose at most
# this window of staged-row bookkeeping (the files themselves are safely in
# the staging folder; the source medium still has them too) - a deliberate
# trade for a copy loop that never blocks on the DB.
_DB_FLUSH_CHUNK = 25
_DB_FLUSH_S = 5.0


def _writer_enqueue_insert(state: _SessionDedupState, row: dict) -> None:
    with state.lock:
        state.pending_inserts[row["id"]] = row


def _writer_enqueue_update(state: _SessionDedupState, staged_id: str, fields: dict) -> None:
    with state.lock:
        pending = state.pending_inserts.get(staged_id)
        if pending is not None:
            pending.update(fields)  # merges into the not-yet-inserted row
        else:
            state.pending_updates.setdefault(staged_id, {"id": staged_id}).update(fields)


def _writer_should_flush(state: _SessionDedupState) -> bool:
    with state.lock:
        n = len(state.pending_inserts) + len(state.pending_updates)
        return n > 0 and (
            n >= _DB_FLUSH_CHUNK or time.monotonic() - state.last_flush >= _DB_FLUSH_S
        )


def _writer_flush(state: _SessionDedupState) -> float:
    """Land buffered inserts (plus updates whose rows are confirmed) in ONE
    short transaction; returns the seconds spent. A fresh DB session per
    flush - never a long-lived transaction (a stale WAL snapshot, and a
    pinned reader mark that blocks checkpointing). Updates for rows whose
    insert hasn't committed yet stay buffered for the next flush."""
    with state.flush_lock:
        with state.lock:
            inserts = list(state.pending_inserts.values())
            insert_ids = list(state.pending_inserts.keys())
            state.pending_inserts = {}
            updates = [
                state.pending_updates.pop(k)
                for k in list(state.pending_updates)
                if k in state.inserted_ids
            ]
            state.last_flush = time.monotonic()
        if not inserts and not updates:
            return 0.0
        t0 = time.monotonic()
        db = SessionLocal()
        try:
            if inserts:
                db.bulk_insert_mappings(ImportStagedFile, inserts)
            # bulk_update_mappings needs uniform key sets - group by shape (an
            # analysis update carries `selected` only for duplicate hits: a plain
            # row must NOT have its user-editable selection overwritten).
            by_keys: dict[frozenset, list[dict]] = defaultdict(list)
            for u in updates:
                by_keys[frozenset(u.keys())].append(u)
            for group in by_keys.values():
                db.bulk_update_mappings(ImportStagedFile, group)
            db.commit()
            with state.lock:
                state.inserted_ids.update(insert_ids)
        except Exception:
            db.rollback()
            # The view keeps the state; a crash before a later successful flush
            # self-heals on restart (missing/unprocessed rows -> re-staged jobs).
            logger.exception(
                "Batched staged-row write failed (%d inserts, %d updates)",
                len(inserts),
                len(updates),
            )
        finally:
            db.close()
        return time.monotonic() - t0


def flush_analysis_buffer(session_id: str) -> None:
    """Force everything buffered for this session into the DB - commit and any
    other DB-authoritative reader must call this first."""
    with _session_states_lock:
        state = _session_states.get(session_id)
    if state is not None:
        # Twice: the first pass may insert rows whose updates were held back
        # (insert-not-yet-confirmed); the second pass lands those updates.
        _writer_flush(state)
        _writer_flush(state)


def _flush_stale_analysis_buffers() -> None:
    """Drainer duty: buffered rows never sit unwritten longer than the flush
    window (the chunk trigger alone would strand a trailing partial chunk)."""
    with _session_states_lock:
        states = list(_session_states.values())
    for state in states:
        if _writer_should_flush(state):
            _writer_flush(state)


def _apply_analysis(session_id: str, owner_id: int, a: _Analyzed) -> None:
    """Record one file's analysis results: the in-memory view (what the
    review poll shows) is updated immediately, the DB row joins the next
    batched write. Serialized per session via the dedup-state lock (the
    index reads/updates and the 'earlier file wins' ordering both need it)."""
    state = _session_state(session_id)
    # The one-time library-index load runs OUTSIDE the hot lock (a prewarm
    # thread usually finished it already during the first batch's copy).
    _ensure_dedup_loaded(state, session_id, owner_id)

    with state.lock:
        with _files_view_lock:
            row = _files_view.get(session_id, {}).get(a.id)
            already = row is not None and row["processed"]
        if already:
            return

        update: dict = {
            "id": a.id,
            "sha256": a.sha256 or None,
            "perceptual_hash": a.perceptual_hash,
            "exif_json": a.exif_json,
            "taken_at": a.taken_at,
            "camera_make": a.camera_make,
            "camera_model": a.camera_model,
            "width": a.width,
            "height": a.height,
            "duplicate_of_image_id": None,
            "duplicate_of_staged_file_id": None,
            "processed": True,
        }
        view_fields: dict = {
            "taken_at": a.taken_at,
            "camera_make": a.camera_make,
            "camera_model": a.camera_model,
            "width": a.width,
            "height": a.height,
            "processed": True,
        }

        # Exact library match first, then exact match earlier in this
        # session. `a.sha256` can be "" when hashing failed (unreadable
        # file) - such a file must never dedup against anything.
        exact_image = state.image_by_hash.get(a.sha256) if a.sha256 else None
        if exact_image is not None:
            image_id, source_root_id = exact_image
            update["duplicate_of_image_id"] = image_id
            view_fields["duplicate_of_image_id"] = image_id
            # Trash state is read fresh (not from the session-lifetime dedup
            # index): the user may well have trashed the photo just before
            # re-importing it.
            dup_deleted = False
            if source_root_id is None:
                db = SessionLocal()
                try:
                    dup_row = db.get(Image, image_id)
                    dup_deleted = dup_row is not None and dup_row.deleted_at is not None
                finally:
                    db.close()
                if not dup_deleted:
                    # Byte-identical to a visible managed-library photo - don't
                    # re-import by default (the API also rejects re-selecting it).
                    update["selected"] = False
                    view_fields["selected"] = False
            # else: the only copy is indexed in place from an external source
            # root (importing promotes it) or sits in the Trash (importing
            # the same bytes is the explicit way to bring it back, mirroring
            # the source-root rule) - leave it selected.
            view_fields["duplicate_in_trash"] = dup_deleted
        elif a.sha256 and a.sha256 in state.staged_by_hash:
            dup_staged = state.staged_by_hash[a.sha256]
            update["duplicate_of_staged_file_id"] = dup_staged
            update["selected"] = False
            view_fields["duplicate_of_staged_file_id"] = dup_staged
            view_fields["selected"] = False
        # Deliberately NO perceptual near-matching (user decision): only
        # byte-identical files count as duplicates. The phash is still
        # computed and stored - similarity features use it elsewhere.

        _writer_enqueue_update(state, a.id, update)

        if a.sha256:
            state.staged_by_hash.setdefault(a.sha256, a.id)

    # The card flips from placeholder to fully-formed the moment the view
    # knows about it (bumps the session version -> next poll ships it).
    update_view_row(session_id, a.id, view_fields)
    # Analysis meta was only needed until this file was processed.
    with _analysis_meta_lock:
        _analysis_meta.pop(a.id, None)
    # Outside the state lock: the DB write must never serialize the analysis
    # pool behind a saturated disk.
    if _writer_should_flush(state):
        _writer_flush(state)


def _run_analysis(session_id: str, staged_id: str) -> None:
    """One background analysis job: do the per-file compute, persist the
    result. Runs IMMEDIATELY for every file, first to last - no hot/cold
    deferral: the expensive full-file read (sha256) already happened inline
    in the copy loop, and the small reads left here go through the one-slot
    trickle while a copy is live. That keeps the review filling at a CONSTANT
    pace for the whole import instead of fast-for-a-cache-window, then
    cliff. Never raises - a single bad file must not take the worker thread
    (or the import) down with it."""
    try:
        with _analysis_meta_lock:
            meta = _analysis_meta.get(staged_id)
        if meta is not None:
            # Fast path: everything the job needs came along in memory - no
            # DB dependency (the row may not even be inserted yet).
            owner_id, staged_rel_path, original_filename, file_type, sha256 = meta
            with _files_view_lock:
                row = _files_view.get(session_id, {}).get(staged_id)
            if row is None or row["processed"]:
                return  # session dropped (discard/commit) or already done
        else:
            # Self-heal fallback (restart lost the in-memory handoff): the
            # row was durably written by then, read it once.
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
                staged_rel_path = staged.staged_path
                original_filename = staged.original_filename
                file_type = staged.file_type.value
                sha256 = staged.sha256 or ""
            finally:
                db.close()
        staged_full_path = settings.import_staging_root / staged_rel_path
        if not staged_full_path.exists():
            return  # discarded session - the folder is gone

        # The copy loop teed this file's bytes to us (budget permitting):
        # decode straight from RAM, never read the staging disk mid-copy.
        payload = _payload_take(staged_id)
        try:
            thumb_dir = settings.import_staging_root / session_id / ".thumbnails"
            analyzed = _analyze_file(
                staged_full_path,
                original_filename,
                file_type,
                staged_id,
                thumb_dir,
                _thread_helper(),
                sha256=sha256,
                data=payload,
            )
        finally:
            if payload is not None:
                _payload_release(len(payload))
                payload = None
        _apply_analysis(session_id, owner_id, analyzed)
        _progress_step(session_id)
        # RAWs: queue the demosaiced grid thumbnail (deferred until the copy
        # finishes on machines/moments where it would fight the copy - the
        # embedded-preview thumb carries the card meanwhile).
        if file_type == FileType.raw.value:
            schedule_staged_raw_demosaic(session_id, staged_id, staged_rel_path)
    except Exception:
        logger.exception("Background analysis failed for staged file %s", staged_id)
    finally:
        with _inflight_lock:
            _inflight.discard(staged_id)


# RAW demosaics that stepped aside for a live copy. Entries stay in the
# demosaic inflight set while parked here (so re-schedules dedupe); the
# drainer resubmits them the moment no copy is live anymore.
_deferred_demosaic: list[tuple[str, str, str]] = []
_deferred_analysis_lock = threading.Lock()


# Tests flip this to inspect the deferred list without the drainer racing
# them; never touched in production.
_drainer_paused = False


def _drain_deferred_loop() -> None:
    while True:
        if _drainer_paused:
            time.sleep(0.05)
            continue
        # Trailing partial write chunks must not sit unwritten (the chunk
        # trigger alone would strand the last few files of a session).
        _flush_stale_analysis_buffers()
        if _staging_copy_active():
            time.sleep(0.25)
            continue
        with _deferred_analysis_lock:
            if not _deferred_demosaic:
                time.sleep(0.25)
                continue
            demosaic_batch = list(_deferred_demosaic)
            _deferred_demosaic.clear()
        for sid, fid, rel in demosaic_batch:
            _staged_demosaic_executor.submit(_run_demosaic, sid, fid, rel)


threading.Thread(
    target=_drain_deferred_loop, name="import-analyze-drain", daemon=True
).start()


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
    # Read pending work from the in-memory view (kept in lockstep with the
    # jobs) - touching the ORM here made every poll O(n) DB work.
    with _files_view_lock:
        view = _files_view.get(session.id)
        if view is None:
            # Fresh process - the poll's view rebuild (get_session_files_view)
            # runs first; the next poll lands here with the view in place.
            return
        pending = [rid for rid, r in view.items() if not r["processed"]]
        total = len(view)
    if not pending:
        return
    # Rebuild the in-memory progress entry after a restart, so the UI's
    # processed/total readout picks up where it left off.
    with _progress_lock:
        if session.id not in _progress:
            p = _progress_new("staging", total)
            p["copied"] = total
            p["processed"] = total - len(pending)
            _progress[session.id] = p
    for staged_id in pending:
        _enqueue_analysis(session.id, staged_id)


# The client deliberately keeps two staging requests in flight. The copy work
# itself must not interleave though - two batches writing into the same
# session folder could race the unique-filename check - so it's serialized
# behind one process-wide lock. Copying is fast (analysis happens in the
# background), so the wait is short.
_staging_lock = threading.Lock()

# Review visibility is per file via the in-memory view; DB persistence is
# the session writer's batched flush (_DB_FLUSH_CHUNK/_DB_FLUSH_S above).


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
        # Bytes fully landed in staging - the UI's copy rate/ETA runs on
        # bytes, not file count (a run of big RAFs after small JPEGs made a
        # count-based ETA GROW mid-import).
        "copied_bytes": 0,
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


def _progress_copy_step(session_id: str, n: int = 1, nbytes: int = 0) -> None:
    with _progress_lock:
        p = _progress.get(session_id)
        if p is not None:
            p["copied"] += n
            p["copied_bytes"] += nbytes


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
    copy_live = _staging_copy_active()
    with _progress_lock:
        for p in _progress.values():
            # `copied < total` only counts while a copy is actually LIVE - a
            # batch that died (yanked SD card) leaves that gap behind forever,
            # and treating it as active starved the embedding backfill until
            # the next restart. Analysis debt is measured against what was
            # really copied, not against the dead plan.
            if p["phase"] == "staging" and (
                (copy_live and p["copied"] < p["total"])
                or p["processed"] < min(p["copied"], p["total"])
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
        copied_bytes = p.get("copied_bytes", 0)
        recent = list(p["recent"])
    # A copy that DIED mid-batch (yanked SD card, aborted request) never
    # reaches its planned total. Once no copy is live anymore, the honest
    # denominator is what actually landed - otherwise "Analyzing 125/208"
    # never completes and the UI keeps the import locked forever.
    if phase == "staging" and total > copied and not _staging_copy_active():
        total = copied
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
        "copied_bytes": copied_bytes,
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
    # COMMIT (not flush) before the copy starts: a flush would hold this
    # request's SQLite write lock through the entire copy, and every batched
    # writer flush in the meantime would slam into it ("database is locked").
    # The copy loop itself never writes through this session anymore.
    db.commit()
    # Start loading the library's dedup index NOW, in parallel with the first
    # batch's copy - lazily loaded, it ambushed the first analyzed file and
    # (holding the session lock on a slow disk) froze the whole import.
    prewarm_dedup_index(session.id, owner_id)
    _staging_request_begin()
    try:
        with _staging_lock:
            _stage_uploads_into(db, session, owner_id, uploads)
            db.commit()
    finally:
        _staging_request_end()
    db.refresh(session)
    return session


def append_uploaded_files(
    db: Session, session: ImportSession, owner_id: int, uploads: list[UploadedFile]
) -> ImportSession:
    """Stage another batch of uploads into an existing staging session. The
    multipart parser caps a single request at 1000 files, so big imports are
    sent as several requests all appending to one session - duplicate checks
    and RAW+JPEG pairing still see the whole session, not just one batch."""
    # No-op when the first batch already loaded it; covers backend restarts
    # between two appended batches.
    prewarm_dedup_index(session.id, owner_id)
    _staging_request_begin()
    try:
        with _staging_lock:
            # This request's read transaction began before the lock was acquired
            # (the route already loaded the session row). End it so the copy phase
            # below starts fresh against whatever a concurrent batch committed.
            db.rollback()
            _stage_uploads_into(db, session, owner_id, uploads)
            db.commit()
    finally:
        _staging_request_end()
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
    io_seconds = 0.0
    db_seconds = 0.0
    _progress_add_total(session.id, len(incoming))
    _touch_copy_activity()
    state = _session_state(session.id)
    last_discard_check = time.monotonic()

    def _session_discarded() -> bool:
        # A FRESH short-lived session: the request's own session must not be
        # touched (on the first batch it still holds the uncommitted
        # ImportSession row - a rollback here silently destroyed it), and a
        # fresh connection's snapshot always sees a committed discard.
        check_db = SessionLocal()
        try:
            status = (
                check_db.query(ImportSession.status)
                .filter(ImportSession.id == session.id)
                .scalar()
            )
        finally:
            check_db.close()
        # None = the session row itself isn't committed yet (first batch) -
        # the client doesn't even know the id, so it can't have discarded it.
        return status is not None and status != ImportSessionStatus.staging

    # Copying stays serial: sequential reads are what source media (SD card,
    # NAS, upload spool) do best, and the analysis pool works alongside. The
    # loop NEVER touches the DB per file: the row goes to the session writer
    # (batched transaction every ~25 files / 5s), the review sees the file
    # via the in-memory view immediately, and the analysis job gets its
    # metadata handed over in memory. On a saturated HDD any per-file DB
    # write stalled the copy for hundreds of ms - and got worse as the WAL
    # and the poll's read marks grew.
    for upload, original_filename, file_type in incoming:
        staged_path = session_dir / original_filename
        counter = 1
        while staged_path.exists():
            staged_path = (
                session_dir
                / f"{Path(original_filename).stem}_{counter}{Path(original_filename).suffix}"
            )
            counter += 1

        t0 = time.monotonic()
        size, sha256, payload = _copy_into_staging(upload, staged_path)
        io_seconds += time.monotonic() - t0
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
        staged_rel = str(staged_path.relative_to(settings.import_staging_root))
        # Beat the copy-activity heartbeat (the trickle gate and the demosaic
        # deferral key off it).
        _touch_copy_activity()
        # Tee handoff: the analysis job decodes from these bytes in RAM - the
        # staging disk is never read while the copy runs.
        if payload is not None:
            with _payload_lock:
                _analysis_payload[staged_id] = payload
        _writer_enqueue_insert(
            state,
            {
                "id": staged_id,
                "import_session_id": session.id,
                "staged_path": staged_rel,
                "original_filename": original_filename,
                "file_type": FileType(file_type),
                # bulk_insert_mappings skips Python-side column defaults -
                # every remaining column is spelled out.
                "sha256": sha256 or None,
                "perceptual_hash": None,
                "exif_json": None,
                "taken_at": None,
                "camera_make": None,
                "camera_model": None,
                "width": None,
                "height": None,
                "processed": False,
                "duplicate_of_image_id": None,
                "duplicate_of_staged_file_id": None,
                "is_near_duplicate": False,
                "selected": True,
                "rating": 0,
                "color_label": ColorLabel.none,
                "immich_sync": False,
            },
        )
        with _analysis_meta_lock:
            _analysis_meta[staged_id] = (owner_id, staged_rel, original_filename, file_type, sha256)
        _progress_copy_step(session.id, nbytes=size)
        # Visible in the review grid right away (bumps the poll version) and
        # queued for analysis immediately - both purely in memory.
        add_view_rows(session.id, [_new_view_row(staged_id, original_filename, file_type)])
        _enqueue_analysis(session.id, staged_id)

        if _writer_should_flush(state):
            t0 = time.monotonic()
            _writer_flush(state)
            db_seconds += time.monotonic() - t0

        # A cancel mid-import discards the session while this batch is still
        # copying (the client can only abort its own request, not this loop).
        # Without the recheck the loop kept writing files into the folder the
        # discard had just deleted - orphaned staging data that piled up on
        # disk with every aborted import.
        if time.monotonic() - last_discard_check >= 2.0:
            last_discard_check = time.monotonic()
            if _session_discarded():
                logger.info("staging aborted: session %s was discarded mid-copy", session.id)
                shutil.rmtree(session_dir, ignore_errors=True)
                return

    t0 = time.monotonic()
    _writer_flush(state)
    db_seconds += time.monotonic() - t0
    if _session_discarded():
        shutil.rmtree(session_dir, ignore_errors=True)
        return

    # One line per batch so a slow import is diagnosable from the server log
    # alone, with the wall time split into its phases: `io` is the pipelined
    # read+hash+write, `db` the row commits, the remainder is loop overhead.
    # io MB/s at the source medium's speed = the medium is the bottleneck.
    elapsed = time.monotonic() - started
    logger.info(
        "import batch copied: %d files (%.0f MB) in %.1fs [io %.1fs @ %.0f MB/s, db %.1fs, other %.1fs]",
        len(incoming),
        total_bytes / 1e6,
        elapsed,
        io_seconds,
        (total_bytes / 1e6 / io_seconds) if io_seconds > 0 else 0.0,
        db_seconds,
        max(0.0, elapsed - io_seconds - db_seconds),
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
            # Without a known hash (analysis couldn't read the file) no
            # candidate can be verified as ours - claim nothing.
            if not staged.sha256 or sha256_file(candidate) != staged.sha256:
                continue
            rel = str(candidate.relative_to(settings.library_root))
            owned = db.query(Image.id).filter(Image.file_path == rel).first()
            if owned is None:
                return candidate
        return None

    # Analysis results are buffered in memory and written in chunks - the
    # commit plan below reads the DB, so everything pending must land first,
    # and this session's (older) read snapshot must end to see the write.
    flush_analysis_buffer(session.id)
    db.commit()

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
        # Same filesystem (the normal setup - staging lives inside the library
        # volume): each move is a metadata rename, parallelize freely. Across
        # filesystems every move is a real copy - cap the workers so a
        # spinning target disk does a few long sequential writes instead of
        # sixteen interleaved ones (seek thrash).
        try:
            same_dev = (
                settings.import_staging_root.stat().st_dev == settings.library_root.stat().st_dev
            )
        except OSError:
            same_dev = False
        move_workers = min(_STAGE_WORKERS if same_dev else 4, len(to_move))
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
                # Hashing failed during analysis (rare - unreadable file that
                # somehow still committed): hash the library copy now rather
                # than write a NULL into images.file_hash.
                file_hash=staged.sha256 or sha256_file(dest_path),
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
                lens_model=exif_dict.get("lens_model"),
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
    # Wait for any in-flight staging batch to notice the flip before deleting
    # the folder (the copy loop rechecks after every ~300ms flush and bails) -
    # otherwise the still-running copy re-created files right after the rmtree.
    with _staging_lock:
        shutil.rmtree(settings.import_staging_root / session.id, ignore_errors=True)
    _drop_session_state(session.id)
