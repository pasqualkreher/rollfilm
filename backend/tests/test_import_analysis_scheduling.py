"""Import scheduling contract - deliberately IDENTICAL on every machine:
analysis runs immediately for every staged file (the full-file hash happens
inline in the copy loop; the remaining small reads are throttled by the
one-slot trickle gate while a copy is live), and RAW demosaics always step
aside for a live copy. The review fills at a constant pace from the first
file to the last.
"""

import time

import pytest

from app.services import import_pipeline as ip


@pytest.fixture(autouse=True)
def _clean_scheduling_state():
    ip._drainer_paused = True
    with ip._deferred_analysis_lock:
        ip._deferred_demosaic.clear()
    with ip._inflight_lock:
        ip._inflight.clear()
    with ip._analysis_meta_lock:
        ip._analysis_meta.clear()
    ip._last_copy_activity = 0.0
    yield
    ip._drainer_paused = False
    with ip._deferred_analysis_lock:
        ip._deferred_demosaic.clear()
    with ip._inflight_lock:
        ip._inflight.clear()
    with ip._analysis_meta_lock:
        ip._analysis_meta.clear()
    ip._last_copy_activity = 0.0


def test_analysis_runs_immediately_during_copy(monkeypatch, tmp_path):
    """Any file during a live copy is analyzed right away (constant review
    pace) - never deferred, never parking the worker - and the inline hash
    travels through so the job never re-reads the whole file."""
    staged_id = "file-1"
    session_id = "session-1"
    ip._touch_copy_activity()  # copy is "live"

    staged_file = tmp_path / "a.jpg"
    staged_file.write_bytes(b"x")

    monkeypatch.setattr(ip.settings, "import_staging_root", tmp_path)
    with ip._analysis_meta_lock:
        ip._analysis_meta[staged_id] = (1, staged_file.name, "a.jpg", "jpeg", "sha-inline")
    with ip._files_view_lock:
        ip._files_view[session_id] = {staged_id: ip._new_view_row(staged_id, "a.jpg", "jpeg")}

    analyzed = []
    monkeypatch.setattr(ip, "_analyze_file", lambda *a, **k: analyzed.append((a, k)) or None)
    applied = []
    monkeypatch.setattr(ip, "_apply_analysis", lambda *a: applied.append(a))
    monkeypatch.setattr(ip, "_progress_step", lambda *a: None)

    with ip._inflight_lock:
        ip._inflight.add(staged_id)
    start = time.monotonic()
    ip._run_analysis(session_id, staged_id)
    elapsed = time.monotonic() - start

    assert analyzed, "file must be analyzed immediately during a live copy"
    assert analyzed[0][1].get("sha256") == "sha-inline"
    assert applied, "result must be applied"
    assert elapsed < 0.4, "job must not park the worker thread"
    with ip._inflight_lock:
        assert staged_id not in ip._inflight

    with ip._files_view_lock:
        ip._files_view.pop(session_id, None)


def test_adaptive_gate_trickles_during_copy():
    """During a live copy the gate funnels analysis reads through the single
    trickle slot; with no copy running the trickle stays untouched."""
    ip._touch_copy_activity()  # copy is "live"
    with ip._AdaptiveReadGate():
        assert not ip._analysis_copy_trickle.acquire(blocking=False), (
            "gate must hold the trickle slot while a copy is live"
        )

    ip._last_copy_activity = 0.0  # copy long over
    with ip._AdaptiveReadGate():
        assert ip._analysis_copy_trickle.acquire(blocking=False)
        ip._analysis_copy_trickle.release()


def test_demosaic_always_defers_during_copy(monkeypatch, tmp_path):
    """A RAW demosaic must always step aside while a copy is live - on every
    machine (its ~500MB working set and fat read stole the disk and page
    cache from the import)."""
    staged_id = "raw-1"
    session_id = "session-1"
    ip._touch_copy_activity()

    src = tmp_path / "s" / "raw.raf"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"x")
    monkeypatch.setattr(ip.settings, "import_staging_root", tmp_path)

    rendered = []
    monkeypatch.setattr(ip, "extract_full_preview", lambda *a: rendered.append(a))

    with ip._staged_demosaic_lock:
        ip._staged_demosaic_inflight.add(staged_id)
    ip._run_demosaic(session_id, staged_id, "s/raw.raf")

    assert not rendered, "no demosaic may run while a copy is live"
    with ip._deferred_analysis_lock:
        assert (session_id, staged_id, "s/raw.raf") in ip._deferred_demosaic
    with ip._staged_demosaic_lock:
        # Still inflight: re-schedules must dedupe against the parked entry.
        assert staged_id in ip._staged_demosaic_inflight
        ip._staged_demosaic_inflight.discard(staged_id)
