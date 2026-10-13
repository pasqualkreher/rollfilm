"""Give memory back when nobody is using it.

The editor's caches (decoded bases, tone/detail stages, tiles, grain fields,
mask fields) and the two ML models are kept so the NEXT interaction is cheap.
None of them had any way of being let go short of quitting - after one editing
session and one AI mask the backend sat on well over a gigabyte for the rest
of the day, on machines where that gigabyte is the difference between the
grid scrolling from RAM and from swap. One daemon thread checks every minute
and releases what has been idle long enough; everything reloads lazily."""

from __future__ import annotations

import logging
import threading
import time

from app.services import embeddings, film_sims, machine, masks, segmentation, thumbnails

logger = logging.getLogger(__name__)

_CHECK_EVERY_S = 60.0
# The editor's pixel caches go after three quiet minutes: a user reading
# their photo for that long is done with the sliders for now.
EDITOR_CACHE_IDLE_S = 180.0
# The models after ten: a mask or a search after that pays a few seconds of
# load once. CLIP is only released on low-RAM machines - elsewhere its
# resident gigabyte is cheaper than the wait on the next search.
MODEL_IDLE_S = 600.0

_started = False


def sweep_once() -> None:
    try:
        if thumbnails.release_editor_caches_if_idle(EDITOR_CACHE_IDLE_S):
            masks.clear_field_cache()
            logger.info("Editor caches released after %.0fs idle", EDITOR_CACHE_IDLE_S)
    except Exception:
        logger.exception("Editor cache release failed")
    # The film looks' cubes go on the same clock: the grid's renders and the
    # editor both read them, and a picker session leaves tens of MB behind.
    try:
        if film_sims.release_if_idle(EDITOR_CACHE_IDLE_S):
            logger.info("Film look caches released after %.0fs idle", EDITOR_CACHE_IDLE_S)
    except Exception:
        logger.exception("Film look cache release failed")
    try:
        segmentation.unload_if_idle(MODEL_IDLE_S)
    except Exception:
        logger.exception("Segmentation unload failed")
    if machine.LOW_RAM:
        try:
            embeddings.unload_if_idle(MODEL_IDLE_S)
        except Exception:
            logger.exception("CLIP unload failed")


def start_idle_reaper() -> None:
    global _started
    if _started:
        return
    _started = True

    def run() -> None:
        while True:
            time.sleep(_CHECK_EVERY_S)
            sweep_once()

    threading.Thread(target=run, name="idle-reaper", daemon=True).start()
