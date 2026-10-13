"""Snapshots of the catalog database.

The database is the one thing in the library folder that is not a photo: the
stars, tags, albums, canvases and edits. It lives beside the photos, often on
an external drive, and until now had no copy of its own - a migration that
went wrong, a corrupt page after a yanked cable, a mistaken "Remove entries"
were all final. So the app keeps copies of it, made with SQLite's own
`VACUUM INTO` (a consistent, compacted copy taken while the app runs):

- one before every migration that changes the schema (run_server, before
  Alembic runs), named after the revision it left;
- one a day, the first start of the day (main.py, in the background);
- one whenever the user asks (Settings -> Backup & restore -> Snapshot now).

Restoring is never done on the live database: Settings marks a snapshot, and
the next start swaps it in before anything opens the database
(apply_pending_restore), keeping the replaced file beside it for a while.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

# How many daily / manual snapshots to keep, how many migration snapshots
# (by distinct revision), and the room all of them may take together.
DAILY_KEEP = 7
MANUAL_KEEP = 5
MIGRATION_REVISIONS_KEEP = 3
SIZE_BUDGET = 2 * 1024**3
REPLACED_KEEP = 2

_NAME = re.compile(r"^library-(\d{8}-\d{6})-(daily|migration|manual)(?:-([0-9A-Za-z_]+))?\.db$")
_lock = threading.Lock()


def snapshot_dir() -> Path:
    return settings.db_path.parent / "snapshots"


def restore_marker() -> Path:
    """The snapshot copied here is what the next start opens as the database."""
    return settings.db_path.with_name(settings.db_path.name + ".restore")


def _parse(path: Path) -> dict | None:
    m = _NAME.match(path.name)
    if not m:
        return None
    stamp, reason, revision = m.groups()
    try:
        created = datetime.strptime(stamp, "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc)
        size = path.stat().st_size
    except (ValueError, OSError):
        return None
    return {
        "name": path.name,
        "size": size,
        "created_at": created.isoformat(),
        "reason": reason,
        "revision": revision,
        "_stamp": stamp,
        "_path": path,
    }


def _entries() -> list[dict]:
    d = snapshot_dir()
    if not d.is_dir():
        return []
    found = [e for p in d.iterdir() if p.is_file() and (e := _parse(p))]
    found.sort(key=lambda e: e["_stamp"], reverse=True)
    return found


def list_snapshots() -> list[dict]:
    return [{k: v for k, v in e.items() if not k.startswith("_")} for e in _entries()]


def take_snapshot(reason: str, revision: str | None = None) -> Path | None:
    """A consistent copy of the live database, compacted, written next to it.
    Returns the file, or None when there is no database yet or the copy
    failed (logged; a snapshot is never worth a failed start)."""
    if reason not in ("daily", "migration", "manual"):
        raise ValueError(reason)
    src = settings.db_path
    if not src.exists():
        return None
    with _lock:
        d = snapshot_dir()
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        tag = f"-{revision}" if revision else ""
        target = d / f"library-{stamp}-{reason}{tag}.db"
        tmp = d / (target.name + ".part")
        try:
            # Autocommit (no implicit transaction): VACUUM refuses to run
            # inside one. The source is only read.
            conn = sqlite3.connect(str(src), timeout=30, isolation_level=None)
            try:
                conn.execute("VACUUM INTO ?", (str(tmp),))
            finally:
                conn.close()
            os.replace(tmp, target)
        except Exception:
            logger.exception("Database snapshot (%s) failed", reason)
            tmp.unlink(missing_ok=True)
            return None
        _rotate()
        logger.info("Database snapshot (%s): %s", reason, target.name)
        return target


def take_daily_if_due() -> Path | None:
    """The first start of a day takes the day's snapshot; later starts don't."""
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    for e in _entries():
        if e["reason"] == "daily" and e["_stamp"].startswith(today):
            return None
    return take_snapshot("daily")


def _rotate() -> None:
    entries = _entries()
    keep: set[str] = set()
    daily = [e for e in entries if e["reason"] == "daily"]
    manual = [e for e in entries if e["reason"] == "manual"]
    migration = [e for e in entries if e["reason"] == "migration"]
    keep.update(e["name"] for e in daily[:DAILY_KEEP])
    keep.update(e["name"] for e in manual[:MANUAL_KEEP])
    revisions: list[str | None] = []
    for e in migration:
        if e["revision"] not in revisions:
            revisions.append(e["revision"])
    kept_revisions = set(revisions[:MIGRATION_REVISIONS_KEEP])
    keep.update(e["name"] for e in migration if e["revision"] in kept_revisions)
    for e in entries:
        if e["name"] not in keep:
            e["_path"].unlink(missing_ok=True)
    # The room: oldest daily and manual go first; the newest of each kind and
    # the migration snapshots stay whatever the budget says.
    remaining = [e for e in entries if e["name"] in keep]
    total = sum(e["size"] for e in remaining)
    victims = [e for e in reversed(remaining) if e["reason"] in ("daily", "manual")]
    newest_by_kind = {e["reason"]: e["name"] for e in reversed(remaining)}
    for e in victims:
        if total <= SIZE_BUDGET:
            break
        if newest_by_kind.get(e["reason"]) == e["name"]:
            continue
        e["_path"].unlink(missing_ok=True)
        total -= e["size"]


def schedule_restore(name: str) -> None:
    """Mark a snapshot to be swapped in on the next start. Copied, not moved:
    the snapshot stays in the list."""
    entry = next((e for e in _entries() if e["name"] == name), None)
    if entry is None:
        raise FileNotFoundError(name)
    marker = restore_marker()
    tmp = marker.with_name(marker.name + ".part")
    shutil.copyfile(entry["_path"], tmp)
    os.replace(tmp, marker)


def cancel_restore() -> None:
    restore_marker().unlink(missing_ok=True)


def pending_restore() -> str | None:
    """Which snapshot waits to be swapped in: the marker's bytes are a copy,
    so the name is read back from the newest snapshot of the same size."""
    marker = restore_marker()
    if not marker.exists():
        return None
    try:
        size = marker.stat().st_size
    except OSError:
        return None
    for e in _entries():
        if e["size"] == size:
            return e["name"]
    return marker.name


def apply_pending_restore() -> bool:
    """At start, before anything opens the database: if a restore is marked,
    the current database steps aside (kept as library.db.replaced-<stamp>,
    the newest few) and the marked copy takes its place. The WAL and shm of
    the old database go with it - they belong to the file they came from."""
    marker = restore_marker()
    if not marker.exists():
        return False
    db = settings.db_path
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    replaced = db.with_name(f"{db.name}.replaced-{stamp}")
    if db.exists():
        os.replace(db, replaced)
    for suffix in ("-wal", "-shm"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    os.replace(marker, db)
    logger.warning("Database restored from a snapshot; the previous database is kept as %s", replaced.name)
    older = sorted(db.parent.glob(f"{db.name}.replaced-*"), key=lambda p: p.name, reverse=True)
    for p in older[REPLACED_KEEP:]:
        p.unlink(missing_ok=True)
    return True


def start_background_snapshot() -> None:
    """The day's snapshot, off the startup path."""
    threading.Thread(target=take_daily_if_due, name="db-snapshot", daemon=True).start()
