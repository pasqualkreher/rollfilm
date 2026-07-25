"""Bounds on concurrent derivative rendering.

Derivative generation is the memory-heavy thing this process does (~1GB peak for
a 26MP source), and it is reached from three independently sized pools - the
post-import workers, the maintenance rebuild pool and the on-demand thumbnail
endpoint, the last of which runs on uvicorn's 40-thread pool. Nothing bounded
their sum, so a grid of freshly imported photos scrolling into view could start
dozens of renders at once and take the machine into swap.

These cover both halves of the fix: renders are capped, AND the wait for a slot
is capped for request handlers, so the cure can't turn RAM exhaustion into
thread-pool exhaustion.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image as PILImage

from app.services import thumbnails


@pytest.fixture
def jpeg_source(tmp_path: Path) -> Path:
    """A JPEG big enough that the decode budget actually engages (its long edge
    is above PREVIEW_RENDER_MAX_PX)."""
    path = tmp_path / "shot.jpg"
    long_edge = thumbnails.PREVIEW_RENDER_MAX_PX * 2
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 256, (long_edge // 2, long_edge, 3), dtype=np.uint8)
    PILImage.fromarray(arr).save(path, "JPEG", quality=90)
    return path


# --- slot sizing --------------------------------------------------------------

def test_render_slots_leave_headroom():
    """The point of the cap is that the machine stays usable while a big import
    churns, so it must never claim every core."""
    assert thumbnails.RENDER_SLOTS >= 1
    cores = os.cpu_count() or 4
    if cores > 2:
        assert thumbnails.RENDER_SLOTS <= cores - 2


def _slots_for_ram(monkeypatch, ram_bytes: int) -> int:
    monkeypatch.setattr(thumbnails, "_physical_ram_bytes", lambda: ram_bytes)
    return thumbnails._render_slot_count()


def test_render_slots_bounded_by_ram(monkeypatch):
    """On a RAM-poor machine the budget, not the core count, has to be what
    limits the fleet - a third of RAM at ~1GB per render."""
    slots = _slots_for_ram(monkeypatch, 8 * 1024**3)
    assert slots <= 8 * 1024**3 // 3 // thumbnails._PEAK_BYTES_PER_RENDER


def test_a_tiny_machine_still_gets_one_slot(monkeypatch):
    """The budget may round to zero; rendering must never become impossible."""
    assert _slots_for_ram(monkeypatch, 1024**3) == 1


def test_more_ram_allows_more_slots(monkeypatch):
    """Sanity-check the budget is actually read: a big machine is limited by its
    cores instead."""
    big = _slots_for_ram(monkeypatch, 256 * 1024**3)
    small = _slots_for_ram(monkeypatch, 4 * 1024**3)
    assert big >= small


# --- admission ----------------------------------------------------------------

def test_request_sheds_when_slots_are_full(jpeg_source: Path):
    """With every slot taken, a caller that passed a timeout gives up with
    RenderBusy instead of queueing - that's what keeps server threads free."""
    held = []
    try:
        for _ in range(thumbnails.RENDER_SLOTS):
            assert thumbnails._render_slots.acquire(timeout=5)
            held.append(True)
        started = time.monotonic()
        with pytest.raises(thumbnails.RenderBusy):
            thumbnails.generate_derivatives("busy", jpeg_source, slot_timeout=0.1)
        # Gave up promptly rather than waiting for a slot that never came.
        assert time.monotonic() - started < 2.0
    finally:
        for _ in held:
            thumbnails._render_slots.release()


def test_background_caller_waits_instead_of_shedding(jpeg_source: Path):
    """slot_timeout=None (the background workers) must never shed - the
    derivative has to be produced, however long the queue is."""
    for _ in range(thumbnails.RENDER_SLOTS):
        assert thumbnails._render_slots.acquire(timeout=5)

    def release_soon():
        time.sleep(0.3)
        for _ in range(thumbnails.RENDER_SLOTS):
            thumbnails._render_slots.release()

    releaser = threading.Thread(target=release_soon)
    releaser.start()
    try:
        # Waits for the releaser rather than raising.
        thumbnails.generate_derivatives("patient", jpeg_source)
    finally:
        releaser.join()
    assert thumbnails.has_derivatives("patient")


def test_concurrent_renders_never_exceed_the_cap(jpeg_source: Path):
    """The gate is what actually bounds memory, so assert the observed
    concurrency, not just that the semaphore exists."""
    inside = 0
    peak = 0
    lock = threading.Lock()
    real_load = thumbnails.raw_service.load_linear_base

    def counting_load(*args, **kwargs):
        nonlocal inside, peak
        with lock:
            inside += 1
            peak = max(peak, inside)
        try:
            time.sleep(0.05)  # widen the window so overlap is observable
            return real_load(*args, **kwargs)
        finally:
            with lock:
                inside -= 1

    thumbnails.raw_service.load_linear_base = counting_load
    try:
        threads = [
            threading.Thread(
                target=thumbnails.generate_derivatives, args=(f"conc-{i}", jpeg_source)
            )
            for i in range(thumbnails.RENDER_SLOTS + 4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        thumbnails.raw_service.load_linear_base = real_load

    assert peak <= thumbnails.RENDER_SLOTS
    assert peak >= 1


# --- decode budget ------------------------------------------------------------

def test_decode_budget_does_not_shrink_the_thumbnail(jpeg_source: Path):
    """A JPEG is now decoded at only the resolution the derivatives need, but the
    grid thumbnail is a *fraction of the frame* - so it must still come out the
    size it would have at a full-resolution decode (see decode_reduction)."""
    with PILImage.open(jpeg_source) as im:
        orig_w, orig_h = im.size

    thumbnails.generate_derivatives("budget", jpeg_source)
    out = thumbnails.derivative_dir("budget")
    with PILImage.open(out / "thumbnail.jpg") as thumb:
        got_w, got_h = thumb.size

    expect_w = min(thumbnails.THUMBNAIL_MAX_PX, round(orig_w * thumbnails.THUMBNAIL_SCALE))
    expect_h = min(thumbnails.THUMBNAIL_MAX_PX, round(orig_h * thumbnails.THUMBNAIL_SCALE))
    # thumbnail() preserves aspect ratio, so allow a pixel of rounding slack.
    assert abs(got_w - expect_w) <= 2
    assert abs(got_h - expect_h) <= 2


def test_preview_still_reaches_the_full_cap(jpeg_source: Path):
    """The budget must not undershoot: preview.jpg is still capped at, and
    reaches, PREVIEW_RENDER_MAX_PX."""
    thumbnails.generate_derivatives("preview-cap", jpeg_source)
    with PILImage.open(thumbnails.derivative_dir("preview-cap") / "preview.jpg") as p:
        assert max(p.size) == thumbnails.PREVIEW_RENDER_MAX_PX


def test_cropped_render_keeps_its_resolution(jpeg_source: Path):
    """A crop divides the decode budget, so a heavily cropped photo still has
    enough pixels to fill the preview cap rather than being upscaled from a
    too-small decode."""
    thumbnails.generate_derivatives("cropped", jpeg_source, crop=(0.25, 0.25, 0.5, 0.5))
    with PILImage.open(thumbnails.derivative_dir("cropped") / "preview.jpg") as p:
        assert max(p.size) == thumbnails.PREVIEW_RENDER_MAX_PX


def test_raw_path_ignores_the_budget(tmp_path: Path):
    """decode_reduction is 1.0 for RAW (max_px has no effect on the demosaic),
    which is what keeps RAW derivatives byte-identical to before the change."""
    assert thumbnails.raw_service.decode_reduction(Path("x.raf"), (100, 200, 3)) == 1.0
