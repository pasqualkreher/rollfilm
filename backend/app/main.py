from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    albums,
    images,
    import_,
    maintenance,
    search,
    settings,
    sources,
    tags,
)
from app.config import settings as app_settings
from app.db.session import engine, ensure_indexes
from app.services.cloudfiles import rehydrate_dirs_in_background
from app.services.embeddings import ensure_embeddings_table
from app.services.geocode import warm_in_background as warm_geocoder
from app.services.immich_sync import start_background_immich_sync
from app.services.maintenance import start_background_sync
from app.services.sources import scan_all_sources
from app.services.trash import start_background_purge

app = FastAPI(title="Rollfilm API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(images.router)
app.include_router(albums.router)
app.include_router(import_.router)
app.include_router(search.router)
app.include_router(maintenance.router)
app.include_router(settings.router)
app.include_router(sources.router)
app.include_router(tags.router)


@app.on_event("startup")
def on_startup() -> None:
    # Table schema lives in Alembic migrations; the sqlite-vec virtual table
    # is bootstrapped here since it isn't a normal SQLAlchemy-managed table.
    ensure_embeddings_table(engine)
    # Hot-path indexes for the library grid (idempotent, see ensure_indexes).
    ensure_indexes()
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
    # Parse the reverse-geocoding dataset now instead of inside the first
    # import commit (the desktop app restarts the backend on every launch, so
    # that first-commit stall was paid every session).
    warm_geocoder()
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


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
