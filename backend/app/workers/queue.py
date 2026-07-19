import logging
import os
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from PIL import Image as PILImage

from app.db.models import Image
from app.db.session import SessionLocal, engine
from app.services.settings_store import get_immich_sync_paused
from app.services.embeddings import encode_image, ensure_embeddings_table, upsert_embedding
from app.services.immich import (
    add_assets_to_album,
    delete_album,
    find_album_id,
    get_or_create_album,
    remove_assets_from_album,
    rename_album,
    upload_asset,
)
from app.services.raw import extract_preview
from app.services.thumbnails import generate_derivatives, has_derivatives

logger = logging.getLogger(__name__)

# A personal photo library doesn't need a broker - a single background
# thread pool inside the same process is enough to keep import requests
# fast while thumbnails/embeddings generate asynchronously. The per-image work
# (full RAW demosaic + CLIP encode) is the import bottleneck, so scale the pool
# with the CPU (capped so a big import doesn't peg every core / exhaust RAM).
_POST_IMPORT_WORKERS = min(4, max(2, os.cpu_count() or 2))
_executor = ThreadPoolExecutor(
    max_workers=_POST_IMPORT_WORKERS, thread_name_prefix="post-import"
)

# Immich uploads get their own (network-bound) pool: they can take seconds to
# minutes each (slow server, retries with sleeps, 120s timeout), and on the
# shared pool a synced import queued its uploads *between* thumbnail jobs -
# a few stuck uploads starved thumbnail/embedding generation for the whole
# import. CPU work and network waits now never compete.
_immich_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="immich-upload")

# Queued + in-flight Immich uploads. The desktop shell asks for this when the
# window closes: the queue is in-memory, so quitting mid-upload silently drops
# whatever hasn't finished - the shell warns and offers to finish first.
_immich_pending = 0
_immich_pending_lock = Lock()


def immich_pending_uploads() -> int:
    with _immich_pending_lock:
        return _immich_pending


def enqueue_post_import(image_id: str, source_path: Path) -> None:
    _executor.submit(_process, image_id, source_path)


def enqueue_embedding(image_id: str, source_path: Path) -> None:
    """Just the search embedding, for callers that already generated the
    derivatives synchronously (e.g. Save copy, so the new photo is viewable the
    instant the user lands on it)."""
    _executor.submit(_embed, image_id, source_path)


def _sync_paused() -> bool:
    """Whether the user has paused automatic Immich syncing (Settings). Read
    fresh per enqueue - it's one key-value lookup, and the pause must take
    effect immediately, not at the next process restart."""
    try:
        db = SessionLocal()
        try:
            return get_immich_sync_paused(db)
        finally:
            db.close()
    except Exception:
        logger.exception("Could not read Immich pause state; assuming not paused")
        return False


def enqueue_immich_upload(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
    album_names: tuple[str, ...] = (),
    image_id: str | None = None,
) -> None:
    """Fire-and-forget upload of a committed JPEG to Immich. Runs on its own
    background pool so a slow or unreachable Immich never blocks (or fails) the
    import itself - nor the thumbnail/embedding work on the post-import pool.
    When ``album_names`` is given, the uploaded asset is also added to each
    named Immich album (created if missing). When ``image_id`` is given, the
    Immich asset id is stored on that row after the upload, so a later
    permanent deletion can remove the asset from Immich too."""
    if _sync_paused():
        # Paused in Settings (e.g. on mobile data): drop the automatic upload
        # instead of queueing it. In selective/full mode the background sync
        # loop re-discovers the photo and uploads it after the user resumes;
        # in manual mode surface the skip so the upload isn't silently lost.
        _record_upload(source_path.name, False, "skipped - Immich sync is paused in Settings")
        logger.info("Immich sync paused - skipped upload of %s", source_path.name)
        return
    global _immich_pending
    with _immich_pending_lock:
        _immich_pending += 1

    def _run() -> None:
        global _immich_pending
        try:
            _upload_to_immich(
                base_url, api_key, source_path, file_created_at, tuple(album_names), image_id
            )
        finally:
            with _immich_pending_lock:
                _immich_pending -= 1

    _immich_executor.submit(
        _run,
    )


# Because uploads are fire-and-forget, their outcome would otherwise be
# invisible to the user (only the log would know). Keep the most recent
# results in memory so the Settings page can show what happened.
_upload_history: deque[dict] = deque(maxlen=50)
_history_lock = Lock()

# A single network blip (e.g. "no route to host" while the connection drops
# for a second) must not silently lose an upload — retry a couple of times.
_UPLOAD_ATTEMPTS = 3
_RETRY_DELAYS_S = (2, 6)

# Album name -> Immich album id, memoised per (base_url) so mirroring a whole
# album's worth of photos doesn't re-query/re-create the album for every asset.
_album_id_cache: dict[tuple[str, str], str] = {}
_album_cache_lock = Lock()


def _resolve_album_id(base_url: str, api_key: str, name: str) -> str:
    key = (base_url, name)
    with _album_cache_lock:
        cached = _album_id_cache.get(key)
    if cached:
        return cached
    album_id = get_or_create_album(base_url, api_key, name)
    with _album_cache_lock:
        _album_id_cache[key] = album_id
    return album_id


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


def _add_to_albums(
    base_url: str, api_key: str, asset_id: str | None, album_names: tuple[str, ...]
) -> str:
    """Add an uploaded asset to each named Immich album. Returns a short suffix
    for the history detail. Album failures are logged but never fail the upload
    (the asset is already safely in Immich)."""
    if not asset_id or not album_names:
        return ""
    added: list[str] = []
    for name in album_names:
        try:
            album_id = _resolve_album_id(base_url, api_key, name)
            add_assets_to_album(base_url, api_key, album_id, [asset_id])
            added.append(name)
        except Exception:
            logger.exception("Immich album add failed for asset %s -> album %r", asset_id, name)
    return f" → album {', '.join(added)}" if added else ""


def _run_with_retries(label: str, fn) -> None:
    """Same retry policy as uploads (a one-second network blip must not lose
    the operation), with the final failure surfaced in the activity history."""
    last_error: Exception | None = None
    for attempt in range(1, _UPLOAD_ATTEMPTS + 1):
        try:
            fn()
            return
        except Exception as exc:
            last_error = exc
            logger.exception("%s failed (attempt %d/%d)", label, attempt, _UPLOAD_ATTEMPTS)
            if attempt < _UPLOAD_ATTEMPTS:
                time.sleep(_RETRY_DELAYS_S[attempt - 1])
    _record_upload(label, False, str(last_error)[:300])


def enqueue_immich_album_delete(base_url: str, api_key: str, name: str) -> None:
    """Mirror deleting a synced app album: delete the same-named Immich album.
    Only the album goes - its assets stay in the Immich timeline, just like the
    photos stay in the library here."""

    def _do() -> None:
        album_id = find_album_id(base_url, api_key, name)
        with _album_cache_lock:
            _album_id_cache.pop((base_url, name), None)
        if album_id is None:
            return  # never mirrored (or already gone) - done either way
        delete_album(base_url, api_key, album_id)
        _record_upload(name, True, "album removed from Immich")
        logger.info("Removed Immich album %r", name)

    _immich_executor.submit(_run_with_retries, f"delete Immich album {name!r}", _do)


def enqueue_immich_album_rename(base_url: str, api_key: str, old_name: str, new_name: str) -> None:
    """Mirror renaming a synced app album. Without this the name-based mapping
    would break: future uploads would create a fresh Immich album under the new
    name while the old one lingered."""

    def _do() -> None:
        album_id = find_album_id(base_url, api_key, old_name)
        with _album_cache_lock:
            _album_id_cache.pop((base_url, old_name), None)
        if album_id is None:
            return
        rename_album(base_url, api_key, album_id, new_name)
        with _album_cache_lock:
            _album_id_cache[(base_url, new_name)] = album_id
        _record_upload(new_name, True, f"album renamed on Immich (was {old_name!r})")
        logger.info("Renamed Immich album %r -> %r", old_name, new_name)

    _immich_executor.submit(_run_with_retries, f"rename Immich album {old_name!r}", _do)


def enqueue_immich_album_remove_assets(
    base_url: str, api_key: str, name: str, asset_ids: list[str]
) -> None:
    """Mirror taking photos out of a synced app album: remove the matching
    assets from the Immich album (they stay in the Immich timeline)."""
    ids = [a for a in asset_ids if a]
    if not ids:
        return

    def _do() -> None:
        album_id = find_album_id(base_url, api_key, name)
        if album_id is None:
            return
        remove_assets_from_album(base_url, api_key, album_id, ids)
        _record_upload(name, True, f"removed {len(ids)} photo(s) from Immich album")
        logger.info("Removed %d asset(s) from Immich album %r", len(ids), name)

    _immich_executor.submit(_run_with_retries, f"update Immich album {name!r}", _do)


def store_immich_asset_id(image_id: str | None, asset_id: str | None) -> None:
    """Persist the Immich asset UUID on the image row after a successful upload
    (or a "duplicate" response, which also carries the existing asset's id).
    Best-effort: the upload already happened, so a failure here only costs the
    fast path of a later Immich deletion (the SHA-1 fallback still works)."""
    if not image_id or not asset_id:
        return
    try:
        db = SessionLocal()
        try:
            image = db.get(Image, image_id)
            if image is not None and image.immich_asset_id != asset_id:
                image.immich_asset_id = asset_id
                db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("Could not store Immich asset id for image %s", image_id)


def _upload_to_immich(
    base_url: str,
    api_key: str,
    source_path: Path,
    file_created_at: datetime | None,
    album_names: tuple[str, ...] = (),
    image_id: str | None = None,
) -> None:
    last_error: Exception | None = None
    for attempt in range(1, _UPLOAD_ATTEMPTS + 1):
        try:
            status, asset_id = upload_asset(base_url, api_key, source_path, file_created_at)
            store_immich_asset_id(image_id, asset_id)
            album_note = _add_to_albums(base_url, api_key, asset_id, album_names)
            logger.info("Uploaded %s to Immich (%s)%s", source_path.name, status, album_note)
            _record_upload(source_path.name, True, f"{status}{album_note}")
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
    # The grid's on-demand thumbnail endpoint may have generated this image's
    # derivatives already (a request raced ahead of this worker); skip straight
    # to the embedding then - the embedder's own preview decode is far cheaper
    # than a redundant full decode + derivative write.
    if has_derivatives(image_id):
        _embed(image_id, source_path)
        return
    # generate_derivatives already decodes the (RAW) source to a full-res image;
    # hand that decoded image straight to the embedder so the CLIP pass doesn't
    # demosaic the same RAW a second time (the single biggest per-image cost).
    decoded: PILImage.Image | None = None
    try:
        decoded = generate_derivatives(image_id, source_path)
    except Exception:
        logger.exception("Thumbnail/preview generation failed for image %s", image_id)
    _embed(image_id, source_path, decoded)


def _embed(
    image_id: str, source_path: Path, image: PILImage.Image | None = None
) -> None:
    try:
        preview = image if image is not None else extract_preview(source_path)
        vector = encode_image(preview)
        ensure_embeddings_table(engine)
        upsert_embedding(engine, image_id, vector)
    except Exception:
        logger.exception("Embedding generation failed for image %s", image_id)
