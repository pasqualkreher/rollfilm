import logging
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Callable

from PIL import Image as PILImage
from sqlalchemy import text

from app.config import settings
from app.db.models import Image
from app.db.session import SessionLocal, engine
from app.services.filesystem import resolve_image_path
from app.services.settings_store import get_immich_sync_paused
from app.services.embeddings import (
    encode_image,
    encode_images,
    open_for_encoding,
    upsert_embedding,
)
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
from app.services.thumbnails import RENDER_SLOTS, generate_derivatives, has_derivatives

logger = logging.getLogger(__name__)

# A personal photo library doesn't need a broker - a single background
# thread pool inside the same process is enough to keep import requests
# fast while thumbnails generate asynchronously. The per-image work (full RAW
# demosaic) is the import bottleneck. RAM safety lives in the render semaphore
# (RENDER_SLOTS), not here - so size the pool to keep every render slot busy
# plus a couple of workers overlapping the non-render work (JPEG writes, disk)
# instead of a flat cap of 4 that left render slots idle on bigger machines.
_POST_IMPORT_WORKERS = min(8, max(2, RENDER_SLOTS + 2))
_executor = ThreadPoolExecutor(
    max_workers=_POST_IMPORT_WORKERS, thread_name_prefix="post-import"
)

# Post-import derivative jobs queued or running. The embedding backfill below
# waits for this to drain, so CLIP work never overlaps the import's own
# rendering phase.
_pending_derivatives = 0
_pending_derivatives_lock = Lock()


def derivatives_pending() -> int:
    with _pending_derivatives_lock:
        return _pending_derivatives

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
    global _pending_derivatives
    with _pending_derivatives_lock:
        _pending_derivatives += 1
    try:
        _executor.submit(_process, image_id, source_path)
    except Exception:
        with _pending_derivatives_lock:
            _pending_derivatives -= 1
        raise


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
    """One post-import job: make the photo *viewable* (thumbnail + preview).
    Nothing else - the CLIP search embedding is a library feature, not an
    import step, and is backfilled below once the import machinery is idle."""
    try:
        # The grid's on-demand thumbnail endpoint may have generated this
        # image's derivatives already (a request raced ahead of this worker).
        if not has_derivatives(image_id):
            generate_derivatives(image_id, source_path)
    except Exception:
        logger.exception("Thumbnail/preview generation failed for image %s", image_id)
    finally:
        global _pending_derivatives
        with _pending_derivatives_lock:
            _pending_derivatives -= 1
            drained = _pending_derivatives <= 0
        if drained:
            # The import's render queue just went quiet - good moment to catch
            # up on search embeddings for whatever was imported.
            schedule_embedding_backfill()


# --- Deferred search embeddings ----------------------------------------------
# CLIP embeddings power semantic search, similar-photos and smart albums -
# library features, none of which an import needs. They used to be generated
# inline per photo right after its derivatives, which made every import pay
# the CLIP encode (plus a write transaction per photo) while thumbnails were
# still rendering and the next batch was already staging. Now a single
# low-priority worker backfills them when the import machinery is idle,
# reading the already-rendered preview.jpg instead of re-decoding originals.
#
# Scan-based on purpose: "whatever has no embedding yet" is re-derived from the
# database each pass, so photos whose embedding was lost (the old in-memory
# queue forgot its backlog on every backend restart) are picked up on the next
# pass instead of staying unsearchable forever.

_BACKFILL_IDLE_POLL_S = 5.0
_BACKFILL_CHUNK = 100

_backfill_lock = Lock()
_backfill_thread: threading.Thread | None = None
_backfill_rerun = False

# Images whose embedding failed (unreadable/corrupt source): skipped for the
# rest of this process run instead of being retried on every pass.
_embed_failed_ids: set[str] = set()

_import_activity_probes: list[Callable[[], bool]] = []


def register_import_activity_probe(probe: Callable[[], bool]) -> None:
    """Register a callable reporting whether import work (staging analysis, a
    running commit) is active - the embedding backfill yields to it. A registry
    rather than a direct import keeps the module dependency one-way: the import
    pipeline imports this queue, never the other way around."""
    _import_activity_probes.append(probe)


def _import_work_active() -> bool:
    if derivatives_pending() > 0:
        return True
    for probe in list(_import_activity_probes):
        try:
            if probe():
                return True
        except Exception:
            logger.exception("Import activity probe failed; treating it as idle")
    return False


def schedule_embedding_backfill() -> None:
    """Kick the embedding backfill (debounced - at most one worker ever runs).
    Called at startup for the catch-up pass and whenever the post-import render
    queue drains; safe to call at any time. The worker is a daemon thread with
    short per-photo transactions, so it never delays shutdown."""
    global _backfill_thread, _backfill_rerun
    with _backfill_lock:
        if _backfill_thread is not None and _backfill_thread.is_alive():
            _backfill_rerun = True
            return
        _backfill_rerun = False
        _backfill_thread = threading.Thread(
            target=_backfill_embeddings, name="embedding-backfill", daemon=True
        )
        _backfill_thread.start()


def _images_missing_embeddings(limit: int) -> list[tuple[str, Path]]:
    """Up to `limit` images without a stored embedding, newest imports first
    (so fresh photos become searchable soonest), each with its original's
    path. Diffed in Python: the stored-id set easily exceeds SQLite's bound-
    parameter limit, so a NOT IN over it is not an option.

    Every live image gets its own vector, including RAWs whose JPEG sibling
    is alive: auto-develop matches edited examples by their embeddings, and a
    RAW render can drift from its JPEG's look, so the pair's halves each keep
    an exact vector."""
    db = SessionLocal()
    try:
        with engine.connect() as conn:
            have = {row[0] for row in conn.execute(text("SELECT id FROM image_embeddings"))}
        ids = [
            row.id
            for row in db.query(Image.id)
            .filter(Image.deleted_at.is_(None))
            .order_by(Image.imported_at.desc())
            if row.id not in have and row.id not in _embed_failed_ids
        ][:limit]
        if not ids:
            return []
        images = db.query(Image).filter(Image.id.in_(ids)).all()
        return [(img.id, resolve_image_path(img)) for img in images]
    finally:
        db.close()


# Photos per model forward pass and threads decoding JPEGs ahead of it. A
# batch of 16 encodes at ~half the per-image cost of single calls; four decode
# threads (PIL releases the GIL in libjpeg) keep the batch fed at a fraction
# of sequential decode time. Beyond either value the returns flatten out while
# an import-preemption pause gets coarser.
_EMBED_BATCH = 16
_EMBED_DECODE_WORKERS = 4


def _decode_for_embedding(image_id: str, source_path: Path) -> PILImage.Image | None:
    """Load one photo for encoding. Prefers the already-rendered preview.jpg -
    a clean RGB JPEG that decodes in milliseconds and can't trip on a RAW
    quirk; the original is only read when no derivative exists yet. None (and
    the id blacklisted) when the photo can't be decoded at all."""
    try:
        preview_path = settings.thumbnail_cache_root / image_id / "preview.jpg"
        if preview_path.exists():
            return open_for_encoding(preview_path)
        return extract_preview(source_path)
    except Exception:
        logger.exception("Embedding decode failed for image %s", image_id)
        _embed_failed_ids.add(image_id)
        return None


def _embed_batch(items: list[tuple[str, Path]]) -> int:
    """Decode a mini-batch in parallel, encode it in one forward pass, store
    each vector. Returns how many photos got an embedding."""
    with ThreadPoolExecutor(max_workers=_EMBED_DECODE_WORKERS) as pool:
        decoded = list(pool.map(lambda item: _decode_for_embedding(*item), items))
    pairs = [(image_id, im) for (image_id, _), im in zip(items, decoded) if im is not None]
    if not pairs:
        return 0
    try:
        vectors = encode_images([im for _, im in pairs])
    except Exception:
        # One poisoned image shouldn't sink its whole batch: retry one by one
        # so the rest still land and only the culprit gets blacklisted.
        done = 0
        for image_id, im in pairs:
            try:
                upsert_embedding(engine, image_id, encode_image(im))
                done += 1
            except Exception:
                logger.exception("Embedding backfill failed for image %s", image_id)
                _embed_failed_ids.add(image_id)
        return done
    for (image_id, _), vector in zip(pairs, vectors):
        upsert_embedding(engine, image_id, vector)
    return len(pairs)


def _backfill_embeddings() -> None:
    global _backfill_thread, _backfill_rerun
    done = 0
    try:
        while True:
            # Never compete with a running import: wait out staging analysis,
            # commits and the derivative renders that follow them. (Checked
            # again between photos, so a new import preempts within one encode.)
            while _import_work_active():
                time.sleep(_BACKFILL_IDLE_POLL_S)
            batch = _images_missing_embeddings(_BACKFILL_CHUNK)
            if not batch:
                with _backfill_lock:
                    if _backfill_rerun:
                        _backfill_rerun = False
                        continue
                    _backfill_thread = None
                break
            for start in range(0, len(batch), _EMBED_BATCH):
                if _import_work_active():
                    break  # yield now; the outer loop waits and resumes
                done += _embed_batch(batch[start : start + _EMBED_BATCH])
    except Exception:
        logger.exception("Embedding backfill crashed")
        with _backfill_lock:
            _backfill_thread = None
    if done:
        logger.info("Embedding backfill: %d photo(s) embedded", done)
        # Fresh embeddings change what the "Moments" smart albums would find -
        # poke that rebuild now, so the clusters are (re)computed in the
        # background instead of only when the Albums page next asks.
        _refresh_moments_clusters()


def _refresh_moments_clusters() -> None:
    """Schedule a smart-album cluster rebuild if Moments is enabled. Imported
    lazily: at module level this import would be circular (smart_albums →
    sources → this queue)."""
    try:
        from app.services.settings_store import get_smart_album_config
        from app.services import smart_albums

        db = SessionLocal()
        try:
            if "moments" in get_smart_album_config(db).sections:
                # get_clusters compares the library signature and starts the
                # background rebuild itself when it is stale.
                smart_albums.get_clusters(db)
        finally:
            db.close()
    except Exception:
        logger.exception("Could not schedule the smart-album cluster refresh")
