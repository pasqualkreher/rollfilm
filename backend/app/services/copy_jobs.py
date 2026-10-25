"""Copies of many photos at once, in the background.

The grid's "Apply ... and save copy" and "Save copy of N photos" hand their
ids here; one job renders each photo with the edit it held when the job was
asked for and writes it into the library as a new photo (services/save_copy),
while the client polls for the count and can stop it between photos. The
render of the next photo and the rest of the previous one - its encode,
metadata, row and thumbnails - run on two threads: the full render is the
one thing that cannot share the machine (thumbnails._full_render_lock),
everything after it fits beside the next. The render also holds one of the
render slots the thumbnail workers queue on (thumbnails.render_admission):
a bulk "apply and copy" queues hundreds of re-renders, and a copy's
full-resolution frame beside two of those was the third gigabyte on an 8 GB
machine - the job then "hung" in swap for minutes before its first copy.
At most one finished frame waits for its turn, so the job holds two 8-bit
frames at the outside beside the render's own working set.

Jobs are in memory (single-process app); one that nobody asks about any
more goes with the TTL prune, like the export jobs.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from uuid import uuid4

from app.services import exif as exif_service
from app.services import machine
from app.services import save_copy
from app.services import thumbnails
from app.services.thumbnails import PreviewSuperseded

logger = logging.getLogger(__name__)

# The decode of the NEXT photo runs while the current one's pipeline does
# (the decode is one core, the pipeline every core): a copy then costs about
# the longer of the two instead of their sum. It also costs a second decode's
# memory beside the pipeline's working set, so it runs only while nothing
# else holds a render slot - and, on a machine short of memory, only when
# this is switched on (measured off by default: see the bench in memory).
PREFETCH_ON_LOW_RAM = False

_JOB_TTL_S = 30 * 60
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _bump(job: dict, **fields: int) -> None:
    """Add to a job's counters. The render thread (a photo skipped before its
    render) and the finisher (a photo written or failed) both count, and a
    bare += from two threads lost updates."""
    with _jobs_lock:
        for key, n in fields.items():
            job[key] += n


def _prune() -> None:
    now = time.monotonic()
    with _jobs_lock:
        for jid in [jid for jid, job in _jobs.items() if now - job["created"] > _JOB_TTL_S]:
            _jobs.pop(jid, None)


def _snapshot_edits(owner_id: int, image_ids: list[str]) -> dict[str, save_copy.CopyEdits]:
    """Every photo's edit as it stands when the job is asked for. A big job
    runs for hours, and the copies are of the look the user applied: a reset
    or another preset on those photos meanwhile must not reach the copies
    still to come (it did - the rest of a batch came out unedited)."""
    from app.db.models import Image
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        edits: dict[str, save_copy.CopyEdits] = {}
        for image_id in image_ids:
            src = db.get(Image, image_id)
            if src is not None and src.owner_id == owner_id:
                edits[image_id] = save_copy.CopyEdits.from_row(src)
        return edits
    finally:
        db.close()


def start_copy_job(
    owner_id: int, image_ids: list[str], quality: int, max_size: int | None,
    edits: dict[str, save_copy.CopyEdits] | None = None,
) -> str:
    """Begin copying `image_ids` (the caller has checked they are the
    owner's) at `quality`, capped to `max_size` on the long edge, each with
    the edit it holds right now - or with `edits`, the caller's own per photo
    ("Edit a copy": a look on the copies, the originals untouched); returns
    the job id to poll."""
    _prune()
    if edits is None:
        edits = _snapshot_edits(owner_id, image_ids)
    job_id = uuid4().hex
    job = {
        "state": "running",
        "done": 0,
        "written": 0,
        "skipped": 0,
        "total": len(image_ids),
        "created_ids": [],
        "current_id": None,
        "error": None,
        "owner_id": owner_id,
        "created": time.monotonic(),
        "cancel": threading.Event(),
    }
    with _jobs_lock:
        _jobs[job_id] = job
    threading.Thread(
        target=_run_copy_job,
        args=(job_id, owner_id, list(image_ids), edits, quality, max_size),
        name=f"copy-job-{job_id[:8]}",
        daemon=True,
    ).start()
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


def cancel_job(job_id: str) -> bool:
    """Stop a running job between photos (the copy under way is finished
    unless its render has not started); a finished one is dropped."""
    job = _jobs.get(job_id)
    if job is None:
        return False
    if job["state"] == "running":
        job["cancel"].set()
    else:
        with _jobs_lock:
            _jobs.pop(job_id, None)
    return True


def running_count() -> int:
    """Photos still to copy across every running job - what the desktop
    shell's quit check reports as work in progress. Unlike renders or the
    search index, a copy not written when the app quits is not made later."""
    return sum(job["total"] - job["done"] for job in list(_jobs.values()) if job["state"] == "running")


def _run_copy_job(
    job_id: str, owner_id: int, image_ids: list[str], snapshot: dict[str, save_copy.CopyEdits],
    quality: int, max_size: int | None,
) -> None:
    from app.db.models import Image
    from app.db.session import SessionLocal
    from app.workers.queue import schedule_embedding_backfill

    job = _jobs[job_id]
    cancel: threading.Event = job["cancel"]
    # The job's own exiftool: the shared helper is one process with one pipe,
    # and an import may be reading through it right now.
    helper = exif_service.new_helper()
    finisher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="copy-finish")
    pending: Future | None = None
    started = time.monotonic()
    logger.info("Copy job %s: %d photo(s), quality %d, max size %s", job_id, len(image_ids), quality, max_size)

    def prefetch_allowed() -> bool:
        if cancel.is_set():
            return False
        if machine.LOW_RAM and not PREFETCH_ON_LOW_RAM:
            return False
        # Our own slot is the one taken; any other heavy render makes this
        # decode the third big thing in memory.
        return thumbnails.render_slots_free() >= thumbnails.RENDER_SLOTS - 1

    def prefetch(image_id: str) -> None:
        db = SessionLocal()
        try:
            nxt = db.get(Image, image_id)
            if nxt is not None and nxt.deleted_at is None and not cancel.is_set():
                thumbnails.ensure_native_base(nxt)
        except Exception:
            logger.debug("Copy job %s: prefetch of %s failed", job_id, image_id, exc_info=True)
        finally:
            db.close()

    def finish(
        image_id: str, edited, edits: save_copy.CopyEdits, render_s: float, decode_s: float, prefetched: bool
    ) -> None:
        db = SessionLocal()
        t0 = time.monotonic()
        try:
            src = db.get(Image, image_id)
            if src is None:
                raise RuntimeError("the photo is gone")
            new_image = save_copy.write_copy(db, owner_id, src, edited, edits, quality, helper=helper)
            job["created_ids"].append(new_image.id)
            _bump(job, written=1)
            logger.info(
                "Copy job %s: %s (render %.1f s of it decode %.1f s, write %.1f s, next prefetched: %s)",
                job_id, new_image.original_filename, render_s, decode_s, time.monotonic() - t0,
                "yes" if prefetched else "no",
            )
        except Exception:
            logger.exception("Copy job %s: could not write the copy of %s - skipping", job_id, image_id)
            _bump(job, skipped=1)
        finally:
            db.close()
            _bump(job, done=1)

    db = SessionLocal()
    try:
        for index, image_id in enumerate(image_ids):
            if cancel.is_set():
                break
            job["current_id"] = image_id
            src = db.get(Image, image_id)
            if src is None or src.deleted_at is not None or src.owner_id != owner_id:
                _bump(job, skipped=1, done=1)
                continue
            edits = snapshot.get(image_id) or save_copy.CopyEdits.from_row(src)
            logger.info(
                "Copy job %s: rendering %s (%d of %d)", job_id, src.original_filename, job["done"] + 1, job["total"]
            )
            t0 = time.monotonic()
            timing: dict = {}
            # Once this render holds its base, the next photo's decode may
            # start beside its pipeline (see PREFETCH_ON_LOW_RAM).
            following = image_ids[index + 1] if index + 1 < len(image_ids) else None
            prefetched = {"started": False}

            def on_base(following: str | None = following) -> None:
                if following is None or not prefetch_allowed():
                    return
                prefetched["started"] = True
                threading.Thread(
                    target=prefetch, args=(following,), name=f"copy-prefetch-{job_id[:8]}", daemon=True
                ).start()

            try:
                with thumbnails.render_admission(None):
                    edited = save_copy.render_copy_frame(
                        src, edits, max_size, is_stale=cancel.is_set, timing=timing, on_base=on_base
                    )
            except PreviewSuperseded:
                break  # cancelled mid-render: nothing of this photo is written
            except Exception:
                logger.exception("Copy job %s: could not render %s - skipping", job_id, image_id)
                _bump(job, skipped=1, done=1)
                continue
            # The previous photo's tail first: never more than one finished
            # frame waiting, or a fast render would pile frames up in memory.
            if pending is not None:
                pending.result()
            pending = finisher.submit(
                finish, image_id, edited, edits, time.monotonic() - t0, timing.get("decode", 0.0) / 1000.0,
                prefetched["started"],
            )
            del edited
        if pending is not None:
            pending.result()
        job["state"] = "cancelled" if cancel.is_set() and job["done"] < job["total"] else "ready"
    except Exception as e:
        logger.exception("Copy job %s failed", job_id)
        job["error"] = str(e) or "Copying failed"
        job["state"] = "error"
    finally:
        job["current_id"] = None
        db.close()
        finisher.shutdown(wait=True)
        try:
            helper.terminate()
        except Exception:
            pass
        logger.info(
            "Copy job %s %s: %d written, %d skipped of %d in %.0f s",
            job_id, job["state"], job["written"], job["skipped"], job["total"], time.monotonic() - started,
        )
        if job["written"]:
            # The copies' search embeddings: the backfill picks them up from
            # the previews rendered with them.
            schedule_embedding_backfill()
