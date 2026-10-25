"""The cached full-resolution renders (full.jpg / half.jpg) are kept under a
disk budget: the least recently used go first, the photo just rendered never.

conftest.py sets PM_DATA_DIR before these imports, so importing app modules at
module level is safe."""

import os
from pathlib import Path

from app.services import settings_store, thumbnails

MB = 1024 * 1024


def _write(root: Path, image_id: str, name: str, size: int, age_s: float) -> Path:
    path = root / image_id / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * size)
    stamp = 1_700_000_000 - age_s
    os.utime(path, (stamp, stamp))
    return path


def test_the_oldest_go_first_until_the_budget_fits(tmp_path):
    old = _write(tmp_path, "old", "full.jpg", 1 * MB, age_s=3000)
    mid = _write(tmp_path, "mid", "full.jpg", 1 * MB, age_s=2000)
    new = _write(tmp_path, "new", "full.jpg", 1 * MB, age_s=1000)
    assert thumbnails.gc_full_cache(2, root=tmp_path) == 1 * MB
    assert not old.exists() and mid.exists() and new.exists()
    assert thumbnails._full_cache_bytes == 2 * MB


def test_half_and_full_of_one_photo_are_separate_files(tmp_path):
    full = _write(tmp_path, "a", "full.jpg", 2 * MB, age_s=3000)
    half = _write(tmp_path, "a", "half.jpg", 1 * MB, age_s=1000)
    other = _write(tmp_path, "b", "thumbnail.jpg", 5 * MB, age_s=9000)
    assert thumbnails.gc_full_cache(1, root=tmp_path) == 2 * MB
    assert not full.exists() and half.exists()
    assert other.exists()  # the grid tiers are not this cache's business


def test_the_photo_being_rendered_is_kept_whatever_its_age(tmp_path):
    mine = _write(tmp_path, "mine", "full.jpg", 1 * MB, age_s=9000)
    other = _write(tmp_path, "other", "full.jpg", 1 * MB, age_s=100)
    assert thumbnails.gc_full_cache(1, exclude_image_id="mine", root=tmp_path) == 1 * MB
    assert mine.exists() and not other.exists()
    # Over budget with nothing else to take: the excluded file still stays.
    assert thumbnails.gc_full_cache(0.5, exclude_image_id="mine", root=tmp_path) == 0
    assert mine.exists()


def test_a_zero_budget_never_deletes_and_only_recounts(tmp_path):
    files = [_write(tmp_path, str(i), "full.jpg", 1 * MB, age_s=i * 100) for i in range(4)]
    assert thumbnails.gc_full_cache(0, root=tmp_path) == 0
    assert all(path.exists() for path in files)
    assert thumbnails._full_cache_bytes == 4 * MB


def test_a_read_marks_the_file_used(tmp_path):
    old = _write(tmp_path, "old", "full.jpg", 1 * MB, age_s=3000)
    new = _write(tmp_path, "new", "full.jpg", 1 * MB, age_s=1000)
    thumbnails.note_full_cache_hit(old)
    assert thumbnails.gc_full_cache(1, root=tmp_path) == 1 * MB
    assert old.exists() and not new.exists()


def test_a_write_updates_the_total_and_starts_the_collector_only_over_budget(tmp_path, monkeypatch):
    runs = []
    monkeypatch.setattr(thumbnails, "_full_cache_gc_run", lambda image_id: runs.append(image_id))
    monkeypatch.setattr(thumbnails, "_full_cache_gc_thread", None)
    monkeypatch.setattr(thumbnails, "_full_cache_bytes", 1 * MB)
    monkeypatch.setattr(thumbnails, "_full_cache_budget_bytes", 3 * MB)
    path = _write(tmp_path, "a", "full.jpg", 1 * MB, age_s=0)
    thumbnails._note_full_cache_write(path, "a")
    assert thumbnails._full_cache_bytes == 2 * MB and runs == []
    path = _write(tmp_path, "b", "full.jpg", 2 * MB, age_s=0)
    thumbnails._note_full_cache_write(path, "b")
    thumbnails._full_cache_gc_thread.join(5.0)
    assert runs == ["b"]
    # An unknown total (nothing counted yet, nothing left by a last run)
    # starts the first walk.
    monkeypatch.setattr(thumbnails, "_full_cache_bytes", None)
    monkeypatch.setattr(thumbnails, "_load_full_cache_total", lambda root: None)
    thumbnails._note_full_cache_write(path, "c")
    thumbnails._full_cache_gc_thread.join(5.0)
    assert runs == ["b", "c"]
    # Unlimited: nothing to collect, no thread.
    monkeypatch.setattr(thumbnails, "_full_cache_bytes", 100 * MB)
    monkeypatch.setattr(thumbnails, "_full_cache_budget_bytes", None)
    thumbnails._note_full_cache_write(path, "d")
    assert runs == ["b", "c"]


def test_a_stale_pair_leaves_the_total_when_the_edit_changes(tmp_path, monkeypatch):
    _write(tmp_path, "a", "full.jpg", 2 * MB, age_s=0)
    _write(tmp_path, "a", "half.jpg", 1 * MB, age_s=0)
    monkeypatch.setattr(thumbnails, "_full_cache_bytes", 5 * MB)
    thumbnails._unlink_full_cache(tmp_path / "a")
    assert not (tmp_path / "a" / "full.jpg").exists()
    assert thumbnails._full_cache_bytes == 2 * MB


def test_the_setting_defaults_and_clamps(monkeypatch):
    class Db:
        def __init__(self, value):
            self.value = value

    monkeypatch.setattr(settings_store, "get_setting", lambda db, key: db.value)
    assert settings_store.get_full_cache_budget_mb(Db(None)) == 4096
    assert settings_store.get_full_cache_budget_mb(Db("junk")) == 4096
    assert settings_store.get_full_cache_budget_mb(Db("0")) == 0
    assert settings_store.get_full_cache_budget_mb(Db("-5")) == 0
    assert settings_store.get_full_cache_budget_mb(Db("512")) == 512


def test_the_total_survives_a_restart_so_a_start_does_not_count(tmp_path, monkeypatch):
    """Counting is a stat per cached file; the number is kept beside the cache
    and read back, and only a missing number (or a budget overrun) walks."""
    from app.config import settings

    monkeypatch.setattr(settings, "thumbnail_cache_root", tmp_path)
    runs = []
    monkeypatch.setattr(thumbnails, "_full_cache_gc_run", lambda image_id: runs.append(image_id))
    monkeypatch.setattr(thumbnails, "_full_cache_gc_thread", None)
    monkeypatch.setattr(thumbnails, "_full_cache_budget_bytes", 10 * MB)
    # A last run left its number: known at once, no walk.
    thumbnails._save_full_cache_total(tmp_path, 1 * MB)
    monkeypatch.setattr(thumbnails, "_full_cache_bytes", None)
    path = _write(tmp_path, "a", "half.jpg", 1 * MB, age_s=0)
    thumbnails._note_full_cache_write(path, "a")
    assert thumbnails._full_cache_bytes == 2 * MB and runs == []
    assert thumbnails._load_full_cache_total(tmp_path) == 2 * MB
    # A collection writes what it counted.
    assert thumbnails.gc_full_cache(0, root=tmp_path) == 0
    assert thumbnails._load_full_cache_total(tmp_path) == 1 * MB
    # Dropping a pair keeps the number right too.
    thumbnails._unlink_full_cache(tmp_path / "a")
    assert thumbnails._load_full_cache_total(tmp_path) == 0


def test_the_collector_waits_for_a_pause_before_it_walks(tmp_path, monkeypatch):
    busy = iter([True, True, False])
    monkeypatch.setattr(thumbnails, "_full_cache_in_use", lambda idle_s: next(busy, False))
    monkeypatch.setattr(thumbnails, "_FULL_CACHE_GC_POLL_S", 0.0)
    monkeypatch.setattr(thumbnails, "_read_full_cache_budget_mb", lambda: 0)
    walked = []
    monkeypatch.setattr(thumbnails, "gc_full_cache", lambda budget_mb, exclude_image_id=None, root=None: walked.append(budget_mb) or 0)
    thumbnails._full_cache_gc_run("x")
    assert walked == [0]
    assert next(busy, "spent") == "spent"
