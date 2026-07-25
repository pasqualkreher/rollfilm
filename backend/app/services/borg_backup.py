"""Automatic incremental backups of the managed library to a Borg repository.

Borg (borgbackup.org) is a deduplicating, compressed, optionally encrypted
backup tool: every `borg create` stores only the data blocks that changed since
the last run, so backing up the whole library repeatedly is cheap. The "address"
the user configures is a Borg repository - a local path, a mounted NAS path, or a
remote `user@host:/path` reached over SSH.

What we back up (managed library only, mirroring the ZIP backup in
services/maintenance.py): the photo files under `settings.library_root` plus a
*consistent snapshot* of the SQLite database (albums, tags, ratings, edits).
Photos from external sources (NAS etc.) are excluded - they live on their own
storage and are re-indexed by re-adding the source.

Runs on its own daemon thread following the same wakeable-loop pattern as
services/trash.start_background_purge and services/immich_sync: a guaranteed
daily backup plus a debounced backup shortly after the library changes (import,
edit, delete). `run_backup_soon()` marks the library dirty and nudges the loop;
`trigger_backup_now()` runs one immediately off the request path.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import subprocess
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings as app_settings
from app.db.session import SessionLocal
from app.services.settings_store import (
    BORG_ENABLED,
    BORG_PASSPHRASE,
    BORG_REPO,
    get_setting,
)

logger = logging.getLogger(__name__)

# Archive names share this prefix so prune only ever trims *our* archives and
# {now} lets Borg stamp each with its own timestamp.
_ARCHIVE_PREFIX = "rollfilm"
_ARCHIVE_GLOB = f"{_ARCHIVE_PREFIX}-*"

# Retention after each successful backup - Borg deletes the archives outside
# this window (older data blocks are freed once no archive references them).
_KEEP_DAILY = 7
_KEEP_WEEKLY = 4
_KEEP_MONTHLY = 6

# A guaranteed backup at least once a day even if nothing woke the loop, plus a
# floor between change-triggered runs so a burst of edits can't spawn back-to-
# back Borg runs. The loop re-evaluates on this poll interval.
_DAILY_INTERVAL_S = 24 * 60 * 60
_MIN_AUTO_INTERVAL_S = 15 * 60
_POLL_INTERVAL_S = 5 * 60


@dataclass(frozen=True)
class BorgConfig:
    enabled: bool
    repo: str
    passphrase: str

    @property
    def ready(self) -> bool:
        """Enough to actually run: turned on and pointed at a repository."""
        return self.enabled and bool(self.repo)


@dataclass(frozen=True)
class BackupStatus:
    """Last-run outcome, kept in memory since the process started (like the
    Immich upload history) so the Settings page can show what happened."""

    running: bool = False
    last_ok: bool | None = None
    last_message: str = ""
    last_archive: str | None = None
    last_finished_at: str | None = None
    last_duration_s: float | None = None


_status = BackupStatus()
_status_lock = threading.Lock()
_run_lock = threading.Lock()  # only ever one borg run at a time

_wakeup = threading.Event()
_dirty = threading.Event()
_thread_started = threading.Lock()
_thread_running = False
_last_run_monotonic: float | None = None


def borg_path() -> str | None:
    """Absolute path to the `borg` binary, or None if it isn't installed."""
    return shutil.which("borg")


def borg_available() -> bool:
    return borg_path() is not None


def get_borg_config(db: Session) -> BorgConfig:
    return BorgConfig(
        enabled=get_setting(db, BORG_ENABLED) == "1",
        repo=(get_setting(db, BORG_REPO) or "").strip(),
        passphrase=get_setting(db, BORG_PASSPHRASE) or "",
    )


def get_status() -> BackupStatus:
    with _status_lock:
        return _status


def _set_status(**changes) -> None:
    global _status
    with _status_lock:
        _status = replace(_status, **changes)


def _borg_env(config: BorgConfig) -> dict[str, str]:
    env = dict(os.environ)
    # Passphrase is passed via the environment, never on the command line
    # (argv is visible to other processes). Empty passphrase = an unencrypted
    # repo, which also needs the explicit opt-in below.
    env["BORG_PASSPHRASE"] = config.passphrase
    # Fully non-interactive: a remote repo that moved, or an unencrypted repo,
    # must not block the daemon thread waiting on a y/n prompt.
    env["BORG_RELOCATED_REPO_ACCESS_IS_OK"] = "yes"
    env["BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK"] = "yes"
    env.setdefault("BORG_HOST_ID", "rollfilm")
    return env


def _run_borg(args: list[str], config: BorgConfig, timeout: int) -> subprocess.CompletedProcess:
    borg = borg_path()
    if borg is None:
        raise FileNotFoundError("borg is not installed")
    return subprocess.run(
        [borg, *args],
        env=_borg_env(config),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _repo_exists(config: BorgConfig) -> bool:
    """True if the repository is already initialized and reachable."""
    result = _run_borg(["info", config.repo], config, timeout=120)
    return result.returncode == 0


def _ensure_repo(config: BorgConfig) -> None:
    """Create the repository on first use. Encrypted (repokey) when a passphrase
    is set, unencrypted otherwise - matching what the user chose in Settings."""
    if _repo_exists(config):
        return
    encryption = "repokey" if config.passphrase else "none"
    result = _run_borg(["init", "--encryption", encryption, config.repo], config, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(_borg_error("borg init", result))


def _write_db_snapshot(dest: Path) -> None:
    """A transactionally consistent copy of the live SQLite DB via the online
    backup API - copying the file while WAL writes are in flight could capture a
    torn state. This snapshot is what goes into the archive alongside the photos."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    src = sqlite3.connect(str(app_settings.db_path))
    try:
        out = sqlite3.connect(str(dest))
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()


def _snapshot_dir() -> Path:
    # A sibling of the DB (never inside library_root, so it isn't double-added
    # to the archive). Stable path => Borg dedupes the DB snapshot run to run.
    return app_settings.db_path.parent / "backup-snapshot"


def _borg_error(step: str, result: subprocess.CompletedProcess) -> str:
    detail = (result.stderr or result.stdout or "").strip()
    # Borg's stats/warnings can be verbose; keep the tail, which holds the error.
    if len(detail) > 600:
        detail = "…" + detail[-600:]
    return f"{step} failed (exit {result.returncode}): {detail}" if detail else f"{step} failed (exit {result.returncode})"


def run_backup_once(db: Session | None = None, *, reason: str = "manual") -> BackupStatus:
    """Create one archive: snapshot the DB, `borg create` the library + snapshot,
    then prune old archives. Serialized by _run_lock so an auto run and a manual
    "Backup now" can never overlap. Never raises - failures land in the status."""
    global _last_run_monotonic

    if not _run_lock.acquire(blocking=False):
        # A backup is already in progress; leave its status alone.
        return get_status()

    own_db = db is None
    if own_db:
        db = SessionLocal()
    try:
        config = get_borg_config(db)
        if not config.repo:
            _set_status(running=False, last_ok=False, last_message="No Borg repository configured.")
            return get_status()
        if not borg_available():
            _set_status(
                running=False,
                last_ok=False,
                last_message="Borg is not installed. Install borgbackup, then try again.",
            )
            return get_status()

        _set_status(running=True)
        started = datetime.now(timezone.utc)
        logger.info("Borg backup starting (reason=%s, repo=%s)", reason, config.repo)

        try:
            _ensure_repo(config)

            snapshot = _snapshot_dir() / "library.db"
            _write_db_snapshot(snapshot)

            archive = f"{config.repo}::{_ARCHIVE_PREFIX}-{{now:%Y-%m-%dT%H:%M:%S}}"
            create = _run_borg(
                [
                    "create",
                    "--stats",
                    "--compression",
                    "zstd",
                    archive,
                    str(app_settings.library_root),
                    str(snapshot),
                ],
                config,
                timeout=24 * 60 * 60,
            )
            # rc 1 is "completed with warnings" (e.g. a file changed while being
            # read) - the archive is still valid, so we treat it as success.
            if create.returncode not in (0, 1):
                raise RuntimeError(_borg_error("borg create", create))

            # Best-effort prune: a failure here doesn't invalidate the backup we
            # just made, so log and carry on.
            prune = _run_borg(
                [
                    "prune",
                    "--glob-archives",
                    _ARCHIVE_GLOB,
                    f"--keep-daily={_KEEP_DAILY}",
                    f"--keep-weekly={_KEEP_WEEKLY}",
                    f"--keep-monthly={_KEEP_MONTHLY}",
                    config.repo,
                ],
                config,
                timeout=60 * 60,
            )
            if prune.returncode not in (0, 1):
                logger.warning("Borg prune %s", _borg_error("prune", prune))

            finished = datetime.now(timezone.utc)
            duration = (finished - started).total_seconds()
            _last_run_monotonic = _now_monotonic()
            _set_status(
                running=False,
                last_ok=True,
                last_message="Backup complete.",
                last_archive=_ARCHIVE_PREFIX + started.strftime("-%Y-%m-%dT%H:%M:%S"),
                last_finished_at=finished.isoformat(),
                last_duration_s=duration,
            )
            logger.info("Borg backup complete in %.1fs", duration)
        except Exception as exc:  # noqa: BLE001 - surfaced to the user via status
            _last_run_monotonic = _now_monotonic()
            _set_status(
                running=False,
                last_ok=False,
                last_message=str(exc),
                last_finished_at=datetime.now(timezone.utc).isoformat(),
            )
            logger.exception("Borg backup failed")
        return get_status()
    finally:
        if own_db:
            db.close()
        _run_lock.release()


def _now_monotonic() -> float:
    # time.monotonic wrapped so tests can see it patched in one place.
    import time

    return time.monotonic()


def run_backup_soon() -> None:
    """Mark the library changed and nudge the loop. The loop still honours the
    per-change floor (_MIN_AUTO_INTERVAL_S), so a burst of edits coalesces into
    one backup; the dirty flag persists until a run actually clears it."""
    _dirty.set()
    _wakeup.set()


def trigger_backup_now() -> BackupStatus:
    """Kick off a backup on a throwaway thread and return the current status
    immediately - the request must not block on a multi-minute borg run."""
    if get_status().running:
        return get_status()
    _set_status(running=True)
    threading.Thread(
        target=lambda: run_backup_once(reason="manual"),
        name="borg-backup-manual",
        daemon=True,
    ).start()
    return get_status()


def test_repo(db: Session) -> tuple[bool, str]:
    """Check the configured repo is reachable (and initialize it if new), so the
    user gets an immediate yes/no instead of finding out at the next backup."""
    config = get_borg_config(db)
    if not borg_available():
        return False, "Borg is not installed. Install borgbackup first."
    if not config.repo:
        return False, "Enter a Borg repository address first."
    try:
        if _repo_exists(config):
            return True, "Repository reachable."
        _ensure_repo(config)
        return True, "Repository created and ready."
    except subprocess.TimeoutExpired:
        return False, "Timed out reaching the repository."
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _should_run(config: BorgConfig) -> bool:
    if not config.ready or not borg_available():
        return False
    now = _now_monotonic()
    if _last_run_monotonic is None:
        # No backup since this process started: run once (initial/catch-up).
        return True
    elapsed = now - _last_run_monotonic
    if _dirty.is_set() and elapsed >= _MIN_AUTO_INTERVAL_S:
        return True
    return elapsed >= _DAILY_INTERVAL_S


def start_background_backup() -> None:
    """Run backups on their own daemon thread: an initial/daily pass plus a
    debounced pass after the library changes. Errors are captured in the status
    and retried on the next tick; they can never break the API. Same pattern as
    trash.start_background_purge / immich_sync.start_background_immich_sync."""
    global _thread_running
    with _thread_started:
        if _thread_running:
            return
        _thread_running = True

    def _run() -> None:
        while True:
            try:
                with SessionLocal() as db:
                    config = get_borg_config(db)
                    if _should_run(config):
                        _dirty.clear()
                        run_backup_once(db, reason="auto")
            except Exception:
                logger.exception("Borg background backup tick failed")
            _wakeup.wait(timeout=_POLL_INTERVAL_S)
            _wakeup.clear()

    threading.Thread(target=_run, name="borg-backup", daemon=True).start()
