"""The batch copy job: many photos, each with the edit it held when the job
started, in the background - counted, stoppable, and never sunk by one broken
photo. The render of the next photo overlaps the previous photo's tail.
"""

import threading
import time
from datetime import datetime

import pytest
from PIL import Image as PILImage
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.models import FileType, Image, User
from app.services import copy_jobs, save_copy
from app.services.thumbnails import PreviewSuperseded


class _Helper:
    def terminate(self):
        pass


@pytest.fixture()
def db(monkeypatch, tmp_path) -> Session:
    # A file, not an in-memory database: the job and its finisher open their
    # own sessions on two threads, and the one shared connection an in-memory
    # database needs was used from both at once (a lost row now and then,
    # once a crash).
    engine = create_engine(f"sqlite:///{tmp_path / 'library.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    session = factory()
    session.add(User(id=1, username="local"))
    session.commit()
    for i in range(3):
        session.add(Image(
            id=f"p{i}", owner_id=1, file_path=f"2026/2026-07-01/p{i}.RAF", original_filename=f"p{i}.RAF",
            file_hash=f"h{i}", file_type=FileType.raw, file_size=3, taken_at=datetime(2026, 7, 1, 12, 0, i),
            edit_adjustments='{"exposure": 0.5}', edit_rev=1,
        ))
    session.commit()
    import app.db.session as db_session
    monkeypatch.setattr(db_session, "SessionLocal", factory)
    monkeypatch.setattr(copy_jobs.exif_service, "new_helper", lambda: _Helper())
    monkeypatch.setattr("app.workers.queue.schedule_embedding_backfill", lambda: None)
    monkeypatch.setattr(copy_jobs, "_jobs", {})
    yield session
    session.close()


def _stub_render(monkeypatch, on_render=None):
    rendered = []

    def render(src, edits, max_size=None, is_stale=None, timing=None, on_base=None):
        rendered.append(src.id)
        if on_render:
            on_render(src.id, is_stale)
        return PILImage.new("RGB", (8, 6), "red")

    monkeypatch.setattr(save_copy, "render_copy_frame", render)
    return rendered


def _stub_write(monkeypatch, fail_for=()):
    written = []

    def write(db, owner_id, src, edited, edits, quality, helper=None):
        if src.id in fail_for:
            raise RuntimeError("disk full")
        written.append((src.id, quality))
        copy = Image(
            id=f"copy-of-{src.id}", owner_id=owner_id, file_path=f"x/{src.id}_edit-1.jpg",
            original_filename=f"{src.id}_edit-1.jpg", file_hash=f"c{src.id}", file_type=FileType.jpeg,
            file_size=1, taken_at=src.taken_at,
        )
        db.add(copy)
        db.commit()
        return copy

    monkeypatch.setattr(save_copy, "write_copy", write)
    return written


def _wait(job_id: str, timeout: float = 5.0) -> dict:
    job = copy_jobs.get_job(job_id)
    deadline = time.monotonic() + timeout
    while job["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert job["state"] != "running", "the job did not finish"
    return job


def test_every_photo_is_copied_in_order_and_counted(db, monkeypatch):
    rendered = _stub_render(monkeypatch)
    written = _stub_write(monkeypatch)
    job_id = copy_jobs.start_copy_job(1, ["p0", "p1", "p2"], 92, None)
    job = _wait(job_id)
    assert job["state"] == "ready"
    assert rendered == ["p0", "p1", "p2"] and [w[0] for w in written] == ["p0", "p1", "p2"]
    assert written[0][1] == 92
    assert job["created_ids"] == ["copy-of-p0", "copy-of-p1", "copy-of-p2"]
    assert (job["done"], job["written"], job["skipped"]) == (3, 3, 0)
    assert copy_jobs.running_count() == 0


def test_an_edit_changed_after_the_start_does_not_reach_the_copy(db, monkeypatch):
    """A reset of p1 while p0 renders: p1's copy still has the edit."""
    gate = threading.Event()
    seen = {}

    def render(src, edits, max_size=None, is_stale=None, timing=None, on_base=None):
        if src.id == "p0":
            gate.wait(2.0)
        seen[src.id] = edits.normalized.get("exposure")
        return PILImage.new("RGB", (8, 6), "red")

    monkeypatch.setattr(save_copy, "render_copy_frame", render)
    _stub_write(monkeypatch)
    job_id = copy_jobs.start_copy_job(1, ["p0", "p1"], 100, None)
    db.get(Image, "p1").edit_adjustments = None
    db.commit()
    gate.set()
    job = _wait(job_id)
    assert job["state"] == "ready"
    assert seen == {"p0": 0.5, "p1": 0.5}


def test_one_broken_photo_is_skipped_not_fatal(db, monkeypatch):
    _stub_render(monkeypatch)
    _stub_write(monkeypatch, fail_for=("p1",))
    job = _wait(copy_jobs.start_copy_job(1, ["p0", "p1", "p2", "nope"], 100, None))
    assert job["state"] == "ready"
    assert job["created_ids"] == ["copy-of-p0", "copy-of-p2"]
    assert (job["done"], job["written"], job["skipped"]) == (4, 2, 2)


def test_cancel_stops_between_photos(db, monkeypatch):
    gate = threading.Event()

    def slow(image_id, is_stale):
        if image_id == "p0":
            gate.wait(2.0)

    _stub_render(monkeypatch, slow)
    _stub_write(monkeypatch)
    job_id = copy_jobs.start_copy_job(1, ["p0", "p1", "p2"], 100, None)
    assert copy_jobs.running_count() == 3
    copy_jobs.cancel_job(job_id)
    gate.set()
    job = _wait(job_id)
    assert job["state"] == "cancelled"
    # The photo under way is finished, the rest are not started.
    assert job["created_ids"] == ["copy-of-p0"] and job["done"] == 1


def test_cancel_mid_render_writes_nothing_of_that_photo(db, monkeypatch):
    def superseded(image_id, is_stale):
        if image_id == "p1":
            raise PreviewSuperseded()

    _stub_render(monkeypatch, superseded)
    written = _stub_write(monkeypatch)
    job = _wait(copy_jobs.start_copy_job(1, ["p0", "p1", "p2"], 100, None))
    assert [w[0] for w in written] == ["p0"]
    assert job["state"] in ("cancelled", "ready") and job["done"] == 1


def test_the_next_render_overlaps_the_previous_tail(db, monkeypatch):
    """p1's render starts while p0's copy is still being written."""
    writing_p0 = threading.Event()
    p1_rendering = threading.Event()

    def render(image_id, is_stale):
        if image_id == "p1":
            assert writing_p0.wait(2.0), "p0's tail had not started when p1 rendered"
            p1_rendering.set()

    _stub_render(monkeypatch, render)
    real_write = _stub_write(monkeypatch)

    def slow_write(db_, owner_id, src, edited, edits, quality, helper=None):
        if src.id == "p0":
            writing_p0.set()
            assert p1_rendering.wait(2.0), "p1 did not render while p0 was being written"
        return save_copy_write(db_, owner_id, src, edited, edits, quality, helper)

    save_copy_write = save_copy.write_copy
    monkeypatch.setattr(save_copy, "write_copy", slow_write)
    job = _wait(copy_jobs.start_copy_job(1, ["p0", "p1"], 100, None))
    assert job["state"] == "ready" and [w[0] for w in real_write] == ["p0", "p1"]


def test_a_finished_job_is_dropped_on_cancel_and_pruned_by_age(db, monkeypatch):
    _stub_render(monkeypatch)
    _stub_write(monkeypatch)
    job_id = copy_jobs.start_copy_job(1, ["p0"], 100, None)
    _wait(job_id)
    assert copy_jobs.cancel_job(job_id) and copy_jobs.get_job(job_id) is None
    assert not copy_jobs.cancel_job("unknown")
    job_id = copy_jobs.start_copy_job(1, ["p0"], 100, None)
    _wait(job_id)
    copy_jobs.get_job(job_id)["created"] -= copy_jobs._JOB_TTL_S + 1
    copy_jobs._prune()
    assert copy_jobs.get_job(job_id) is None


def test_the_render_waits_for_a_render_slot(db, monkeypatch):
    """A copy's full render counts against the render slots the thumbnail
    workers share: with every slot taken, it waits; it does not render beside
    them."""
    from app.services import thumbnails

    monkeypatch.setattr(thumbnails, "_render_slots", threading.BoundedSemaphore(1))
    rendered_at = threading.Event()
    _stub_render(monkeypatch, lambda image_id, is_stale: rendered_at.set())
    _stub_write(monkeypatch)
    assert thumbnails._render_slots.acquire(timeout=1)
    job_id = copy_jobs.start_copy_job(1, ["p0"], 100, None)
    assert not rendered_at.wait(0.3), "rendered while every slot was taken"
    thumbnails._render_slots.release()
    assert rendered_at.wait(2.0)
    assert _wait(job_id)["written"] == 1


def test_the_callers_own_edits_win_over_the_rows(db, monkeypatch):
    """"Edit a copy": the route hands the job the edit each copy is to get;
    the rows' saved edits (exposure 0.5) are not what is rendered."""
    from app.services import develop

    seen = {}

    def render(src, edits, max_size=None, is_stale=None, timing=None, on_base=None):
        seen[src.id] = edits.normalized.get("exposure")
        return PILImage.new("RGB", (8, 6), "red")

    monkeypatch.setattr(save_copy, "render_copy_frame", render)
    _stub_write(monkeypatch)
    look = develop.normalize({"exposure": 1.5})
    edits = {"p0": save_copy.CopyEdits(adjustments=look), "p1": save_copy.CopyEdits(adjustments=look)}
    job = _wait(copy_jobs.start_copy_job(1, ["p0", "p1"], 100, None, edits=edits))
    assert job["written"] == 2
    assert seen == {"p0": 1.5, "p1": 1.5}


def test_the_next_photo_is_decoded_while_the_current_one_renders(db, monkeypatch):
    """With a slot to spare, the render's on_base cue starts the next photo's
    decode; with every other slot taken it does not."""
    from app.services import thumbnails

    monkeypatch.setattr(copy_jobs, "PREFETCH_ON_LOW_RAM", True)
    prefetched: list[str] = []
    monkeypatch.setattr(thumbnails, "ensure_native_base", lambda image: prefetched.append(image.id))
    monkeypatch.setattr(thumbnails, "RENDER_SLOTS", 2)
    free = {"n": 1}  # ours taken, one spare
    monkeypatch.setattr(thumbnails, "render_slots_free", lambda: free["n"])

    def render(src, edits, max_size=None, is_stale=None, timing=None, on_base=None):
        if on_base:
            on_base()
        return PILImage.new("RGB", (8, 6), "red")

    monkeypatch.setattr(save_copy, "render_copy_frame", render)
    _stub_write(monkeypatch)
    job = _wait(copy_jobs.start_copy_job(1, ["p0", "p1", "p2"], 100, None))
    assert job["written"] == 3
    time.sleep(0.2)  # the prefetch threads
    assert sorted(prefetched) == ["p1", "p2"]
    # Another render busy (no spare slot): nothing is prefetched.
    prefetched.clear()
    free["n"] = 0
    _wait(copy_jobs.start_copy_job(1, ["p0", "p1"], 100, None))
    time.sleep(0.2)
    assert prefetched == []
