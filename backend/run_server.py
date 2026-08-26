"""Native entry point for the FastAPI backend.

Used by the Electron shell (spawned as a child process) and by PyInstaller when
the backend is bundled into the desktop app. Runs DB migrations, then serves
uvicorn bound to localhost only.

Config via env vars (set by the Electron main process):
  PM_PORT      port to listen on            (default 8000)
  PM_HOST      host/interface to bind        (default 127.0.0.1)
  PM_DATA_DIR  base dir for all app data     (see app/config.py)
"""

import os
import sys
from pathlib import Path

# In a PyInstaller onedir bundle, resources live next to the executable
# (sys._MEIPASS); otherwise this file sits in the backend source dir.
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def run_migrations() -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BASE_DIR / "alembic.ini"))
    # Absolute script_location so it resolves regardless of CWD (dev or frozen).
    cfg.set_main_option("script_location", str(BASE_DIR / "app" / "db" / "migrations"))
    command.upgrade(cfg, "head")


def run_migrations_with_retry(attempts: int = 5, delay_s: float = 2.0) -> None:
    """Run the migrations, absorbing transient filesystem refusals.

    A library on an external exFAT/NTFS drive (macOS mounts these through
    FSKit) can briefly report the freshly created database as read-only or
    locked right after the volume is first written - seen as
    'attempt to write a readonly database' on the very first launch after
    switching the library folder, while a relaunch seconds later works. Retry
    a few times before giving up so that hiccup doesn't present as a crash."""
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, attempts + 1):
        try:
            run_migrations()
            return
        except OperationalError as exc:
            message = str(exc).lower()
            transient = (
                "readonly database" in message
                or "database is locked" in message
                or "disk i/o error" in message
            )
            if not transient or attempt == attempts:
                raise
            print(
                f"[startup] database not writable yet ({exc.orig}); retrying in {delay_s:.0f}s "
                f"(attempt {attempt}/{attempts}) - external drives can take a moment to accept writes",
                flush=True,
            )
            time.sleep(delay_s)


def rehydrate_database() -> None:
    """A cloud-synced library folder (iCloud & co.) may have evicted the SQLite
    files to dataless placeholders. The very first read would then block inside
    the migration step with no log output at all - so download them explicitly
    and say so, before anything opens the database."""
    from app.config import settings
    from app.services.cloudfiles import is_dataless, materialize

    for suffix in ("", "-wal", "-shm"):
        p = Path(str(settings.db_path) + suffix)
        if p.exists() and is_dataless(p):
            print(f"[startup] database file was evicted by the cloud provider, downloading: {p}")
            materialize(p)


def use_bundled_ca_certificates() -> None:
    """Make the stdlib's HTTPS trust the same roots httpx already does.

    The frozen backend links against the OpenSSL that ships inside the OpenCV
    wheel, and that library's compiled-in trust store is the path it was built
    with - Homebrew's /opt/homebrew/etc/openssl@3/cert.pem. No user machine has
    that file, so every plain-urllib HTTPS call (the Immich connection test and
    the asset uploads) died with 'CERTIFICATE_VERIFY_FAILED: unable to get local
    issuer certificate' while requests through httpx, which carries certifi's
    bundle, went through fine in the very same process. Fall back to that same
    bundle. An SSL_CERT_FILE the user set themselves - a corporate root, a
    private CA in front of their own server - still wins.
    """
    import ssl

    if os.environ.get("SSL_CERT_FILE"):
        return
    if ssl.get_default_verify_paths().cafile:  # None when the file isn't there
        return
    try:
        import certifi
    except ImportError:
        return
    os.environ["SSL_CERT_FILE"] = certifi.where()


def raise_open_files_limit() -> None:
    """Raise the soft open-files limit toward the hard cap. macOS starts
    GUI-spawned processes (the Electron shell and thus this child) with a soft
    limit of 256 - but a single import upload batch alone spools hundreds of
    multipart temp files at once, on top of staged files, SQLite handles and
    sockets, so big imports could die mid-batch with EMFILE 'Too many open
    files'. Best effort: Windows has no resource module (nor the low limit)."""
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = 65536 if hard == resource.RLIM_INFINITY else min(hard, 65536)
        if soft < target:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
    except Exception:
        pass


def main() -> None:
    # Make the backend package importable when frozen or launched from elsewhere.
    if str(BASE_DIR) not in sys.path:
        sys.path.insert(0, str(BASE_DIR))

    use_bundled_ca_certificates()
    raise_open_files_limit()
    rehydrate_database()
    run_migrations_with_retry()

    # Root logging config so the app's own INFO lines (e.g. the per-batch
    # import timing) reach the console next to uvicorn's - without this only
    # WARNING+ would surface. Must run *after* the migrations: alembic.ini's
    # fileConfig resets the root logger to WARN, so force-override it here.
    import logging

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s:     %(name)s - %(message)s",
        force=True,
    )

    import uvicorn
    from app.main import app

    port = int(os.environ.get("PM_PORT", "8000"))
    host = os.environ.get("PM_HOST", "127.0.0.1")
    # access_log off: the desktop shell spawns this with stdout on a pipe, so
    # every request cost a formatted log line plus a pipe write ON the request
    # thread - and browsing a grid is hundreds of thumbnail requests a second.
    # Errors and the app's own INFO lines (import timing, workers) are
    # unaffected; only the per-request "GET /images/... 200" noise goes.
    #
    # loop/http are deliberately left on uvicorn's "auto": uvicorn[standard]
    # already pulls in uvloop and httptools and auto prefers them, while naming
    # them explicitly would turn a bundle that happens to miss one into a
    # backend that refuses to start.
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
