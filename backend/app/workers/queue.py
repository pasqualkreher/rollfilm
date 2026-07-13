import logging
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from app.db.session import engine
from app.services.embeddings import encode_image, ensure_embeddings_table, upsert_embedding
from app.services.immich import upload_asset
from app.services.raw import extract_preview
from app.services.thumbnails import generate_derivatives

logger = logging.getLogger(__name__)

# A personal photo library doesn't need a broker - a single background
# thread pool inside the same process is enough to keep import requests
# fast while thumbnails/embeddings generate asynchronously.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="post-import")


def enqueue_post_import(image_id: str, source_path: Path) -> None:
    _executor.submit(_process, image_id, source_path)


def enqueue_embedding(image_id: str, source_path: Path) -> None:
    """Just the search embedding, for callers that already generated the
    derivatives synchronously (e.g. Save copy, so the new photo is viewable the
    instant the user lands on it)."""
    _executor.submit(_embed, image_id, source_path)


def enqueue_immich_upload(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
) -> None:
    """Fire-and-forget upload of a committed JPEG to Immich. Runs on the same
    background pool as thumbnailing so a slow or unreachable Immich never blocks
    (or fails) the import itself."""
    _executor.submit(_upload_to_immich, base_url, api_key, source_path, file_created_at)


# Because uploads are fire-and-forget, their outcome would otherwise be
# invisible to the user (only the log would know). Keep the most recent
# results in memory so the Settings page can show what happened.
_upload_history: deque[dict] = deque(maxlen=50)
_history_lock = Lock()

# A single network blip (e.g. "no route to host" while the connection drops
# for a second) must not silently lose an upload — retry a couple of times.
_UPLOAD_ATTEMPTS = 3
_RETRY_DELAYS_S = (2, 6)


def immich_upload_history() -> list[dict]:
    with _history_lock:
        return list(_upload_history)


def _record_upload(filename: str, ok: bool, detail: str) -> None:
    with _history_lock:
        _upload_history.appendleft(
            {
                "filename": filename,
                "ok": ok,
                "detail": detail,
                "at": datetime.now(timezone.utc).isoformat(),
            }
        )


def _upload_to_immich(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
) -> None:
    last_error: Exception | None = None
    for attempt in range(1, _UPLOAD_ATTEMPTS + 1):
        try:
            status = upload_asset(base_url, api_key, source_path, file_created_at)
            logger.info("Uploaded %s to Immich (%s)", source_path.name, status)
            _record_upload(source_path.name, True, status)
            return
        except Exception as exc:
            last_error = exc
            logger.exception(
                "Immich upload failed for %s (attempt %d/%d)",
                source_path.name,
                attempt,
                _UPLOAD_ATTEMPTS,
            )
            if attempt < _UPLOAD_ATTEMPTS:
                time.sleep(_RETRY_DELAYS_S[attempt - 1])
    _record_upload(source_path.name, False, str(last_error)[:300])


def _process(image_id: str, source_path: Path) -> None:
    try:
        generate_derivatives(image_id, source_path)
    except Exception:
        logger.exception("Thumbnail/preview generation failed for image %s", image_id)
    _embed(image_id, source_path)


def _embed(image_id: str, source_path: Path) -> None:
    try:
        preview = extract_preview(source_path)
        vector = encode_image(preview)
        ensure_embeddings_table(engine)
        upsert_embedding(engine, image_id, vector)
    except Exception:
        logger.exception("Embedding generation failed for image %s", image_id)
