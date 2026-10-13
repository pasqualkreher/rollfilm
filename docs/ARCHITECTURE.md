# Architecture

Rollfilm is three programs on one machine: an Electron shell, a React renderer
and a Python backend (FastAPI on uvicorn) that owns the catalog database and all
image work. Everything talks over `http://127.0.0.1:<port>`; nothing listens on
another interface. This page is a map for finding things, not a spec. When it
and the code disagree, the code is right, and this page should be fixed.

## Processes and startup order

1. **`electron/main.js`, `app.whenReady()`.** Applies the saved theme, builds
   the menu, shows the splash and picks a free port (`getFreePort`). It
   registers the `rf:` protocol (`serveDerivative`), which serves rendered
   thumbnails straight off disk, and installs the API token header. A first
   run opens the window right away so the onboarding can ask for a library
   folder. Otherwise the shell checks that the saved library is reachable
   (`ensureLibraryRoot`), moves the database to where it belongs
   (`ensureDatabaseLocation`), and starts the backend (`startBackendAndWait`).
   The window opens only once `/health` answers.
2. **Spawning the backend** (`resolveBackendCommand`, `startBackend`). The
   environment carries `PM_PORT`, `PM_DATA_DIR` (Electron's userData folder),
   and `LIBRARY_ROOT`, `DB_PATH`, `THUMBNAIL_CACHE_ROOT` and
   `IMPORT_STAGING_ROOT`, all inside the library folder. With
   `PM_API_TOKEN_STDIN=1` set, a per-launch random token is written to the
   child's stdin. That token is the only way in (`app/security.py`). A
   backend started without it locks itself, and `PM_API_OPEN=1` opens it only
   from the source tree.
3. **`backend/run_server.py`, `main()`**, in this order:
   cap the native thread pools; trust certifi's CA bundle; raise the
   open-files limit; download a database file the cloud provider evicted
   (`rehydrate_database`); swap in a snapshot the user marked for restore
   (`apply_pending_restore`); take a snapshot if a migration is due
   (`snapshot_before_migration`); run `alembic upgrade head`, retrying
   transient "readonly/locked" errors from external drives; set up logging;
   read the token; then `uvicorn.run(app.main:app)`.
4. **`backend/app/main.py`, `lifespan` → `on_startup()`.** Creates the
   sqlite-vec table (`ensure_embeddings_table`) and the grid indexes
   (`db/session.py`, `ensure_indexes`); restores the RAW decode mode;
   recomputes the album and canvas membership tags. Then it starts background
   work: source-folder scans, the library sync, the daily DB snapshot, the
   Trash purge, the Immich sync loop, the geocoder, pHash and CLIP warm-ups
   (no CLIP warm-up on low-RAM machines), the orphaned-exiftool sweep, cloud
   rehydration, the embedding backfill and the idle reaper.
   **`on_shutdown()`** closes the exiftool / lens / white-balance helpers. It
   is the only cleanup that runs on SIGTERM.

The schema exists only as Alembic history (`app/db/migrations/versions/`).
`tests/test_migrations.py` checks that the history and `app/db/models.py`
agree.

## Data layout

| What | Where | Set by |
| --- | --- | --- |
| Photos (managed imports) | `<library>/…`, date folders like `YYYY/YYYY-MM-DD/` | `LIBRARY_ROOT` |
| Catalog database | `<library>/.photomanager/db/library.db` (on a network share: `<userData>/network-libraries/<key>/db/library.db`) | `DB_PATH`, `dbPathFor` in main.js |
| DB snapshots | `snapshots/` next to `library.db`; restore marker `library.db.restore` | `services/db_snapshots.py` |
| Rendered derivatives | `<library>/.photomanager/thumbnails/<image_id>/` | `THUMBNAIL_CACHE_ROOT` |
| Import staging | `<library>/.photomanager/staging/` | `IMPORT_STAGING_ROOT` |
| Staged-file previews | system temp `rollfilm-staged-thumbs/` (internal disk on purpose) | `config.py` |
| ML weights (CLIP, SegFormer) | `<userData>/models/` | `PM_DATA_DIR` |
| Logs | `<userData>/logs/backend.log` | main.js |

Snapshots (`db_snapshots.py`) are taken with `VACUUM INTO`. The app keeps 7
daily, 5 manual and the snapshots of the last 3 migration revisions, within 2
GB in total.

## Render pipeline: tiers and caches

All pixels come from one pipeline in `services/thumbnails.py`, which wires in
`develop*.py`, `film_sims.py`, `masks.py`, `spots.py`, `lens_profile.py` and
`raw.py`. The editor preview is the saved render on a smaller base, not a
second implementation. **Files per photo** in `<thumbnails>/<image_id>/`:

- `thumbnail.jpg`: a quarter of the original, at most 1600 px (`THUMBNAIL_SCALE`).
- `small.jpg`: at most 640 px, made from the finished thumbnail. It is the dense
  XS/S grid tier (`SMALL_MAX_PX`, `ensure_small`).
- `preview.jpg`: at most 2600 px, for the lightbox (`PREVIEW_RENDER_MAX_PX`).
- `half.jpg`, `full.jpg`: zoom tiers, rendered on demand and dropped whenever
  the edit changes (`_write_grid_tiers` → `_unlink_full_cache`).
  Garbage-collected to a budget (4 GB by default, `gc_full_cache`).

Unedited JPEG/PNG files skip the float pipeline entirely
(`generate_untouched_derivatives`). `drop_derivatives` deletes every tier when
a re-render will come later. The grid busts its cache with `images.edit_rev`.

**In memory:** decoded editor bases in `_BASE_CACHE` (bounded by bytes, 320 MB
scaled by `machine.scaled_budget`), the full-resolution native base, and the
last full render, kept once so Save copy and a repeated export only encode.
The editor's preview tiers are *scrub* (during a drag, fast passes), the
accurate frame, *full_quality* and *ultra* (`render_editor_preview_bytes`).
Gigabyte-sized renders are rationed by `RENDER_SLOTS` (`_render_admission`).
`services/idle_reaper.py` releases the caches and models when idle.

## Background work and job registries

- `workers/queue.py`: a thread pool for post-import derivatives and
  re-renders after an edit (`enqueue_post_import`, `enqueue_rerender`,
  `cancel_rerenders`), Immich uploads (`enqueue_immich_upload`) and the CLIP
  embedding backfill, which runs only while imports and the editor are idle.
- `services/copy_jobs.py`: "Save copy of N photos" / "Apply … and save copy"
  jobs. In memory, polled, stoppable between photos, and pruned after 30 min.
- Export jobs: `_export_jobs` in `api/routes/images.py` (`/export/start`,
  `/export/{id}/progress`, `/result`, `DELETE`). Same in-memory, TTL-pruned
  pattern.
- Maintenance runs (`services/maintenance.py`: library sync, thumbnail
  rebuild, date repair) and the library merge (`services/library_merge.py`)
  report progress through their own `…/progress` routes and accept a cancel
  between steps. `/maintenance/background-activity` sums up everything still
  running; the shell's "finish in background" quit polls it (main.js,
  `fetchBackgroundActivity`).

Every registry lives in the one backend process. A restart forgets running
jobs, and that is by design.

## How edits are stored

An edit lives on the `images` row. The geometry has its own columns
(`edit_rotation`, `edit_crop_*`, `edit_flip_*`, `edit_straighten`,
`edit_persp_*`). Everything else is one JSON string in `edit_adjustments`.
`services/develop.py` owns its schema: `normalize()` turns any partial or old
object into the full canonical shape, clamping every value and dropping
unknown keys. It also folds legacy keys in on read (the old `denoise` master,
for example), so old edits, presets and backups migrate without a data
migration. `dumps()` stores `NULL` for a neutral edit. `loads()` never raises.

`process` is the render version of an edit (`ENUM_SPEC["process"]`, "1"
through "7"; `CURRENT_PROCESS`). A new edit starts on the current process; a
stored edit keeps its own, so a photo never changes its look because the app
was updated. Each version's meaning is documented next to `ENUM_SPEC`.
`raw_base` ("standard" / "native" / "legacy") records which exposure a raw
was developed from. Named snapshots of an edit are rows in `edit_snapshots`
(`EditSnapshot`). Bumping `edit_rev` is what makes the grid fetch new
thumbnails.
