from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    albums,
    images,
    import_,
    maintenance,
    search,
    settings,
    smart_albums,
    sources,
    stats,
    tags,
)
from app.config import settings as app_settings
from app.db.session import SessionLocal, engine, ensure_indexes
from app.services.borg_backup import start_background_backup
from app.services.cloudfiles import rehydrate_dirs_in_background
from app.services.embeddings import ensure_embeddings_table
from app.services.embeddings import start_background_warmup as start_background_clip_warmup
from app.services.exif import reap_orphaned_helpers
from app.services.geocode import warm_in_background as warm_geocoder
from app.services.hashing import warm_phash_in_background
from app.services.immich_sync import start_background_immich_sync
from app.services.maintenance import start_background_sync
from app.services.sources import scan_all_sources
from app.services.trash import start_background_purge
from app.workers.queue import schedule_embedding_backfill

app = FastAPI(title="Rollfilm API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # The editor reads these off the preview response (which tier was actually
    # rendered, and where a region tile belongs); without exposing them a
    # cross-origin renderer (dev server, Electron) sees them as absent.
    expose_headers=["X-Rollfilm-Tier", "X-Rollfilm-Frame", "X-Rollfilm-Box"],
)

app.include_router(images.router)
app.include_router(albums.router)
app.include_router(smart_albums.router)
app.include_router(import_.router)
app.include_router(search.router)
app.include_router(maintenance.router)
app.include_router(settings.router)
app.include_router(sources.router)
app.include_router(tags.router)
app.include_router(stats.router)


@app.on_event("startup")
def on_startup() -> None:
    # Table schema lives in Alembic migrations; the sqlite-vec virtual table
    # is bootstrapped here since it isn't a normal SQLAlchemy-managed table.
    ensure_embeddings_table(engine)
    # Hot-path indexes for the library grid (idempotent, see ensure_indexes).
    ensure_indexes()
    # Restore the persisted RAW-decode mode into the live flag the decoder reads
    # (services/raw.py keeps it as a module global to avoid a DB hit per decode).
    from app.services import raw as raw_service
    from app.services.settings_store import get_raw_native_decode

    with SessionLocal() as _db:
        raw_service.set_native_decode(get_raw_native_decode(_db))
    # Pick up anything new under registered external source roots (NAS/folders)
    # since last run - runs in the background so startup isn't blocked, and is
    # incremental (only new files are indexed).
    scan_all_sources()
    # Reconcile the DB with the library folder (same as Settings' "Sync
    # database to library") now that the folder is selected/confirmed -
    # backgrounded like the scans.
    start_background_sync()
    # Permanently delete photos that sat in the Trash longer than the retention
    # configured in Settings (default 14 days, 0 = keep forever). Backgrounded
    # for the same reason as the scans.
    start_background_purge()
    # Reconcile the library with Immich now and then every minute: upload
    # whatever should be synced but isn't yet, remove trashed/deleted photos
    # from Immich (see services/immich_sync.py). No-op in manual mode or while
    # Immich isn't configured.
    start_background_immich_sync()
    # Automatic incremental Borg backups (services/borg_backup.py): a daily pass
    # plus a debounced pass after the library changes. No-op until the user
    # configures a repository in Settings. Backgrounded like the loops above.
    start_background_backup()
    # Parse the reverse-geocoding dataset now instead of inside the first
    # import commit (the desktop app restarts the backend on every launch, so
    # that first-commit stall was paid every session).
    warm_geocoder()
    # Same idea for perceptual hashing: imagehash pulls in scipy.fftpack on its
    # first call, which is a lot of small files off disk. Only imports need it,
    # so it must not sit between launching the app and the window appearing.
    warm_phash_in_background()
    # Same idea for semantic search: a query itself takes milliseconds, but the
    # first one used to wait ~4s for torch and the CLIP weights. Load them on a
    # background thread once any import has settled, and only when the weights
    # are already on disk - warming up must not start a download on a fresh
    # install (see embeddings.start_background_warmup).
    start_background_clip_warmup()
    # A hard stop of a previous backend (dev restart, crash) leaves its
    # exiftool -stay_open helpers orphaned forever - sweep them so they
    # can't pile up across restarts (78 accumulated on a dev machine).
    reap_orphaned_helpers()
    # If the library sits in a cloud-synced folder (iCloud/Nextcloud), the
    # provider may have evicted thumbnails or staged files to placeholders;
    # the first read of one blocks until it re-downloads, which shows up as
    # random multi-second hangs in the grid or an import. Re-download them all
    # now on a background thread so foreground reads stay warm.
    rehydrate_dirs_in_background(
        app_settings.thumbnail_cache_root,
        app_settings.import_staging_root,
        app_settings.db_path.parent,
    )
    # Catch up on photos that have no search embedding yet. Imports no longer
    # generate embeddings inline (see workers/queue.py) - a background worker
    # backfills them from the rendered previews whenever the import machinery
    # is idle. Kicking it here also heals photos whose embedding never landed
    # (the pre-backfill queue forgot its backlog on every restart). A no-op
    # beyond one cheap query when nothing is missing.
    schedule_embedding_backfill()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
