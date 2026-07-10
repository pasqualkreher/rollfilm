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


def main() -> None:
    # Make the backend package importable when frozen or launched from elsewhere.
    if str(BASE_DIR) not in sys.path:
        sys.path.insert(0, str(BASE_DIR))

    run_migrations()

    import uvicorn
    from app.main import app

    port = int(os.environ.get("PM_PORT", "8000"))
    host = os.environ.get("PM_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
