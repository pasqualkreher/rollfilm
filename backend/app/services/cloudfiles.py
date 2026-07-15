"""Guards against cloud-sync placeholder files (iCloud "Optimize Mac Storage",
Nextcloud virtual files, ...). Those providers replace cold files with dataless
placeholders; the first read then blocks until the provider re-downloads the
bytes. For app-managed data (database, thumbnails, staging) that turns into
multi-second UI hangs that look like the app froze.

The app never needs to *avoid* those reads - it needs them to have already
happened. So: detect placeholders cheaply via stat flags and re-hydrate them
from a low-priority background thread, so foreground requests almost never hit
a cold file.
"""

import logging
import os
import sys
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

# macOS sys/stat.h: SF_DATALESS - the file is a dataless placeholder whose
# contents live with a file provider (iCloud & friends). Reading it triggers
# (and blocks on) the download.
_SF_DATALESS = 0x40000000


def is_dataless(path: Path | str) -> bool:
    """True if the file is a cloud placeholder without local bytes (macOS)."""
    if sys.platform != "darwin":
        return False
    try:
        return bool(os.stat(path, follow_symlinks=False).st_flags & _SF_DATALESS)
    except OSError:
        return False


def materialize(path: Path | str) -> bool:
    """Force the provider to download a placeholder by reading one byte.
    Blocks until the bytes are local. Returns False if the read failed."""
    try:
        with open(path, "rb") as f:
            f.read(1)
        return True
    except OSError:
        logger.warning("could not re-hydrate cloud placeholder: %s", path)
        return False


def rehydrate_dirs_in_background(*roots: Path | str) -> None:
    """Walk the given directories and re-download every placeholder found, on
    a daemon thread so startup and requests never wait on it. No-op on
    non-macOS and when nothing is evicted."""
    if sys.platform != "darwin":
        return

    def _run() -> None:
        found = 0
        for root in roots:
            root = Path(root)
            if not root.exists():
                continue
            for dirpath, _dirnames, filenames in os.walk(root):
                for name in filenames:
                    p = os.path.join(dirpath, name)
                    if is_dataless(p):
                        found += 1
                        materialize(p)
                        if found % 50 == 0:
                            logger.info("re-hydrated %d evicted cloud files so far…", found)
        if found:
            logger.info("re-hydrated %d evicted cloud files under %s", found, ", ".join(str(r) for r in roots))

    threading.Thread(target=_run, name="cloud-rehydrate", daemon=True).start()
