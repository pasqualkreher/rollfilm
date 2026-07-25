"""Borg backup orchestration. The command wiring (init/create/prune) and status
handling are tested with `borg` faked so they run anywhere; a real end-to-end
round-trip runs too when borgbackup happens to be installed."""

import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.services import borg_backup
from app.services.settings_store import (
    BORG_ENABLED,
    BORG_PASSPHRASE,
    BORG_REPO,
    set_setting,
)


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _configure(db: Session, *, enabled=True, repo="/tmp/repo", passphrase="pw"):
    set_setting(db, BORG_ENABLED, "1" if enabled else "0")
    set_setting(db, BORG_REPO, repo)
    set_setting(db, BORG_PASSPHRASE, passphrase)
    db.commit()


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_get_config_reads_settings(db: Session):
    _configure(db, enabled=True, repo="  user@host:/b  ", passphrase="secret")
    cfg = borg_backup.get_borg_config(db)
    assert cfg.enabled is True
    assert cfg.repo == "user@host:/b"  # trimmed
    assert cfg.passphrase == "secret"
    assert cfg.ready is True


def test_config_not_ready_without_repo(db: Session):
    _configure(db, enabled=True, repo="", passphrase="")
    assert borg_backup.get_borg_config(db).ready is False


def test_backup_missing_borg_sets_error(db: Session, monkeypatch):
    _configure(db)
    monkeypatch.setattr(borg_backup, "borg_path", lambda: None)
    status = borg_backup.run_backup_once(db, reason="test")
    assert status.last_ok is False
    assert "not installed" in status.last_message.lower()


def test_backup_success_runs_init_create_prune(db: Session, monkeypatch):
    _configure(db, repo="/tmp/repo", passphrase="pw")
    monkeypatch.setattr(borg_backup, "borg_path", lambda: "/usr/bin/borg")
    # Don't touch the real sqlite DB in this unit test.
    monkeypatch.setattr(borg_backup, "_write_db_snapshot", lambda dest: None)

    calls: list[list[str]] = []

    def fake_run(args, config, timeout):
        calls.append(args)
        # "info" => repo already exists, so init is skipped in this test.
        if args[0] == "info":
            return _completed(returncode=0)
        return _completed(returncode=0, stderr="Archive stats...")

    monkeypatch.setattr(borg_backup, "_run_borg", fake_run)

    status = borg_backup.run_backup_once(db, reason="test")

    assert status.last_ok is True
    assert status.running is False
    assert status.last_archive and status.last_archive.startswith("rollfilm-")
    verbs = [c[0] for c in calls]
    assert "info" in verbs  # existence check
    assert "create" in verbs
    assert "prune" in verbs
    # create targets both the library root and the DB snapshot.
    create = next(c for c in calls if c[0] == "create")
    assert any("library" in part for part in create)
    # prune scopes to our archive glob so it never trims foreign archives.
    prune = next(c for c in calls if c[0] == "prune")
    assert "rollfilm-*" in prune


def test_backup_initializes_new_repo(db: Session, monkeypatch):
    _configure(db, repo="/tmp/repo", passphrase="pw")
    monkeypatch.setattr(borg_backup, "borg_path", lambda: "/usr/bin/borg")
    monkeypatch.setattr(borg_backup, "_write_db_snapshot", lambda dest: None)

    calls: list[list[str]] = []

    def fake_run(args, config, timeout):
        calls.append(args)
        if args[0] == "info":
            return _completed(returncode=2, stderr="Repository does not exist")  # new repo
        return _completed(returncode=0)

    monkeypatch.setattr(borg_backup, "_run_borg", fake_run)
    status = borg_backup.run_backup_once(db, reason="test")

    assert status.last_ok is True
    init = next((c for c in calls if c[0] == "init"), None)
    assert init is not None
    # A passphrase => encrypted repokey init.
    assert "repokey" in init


def test_backup_create_failure_surfaces_error(db: Session, monkeypatch):
    _configure(db, repo="/tmp/repo", passphrase="pw")
    monkeypatch.setattr(borg_backup, "borg_path", lambda: "/usr/bin/borg")
    monkeypatch.setattr(borg_backup, "_write_db_snapshot", lambda dest: None)

    def fake_run(args, config, timeout):
        if args[0] == "info":
            return _completed(returncode=0)
        if args[0] == "create":
            return _completed(returncode=2, stderr="disk full")
        return _completed(returncode=0)

    monkeypatch.setattr(borg_backup, "_run_borg", fake_run)
    status = borg_backup.run_backup_once(db, reason="test")

    assert status.last_ok is False
    assert "disk full" in status.last_message


@pytest.mark.skipif(shutil.which("borg") is None, reason="borgbackup not installed")
def test_real_backup_roundtrip(db: Session, tmp_path: Path, monkeypatch):
    """With a real borg: create a repo, back up a tiny library + DB snapshot,
    and confirm one archive lands. Auto-skips when borg isn't installed."""
    library = tmp_path / "library"
    library.mkdir()
    (library / "photo.jpg").write_bytes(b"not really a jpeg but fine for borg")

    monkeypatch.setattr(borg_backup.app_settings, "library_root", library)
    monkeypatch.setattr(borg_backup.app_settings, "db_path", tmp_path / "db" / "library.db")
    (tmp_path / "db").mkdir()
    (tmp_path / "db" / "library.db").write_bytes(b"")

    _configure(db, repo=str(tmp_path / "repo"), passphrase="testpw")
    status = borg_backup.run_backup_once(db, reason="test")
    assert status.last_ok is True, status.last_message

    listing = subprocess.run(
        [shutil.which("borg"), "list", str(tmp_path / "repo")],
        env=borg_backup._borg_env(borg_backup.get_borg_config(db)),
        capture_output=True,
        text=True,
    )
    assert listing.returncode == 0
    assert "rollfilm-" in listing.stdout
