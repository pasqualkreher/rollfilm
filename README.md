# Rollfilm

A self-hosted, privacy-first photo library manager with semantic search, map & timeline browsing, RAW support — and first-class [Immich](https://immich.app) integration.

Your photos stay on your own machine (or NAS). The app imports them into a managed library, makes them searchable with natural language, and can optionally mirror your library to an existing Immich server.

> **Project status: work in progress.**
> This is an early but already very usable release that I wanted to share. The core — import pipeline, library organization, semantic search, and especially the Immich integration — works well. The built-in photo editor is experimental and should be seen as a fun extra rather than a finished feature (see [Photo editor](#photo-editor-experimental)).

## Features

### Library & import
- **Staged import wizard** — uploads are staged asynchronously, nothing blocks while you keep selecting photos
- **RAW support** (via rawpy) with automatic RAW+JPEG pairing
- **EXIF extraction** (ExifTool) and reverse geocoding of GPS coordinates to country/place
- **Near-duplicate detection** during import using perceptual hashes
- Albums, tags (with bulk tagging), star ratings, color labels, and a selects/picks workflow
- **Trash** with configurable retention and automatic background purge

### Search & browsing
- **Semantic search** — describe what you're looking for in natural language ("sunset at the beach", "dog in the snow"). Powered by CLIP embeddings stored in SQLite via `sqlite-vec`, fully local, no cloud API
- Image-to-image similarity search
- **Map view** (Leaflet) of all geotagged photos
- Timeline scrubber, thumbnail grid, lightbox

### Immich integration ⭐
This is one of the highlights of the project: keep your library mirrored to an existing [Immich](https://immich.app) server without giving up local-first management.

- Configure server URL + API key directly in the app (Settings → Immich) — nothing goes into config files
- **Three sync modes:**
  - `manual` — per-import checkbox and on-demand "Add to Immich" buttons
  - `selective` — only photos and albums you flag for sync
  - `full` — every photo and album is mirrored automatically
- **Background reconciliation loop** — runs at startup and every 60 seconds: uploads missing assets, backfills asset IDs (checksum-based, so Immich deduplicates correctly), mirrors app albums to Immich albums, and propagates deletions through a durable pending-deletion queue
- Per-image exponential backoff on failures; event-driven uploads for instant sync after import
- Immich mirrors only your *visible* library — the local library always remains the recoverable source of truth

### External sources
- **Index photo collections in place** (e.g. a NAS) — read-only, without copying anything into the managed library
- Browse any mounted drive directly from the app

### Photo editor (experimental)
A non-destructive editor is included, but consider it a gimmick for now — it's fun to play with, not a Lightroom replacement.

- All rendering happens **server-side**, so the live preview is pixel-identical to the exported result
- Edits are stored as values in the database; originals are never touched
- Exposure/contrast/highlights/shadows, white balance, 8-band HSL color mixer, crop/rotate/perspective, and effects like grain, vignette, clarity, and film-style diffusion

## Tech stack

| Layer | Tech |
| --- | --- |
| Backend | Python 3.11+, FastAPI, SQLAlchemy 2.0, Alembic, SQLite + `sqlite-vec` |
| ML / imaging | OpenCLIP (ViT-B-32), Pillow, rawpy, OpenCV, ImageHash, ExifTool |
| Frontend | React 18, TypeScript, Vite, TanStack Query, Leaflet |
| Desktop | Electron 33 + electron-builder, backend bundled with PyInstaller |

Everything runs locally — the only network access is the initial CLIP model download and your own Immich server (if configured).

## Getting started

Rollfilm is a native desktop app (Electron). Requires Node.js and a Python 3.11+ that supports loading SQLite extensions (on macOS use Homebrew Python, not the system one).

```bash
# Development (Vite dev server + Electron)
cd electron
npm install
npm run dev

# Build installers (dmg / nsis / AppImage)
npm run dist
```

There is also a GitHub Actions workflow ([.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml)) that builds macOS, Windows, and Linux installers, and a one-command local build (`node build-desktop.js`).

### Backend standalone (development)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
python run_server.py   # runs Alembic migrations, then starts the API on localhost
```

## Configuration

The desktop app configures itself (data directory, ports) and stores everything under your user data folder. The Immich server URL and API key are deliberately **not** environment variables: they are entered in the app under Settings → Immich integration and stored in the database. For backend development, `PM_DATA_DIR` overrides where the library/database live.

## Architecture

```
rollfilm/
├── backend/          FastAPI app
│   └── app/
│       ├── api/      REST routes (images, albums, import, search, tags, ...)
│       ├── services/ Domain logic (immich sync, import pipeline, embeddings,
│       │             thumbnails/editor rendering, EXIF, geocoding, trash, ...)
│       ├── workers/  Background queue (embeddings, Immich uploads)
│       └── db/       SQLAlchemy models + Alembic migrations
├── frontend/         React UI (talks to the backend via REST)
└── electron/         Desktop shell (spawns the bundled backend as a child process)
```

Notable design decisions:
- **Single local user, no auth** — this is a personal, self-hosted tool. Don't expose it to the public internet as-is (CORS is wide open for localhost use).
- External sources are mounted **read-only** — the app can never modify your originals.
- Database migrations run automatically on startup, with retry logic for external drives.
- Handles cloud-synced folders (iCloud/Nextcloud placeholder files) and exFAT/NTFS drives.

## Known limitations / roadmap

- The photo editor is experimental (see above)
- No test suite yet (pytest is set up, tests are WIP)
- Single-user only — no accounts or sharing
- No screenshots in this README yet 🙂

Issues and pull requests are welcome, but please keep in mind this is a hobby project — response times may vary.

## License

[MIT](LICENSE) — © Pasqual Kreher. You're free to use, modify, and redistribute this software; the copyright notice must be preserved.
