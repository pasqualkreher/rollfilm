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


def main() -> None:
    # Make the backend package importable when frozen or launched from elsewhere.
    if str(BASE_DIR) not in sys.path:
        sys.path.insert(0, str(BASE_DIR))

    rehydrate_database()
    run_migrations()

    # Root logging config so the app's own INFO lines (e.g. the per-batch
    # import timing) reach the console next to uvicorn's - without this only
    # WARNING+ would surface. Must run *after* the migrations: alembic.ini's
    # fileConfig resets the root logger to WARN, so force-override it here.
    import logging

    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s:     %(name)s - %(message)s", force=True
    )

    import uvicorn
    from app.main import app

    port = int(os.environ.get("PM_PORT", "8000"))
    host = os.environ.get("PM_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
