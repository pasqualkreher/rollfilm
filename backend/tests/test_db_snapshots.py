"""Copies of the catalog database (services/db_snapshots): taken with VACUUM
INTO, rotated by kind, swapped in on the next start when one is marked."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.config import settings
from app.services import db_snapshots


@pytest.fixture()
def db_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "db" / "library.db"
    path.parent.mkdir()
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('live')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(settings, "db_path", path)
    return path


def _read(path: Path) -> list[str]:
    conn = sqlite3.connect(str(path))
    try:
        return [row[0] for row in conn.execute("SELECT v FROM t")]
    finally:
        conn.close()


def test_a_snapshot_is_a_usable_copy(db_file):
    path = db_snapshots.take_snapshot("manual")
    assert path is not None and path.parent == db_snapshots.snapshot_dir()
    assert _read(path) == ["live"]
    [entry] = db_snapshots.list_snapshots()
    assert entry["name"] == path.name
    assert entry["reason"] == "manual"
    assert entry["size"] > 0


def test_the_migration_snapshot_carries_the_revision(db_file):
    path = db_snapshots.take_snapshot("migration", "d9e0f1a2b3c4")
    assert path is not None and path.name.endswith("-migration-d9e0f1a2b3c4.db")
    assert db_snapshots.list_snapshots()[0]["revision"] == "d9e0f1a2b3c4"


def test_no_database_no_snapshot(db_file):
    db_file.unlink()
    assert db_snapshots.take_snapshot("daily") is None


def _fake(dir_: Path, stamp: str, reason: str, revision: str | None = None, size: int = 10) -> Path:
    tag = f"-{revision}" if revision else ""
    p = dir_ / f"library-{stamp}-{reason}{tag}.db"
    p.write_bytes(b"x" * size)
    return p


def test_rotation_keeps_the_newest_of_each_kind(db_file):
    d = db_snapshots.snapshot_dir()
    d.mkdir()
    for i in range(10):
        _fake(d, f"202610{i + 1:02d}-120000", "daily")
    for i in range(5):
        _fake(d, f"202609{i + 1:02d}-120000", "migration", f"rev{i}")
        _fake(d, f"202609{i + 1:02d}-130000", "migration", f"rev{i}")
    for i in range(7):
        _fake(d, f"202608{i + 1:02d}-120000", "manual")

    db_snapshots.take_snapshot("manual")

    entries = db_snapshots.list_snapshots()
    daily = [e for e in entries if e["reason"] == "daily"]
    assert len(daily) == db_snapshots.DAILY_KEEP
    assert daily[0]["name"].startswith("library-20261010")
    migration = {e["revision"] for e in entries if e["reason"] == "migration"}
    assert migration == {"rev4", "rev3", "rev2"}
    manual = [e for e in entries if e["reason"] == "manual"]
    assert len(manual) == db_snapshots.MANUAL_KEEP
    assert manual[0]["reason"] == "manual" and not manual[0]["name"].startswith("library-202608")


def test_the_size_budget_drops_old_daily_copies_first(db_file, monkeypatch):
    monkeypatch.setattr(db_snapshots, "SIZE_BUDGET", 45)
    d = db_snapshots.snapshot_dir()
    d.mkdir()
    for i in range(4):
        _fake(d, f"202610{i + 1:02d}-120000", "daily", size=10)
    _fake(d, "20260901-120000", "migration", "rev1", size=10)

    db_snapshots._rotate()

    entries = db_snapshots.list_snapshots()
    assert [e["reason"] for e in entries] == ["daily", "daily", "daily", "migration"]
    assert sum(e["size"] for e in entries) <= 45


def test_the_day_gets_one_snapshot(db_file):
    first = db_snapshots.take_daily_if_due()
    assert first is not None
    assert db_snapshots.take_daily_if_due() is None
    assert len(db_snapshots.list_snapshots()) == 1


def test_a_marked_snapshot_is_swapped_in_on_the_next_start(db_file):
    path = db_snapshots.take_snapshot("manual")
    assert path is not None
    conn = sqlite3.connect(str(db_file))
    conn.execute("INSERT INTO t VALUES ('after')")
    conn.commit()
    conn.close()
    Path(str(db_file) + "-wal").write_bytes(b"")

    db_snapshots.schedule_restore(path.name)
    assert db_snapshots.pending_restore() == path.name
    assert _read(db_file) == ["live", "after"]  # nothing happens to the live database

    assert db_snapshots.apply_pending_restore() is True
    assert _read(db_file) == ["live"]
    assert not Path(str(db_file) + "-wal").exists()
    replaced = list(db_file.parent.glob("library.db.replaced-*"))
    assert len(replaced) == 1 and _read(replaced[0]) == ["live", "after"]
    assert db_snapshots.pending_restore() is None
    assert db_snapshots.apply_pending_restore() is False
    # The snapshot itself is still there to be restored again.
    assert any(e["name"] == path.name for e in db_snapshots.list_snapshots())


def test_a_restore_can_be_called_off(db_file):
    path = db_snapshots.take_snapshot("manual")
    db_snapshots.schedule_restore(path.name)
    db_snapshots.cancel_restore()
    assert db_snapshots.pending_restore() is None
    assert db_snapshots.apply_pending_restore() is False


def test_restoring_an_unknown_snapshot_is_refused(db_file):
    with pytest.raises(FileNotFoundError):
        db_snapshots.schedule_restore("library-20260101-000000-manual.db")
